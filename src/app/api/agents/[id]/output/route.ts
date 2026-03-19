import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { eventBus, ServerEvent } from '@/lib/event-bus'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface OutputRow {
  id: number
  stream: string
  content: string
  created_at: number
}

/**
 * GET /api/agents/[id]/output - SSE stream for live agent output
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await params
  const workspaceId = auth.user.workspace_id ?? 1
  const url = new URL(request.url)
  const since = url.searchParams.get('since')
  const streamFilter = url.searchParams.get('stream') || 'all'

  // Look up agent to get session_key
  const db = getDatabase()
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

  const encoder = new TextEncoder()
  let cleanup: (() => void) | null = null

  const stream = new ReadableStream({
    start(controller) {
      // Replay last 200 lines
      try {
        let replayQuery = `SELECT id, stream, content, created_at FROM agent_output_logs WHERE workspace_id = ?`
        const queryParams: any[] = [workspaceId]

        if (sessionKey) {
          replayQuery += ` AND (session_key = ? OR agent_name = ?)`
          queryParams.push(sessionKey, agentName)
        } else {
          replayQuery += ` AND agent_name = ?`
          queryParams.push(agentName)
        }

        if (streamFilter !== 'all') {
          replayQuery += ` AND stream = ?`
          queryParams.push(streamFilter)
        }

        if (since) {
          replayQuery += ` AND created_at > ?`
          queryParams.push(Number(since))
        }

        replayQuery += ` ORDER BY created_at DESC, id DESC LIMIT 200`

        const rows = db.prepare(replayQuery).all(...queryParams) as OutputRow[]
        // Send in chronological order
        for (const row of rows.reverse()) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ id: row.id, stream: row.stream, content: row.content, created_at: row.created_at })}\n\n`)
          )
        }
      } catch (err) {
        logger.error({ err }, 'Failed to replay agent output logs')
      }

      // Subscribe to live events
      const handler = (event: ServerEvent) => {
        if (event.type !== 'agent.output') return
        if (event.data?.workspace_id && event.data.workspace_id !== workspaceId) return

        // Match by agent_name or session_key
        const matchesAgent = event.data?.agent_name === agentName
        const matchesSession = sessionKey && event.data?.session_key === sessionKey
        if (!matchesAgent && !matchesSession) return

        // Apply stream filter
        if (streamFilter !== 'all' && event.data?.stream !== streamFilter) return

        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ id: event.data.id, stream: event.data.stream, content: event.data.content, created_at: event.data.created_at })}\n\n`)
          )
        } catch {
          // Client disconnected
        }
      }

      eventBus.on('server-event', handler)

      // Heartbeat every 15s
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, 15_000)

      cleanup = () => {
        eventBus.off('server-event', handler)
        clearInterval(heartbeat)
      }
    },

    cancel() {
      if (cleanup) {
        cleanup()
        cleanup = null
      }
    },
  })

  // Defense-in-depth: clean up on abort
  request.signal.addEventListener('abort', () => {
    if (cleanup) {
      cleanup()
      cleanup = null
    }
  }, { once: true })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

/**
 * POST /api/agents/[id]/output - Ingest agent output
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { id } = await params
    const body = await request.json()
    const { session_key, content, stream: streamName, agent_name } = body

    if (!session_key || typeof session_key !== 'string') {
      return NextResponse.json({ error: 'session_key is required' }, { status: 400 })
    }
    if (!content || typeof content !== 'string') {
      return NextResponse.json({ error: 'content is required' }, { status: 400 })
    }

    const workspaceId = auth.user.workspace_id ?? 1
    const resolvedStream = streamName === 'stderr' ? 'stderr' : 'stdout'

    // Resolve agent_name: use body value, or look up by id
    let resolvedAgentName = agent_name
    if (!resolvedAgentName) {
      const db = getDatabase()
      let agent: any
      if (isNaN(Number(id))) {
        agent = db.prepare('SELECT name FROM agents WHERE name = ? AND workspace_id = ?').get(id, workspaceId)
      } else {
        agent = db.prepare('SELECT name FROM agents WHERE id = ? AND workspace_id = ?').get(Number(id), workspaceId)
      }
      resolvedAgentName = agent?.name || id
    }

    const db = getDatabase()
    const result = db.prepare(
      `INSERT INTO agent_output_logs (session_key, agent_name, stream, content, workspace_id) VALUES (?, ?, ?, ?, ?)`
    ).run(session_key, resolvedAgentName, resolvedStream, content, workspaceId)

    const insertedId = result.lastInsertRowid
    const now = Math.floor(Date.now() / 1000)

    eventBus.broadcast('agent.output', {
      id: insertedId,
      session_key,
      agent_name: resolvedAgentName,
      stream: resolvedStream,
      content,
      workspace_id: workspaceId,
      created_at: now,
    })

    return NextResponse.json({ id: insertedId }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/[id]/output error')
    return NextResponse.json({ error: 'Failed to ingest output' }, { status: 500 })
  }
}
