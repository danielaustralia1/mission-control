import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

interface OutputRow {
  id: number
  session_key: string
  agent_name: string | null
  stream: string
  content: string
  created_at: number
}

/**
 * GET /api/agents/[id]/output/history - Paginated historical output
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1
    const url = new URL(request.url)

    const limitParam = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 1), 2000)
    const before = url.searchParams.get('before')
    const streamFilter = url.searchParams.get('stream') || 'all'

    const db = getDatabase()

    // Resolve agent
    let agent: any
    if (isNaN(Number(id))) {
      agent = db.prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?').get(id, workspaceId)
    } else {
      agent = db.prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?').get(Number(id), workspaceId)
    }

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const agentName = agent.name
    const sessionKey = agent.session_key

    let query = `SELECT id, stream, content, created_at FROM agent_output_logs WHERE workspace_id = ?`
    const queryParams: any[] = [workspaceId]

    if (sessionKey) {
      query += ` AND (session_key = ? OR agent_name = ?)`
      queryParams.push(sessionKey, agentName)
    } else {
      query += ` AND agent_name = ?`
      queryParams.push(agentName)
    }

    if (streamFilter !== 'all') {
      query += ` AND stream = ?`
      queryParams.push(streamFilter)
    }

    if (before) {
      query += ` AND created_at < ?`
      queryParams.push(Number(before))
    }

    // Fetch one extra to determine hasMore
    query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
    queryParams.push(limitParam + 1)

    const rows = db.prepare(query).all(...queryParams) as OutputRow[]
    const hasMore = rows.length > limitParam
    const lines = (hasMore ? rows.slice(0, limitParam) : rows).reverse()

    return NextResponse.json({
      lines: lines.map(r => ({ id: r.id, stream: r.stream, content: r.content, created_at: r.created_at })),
      hasMore,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/output/history error')
    return NextResponse.json({ error: 'Failed to fetch output history' }, { status: 500 })
  }
}
