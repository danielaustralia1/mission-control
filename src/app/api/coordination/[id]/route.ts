import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * PATCH /api/coordination/[id] - Update an interaction status
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const resolvedParams = await params
    const interactionId = parseInt(resolvedParams.id)

    if (isNaN(interactionId)) {
      return NextResponse.json({ error: 'Invalid interaction ID' }, { status: 400 })
    }

    const body = await request.json()
    const { status } = body

    if (!status || !['completed', 'cancelled'].includes(status)) {
      return NextResponse.json(
        { error: 'status must be "completed" or "cancelled"' },
        { status: 400 }
      )
    }

    const existing = db.prepare(
      `SELECT * FROM agent_interactions WHERE id = ? AND workspace_id = ?`
    ).get(interactionId, workspaceId) as Record<string, unknown> | undefined

    if (!existing) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 })
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      UPDATE agent_interactions
      SET status = ?, completed_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(status, now, interactionId, workspaceId)

    const updated = db.prepare(
      `SELECT * FROM agent_interactions WHERE id = ?`
    ).get(interactionId) as Record<string, unknown>

    eventBus.broadcast('coordination.interaction_updated', updated)

    return NextResponse.json({ interaction: updated })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/coordination/[id] error')
    return NextResponse.json({ error: 'Failed to update interaction' }, { status: 500 })
  }
}
