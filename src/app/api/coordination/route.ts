import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

const VALID_INTERACTION_TYPES = ['handoff', 'delegation', 'message', 'shared_context', 'review_request'] as const

const TIMEFRAME_SECONDS: Record<string, number> = {
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
}

interface AgentNode {
  id: string
  name: string
  status: string
  interaction_count: number
}

interface InteractionEdge {
  from: string
  to: string
  type: string
  count: number
  last_at: number
}

/**
 * GET /api/coordination - Get coordination graph data
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const { searchParams } = new URL(request.url)
    const timeframe = searchParams.get('timeframe') || '24h'
    const agentFilter = searchParams.get('agent') || ''

    const seconds = TIMEFRAME_SECONDS[timeframe] || TIMEFRAME_SECONDS['24h']
    const cutoff = Math.floor(Date.now() / 1000) - seconds

    const nodeMap = new Map<string, AgentNode>()
    const edgeMap = new Map<string, InteractionEdge>()

    function ensureNode(name: string) {
      if (!name) return
      if (!nodeMap.has(name)) {
        nodeMap.set(name, { id: name, name, status: 'active', interaction_count: 0 })
      }
    }

    function addEdge(from: string, to: string, type: string, createdAt: number) {
      if (!from || !to) return
      const key = `${from}::${to}::${type}`
      const existing = edgeMap.get(key)
      if (existing) {
        existing.count++
        existing.last_at = Math.max(existing.last_at, createdAt)
      } else {
        edgeMap.set(key, { from, to, type, count: 1, last_at: createdAt })
      }
      ensureNode(from)
      ensureNode(to)
      const fromNode = nodeMap.get(from)
      const toNode = nodeMap.get(to)
      if (fromNode) fromNode.interaction_count++
      if (toNode) toNode.interaction_count++
    }

    // Source 1: agent_interactions table
    let interactionQuery = `
      SELECT from_agent, to_agent, interaction_type, created_at
      FROM agent_interactions
      WHERE workspace_id = ? AND created_at >= ?
    `
    const interactionParams: (string | number)[] = [workspaceId, cutoff]
    if (agentFilter) {
      interactionQuery += ` AND (from_agent = ? OR to_agent = ?)`
      interactionParams.push(agentFilter, agentFilter)
    }

    const interactions = db.prepare(interactionQuery).all(...interactionParams) as Array<{
      from_agent: string
      to_agent: string
      interaction_type: string
      created_at: number
    }>

    for (const row of interactions) {
      addEdge(row.from_agent, row.to_agent, row.interaction_type, row.created_at)
    }

    // Source 2: activities table - implicit handoffs from assigned_to changes
    let activityQuery = `
      SELECT data, created_at
      FROM activities
      WHERE workspace_id = ? AND type = 'task_updated' AND created_at >= ?
        AND data LIKE '%assigned%'
    `
    const activityParams: (string | number)[] = [workspaceId, cutoff]

    const activities = db.prepare(activityQuery).all(...activityParams) as Array<{
      data: string | null
      created_at: number
    }>

    for (const row of activities) {
      if (!row.data) continue
      try {
        const parsed = JSON.parse(row.data)
        const oldAssigned = parsed.oldValues?.assigned_to
        const newAssigned = parsed.newValues?.assigned_to
        if (oldAssigned && newAssigned && oldAssigned !== newAssigned) {
          if (agentFilter && agentFilter !== oldAssigned && agentFilter !== newAssigned) continue
          addEdge(oldAssigned, newAssigned, 'implicit_handoff', row.created_at)
        }
      } catch {
        // skip malformed data
      }
    }

    // Source 3: Agent-to-agent chat messages
    let messageQuery = `
      SELECT from_agent, to_agent, created_at
      FROM messages
      WHERE workspace_id = ? AND created_at >= ?
        AND from_agent IS NOT NULL AND to_agent IS NOT NULL
        AND from_agent != '' AND to_agent != ''
    `
    const messageParams: (string | number)[] = [workspaceId, cutoff]
    if (agentFilter) {
      messageQuery += ` AND (from_agent = ? OR to_agent = ?)`
      messageParams.push(agentFilter, agentFilter)
    }

    try {
      const messages = db.prepare(messageQuery).all(...messageParams) as Array<{
        from_agent: string
        to_agent: string
        created_at: number
      }>
      for (const row of messages) {
        addEdge(row.from_agent, row.to_agent, 'message', row.created_at)
      }
    } catch {
      // messages table may not have workspace_id or expected columns - skip gracefully
    }

    // Enrich node status from agents table
    try {
      const agents = db.prepare(
        `SELECT name, status FROM agents WHERE workspace_id = ?`
      ).all(workspaceId) as Array<{ name: string; status: string }>
      for (const agent of agents) {
        const node = nodeMap.get(agent.name)
        if (node) node.status = agent.status || 'active'
      }
    } catch {
      // agents table might not have expected columns
    }

    const nodes = Array.from(nodeMap.values())
    const edges = Array.from(edgeMap.values())

    // Compute stats
    const activeCollaborations = edges.filter(e => e.type !== 'implicit_handoff').length
    const handoffsToday = edges
      .filter(e => e.type === 'handoff' || e.type === 'implicit_handoff')
      .reduce((sum, e) => sum + e.count, 0)

    let mostConnected = ''
    let maxCount = 0
    for (const node of nodes) {
      if (node.interaction_count > maxCount) {
        maxCount = node.interaction_count
        mostConnected = node.name
      }
    }

    return NextResponse.json({
      nodes,
      edges,
      stats: {
        active_collaborations: activeCollaborations,
        handoffs_today: handoffsToday,
        most_connected: mostConnected,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/coordination error')
    return NextResponse.json({ error: 'Failed to fetch coordination data' }, { status: 500 })
  }
}

/**
 * POST /api/coordination - Create an interaction
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { from_agent, to_agent, interaction_type, task_id, context } = body

    if (!from_agent || !to_agent || !interaction_type) {
      return NextResponse.json(
        { error: 'from_agent, to_agent, and interaction_type are required' },
        { status: 400 }
      )
    }

    if (!VALID_INTERACTION_TYPES.includes(interaction_type)) {
      return NextResponse.json(
        { error: `interaction_type must be one of: ${VALID_INTERACTION_TYPES.join(', ')}` },
        { status: 400 }
      )
    }

    const result = db.prepare(`
      INSERT INTO agent_interactions (from_agent, to_agent, interaction_type, task_id, context, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      from_agent,
      to_agent,
      interaction_type,
      task_id || null,
      context ? (typeof context === 'string' ? context : JSON.stringify(context)) : null,
      workspaceId
    )

    const interaction = db.prepare(
      `SELECT * FROM agent_interactions WHERE id = ?`
    ).get(result.lastInsertRowid) as Record<string, unknown>

    eventBus.broadcast('coordination.interaction_created', interaction)

    db_helpers.logActivity(
      'coordination_interaction',
      'agent_interaction',
      Number(result.lastInsertRowid),
      auth.user.username,
      `${from_agent} → ${to_agent}: ${interaction_type}`,
      { from_agent, to_agent, interaction_type, task_id },
      workspaceId
    )

    return NextResponse.json({ interaction }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/coordination error')
    return NextResponse.json({ error: 'Failed to create interaction' }, { status: 500 })
  }
}
