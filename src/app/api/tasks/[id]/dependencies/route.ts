import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, Task, db_helpers } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

function mapTaskRow(task: any): Task {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
  }
}

/**
 * Detect if adding task_id depends_on depends_on_id would create a cycle.
 * BFS from depends_on_id: if we can reach task_id, it's a cycle.
 */
function wouldCreateCycle(
  db: ReturnType<typeof getDatabase>,
  taskId: number,
  dependsOnId: number,
  workspaceId: number
): boolean {
  const visited = new Set<number>()
  const queue = [dependsOnId]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === taskId) return true
    if (visited.has(current)) continue
    visited.add(current)
    const deps = db
      .prepare(
        'SELECT depends_on_id FROM task_dependencies WHERE task_id = ? AND workspace_id = ?'
      )
      .all(current, workspaceId) as { depends_on_id: number }[]
    for (const d of deps) queue.push(d.depends_on_id)
  }
  return false
}

/**
 * GET /api/tasks/[id]/dependencies - Get dependencies for a task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const resolvedParams = await params
    const taskId = parseInt(resolvedParams.id)
    const workspaceId = auth.user.workspace_id ?? 1

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    // Tasks this task depends on (blocked by)
    const blockedBy = db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN task_dependencies td ON td.depends_on_id = t.id
         WHERE td.task_id = ? AND td.dependency_type = 'blocks' AND td.workspace_id = ?`
      )
      .all(taskId, workspaceId)
      .map(mapTaskRow)

    // Tasks that depend on this task (blocks)
    const blocks = db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN task_dependencies td ON td.task_id = t.id
         WHERE td.depends_on_id = ? AND td.dependency_type = 'blocks' AND td.workspace_id = ?`
      )
      .all(taskId, workspaceId)
      .map(mapTaskRow)

    // Related tasks (non-blocking)
    const related = db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN task_dependencies td ON (
           (td.task_id = ? AND td.depends_on_id = t.id)
           OR (td.depends_on_id = ? AND td.task_id = t.id)
         )
         WHERE td.dependency_type = 'relates_to' AND td.workspace_id = ?`
      )
      .all(taskId, taskId, workspaceId)
      .map(mapTaskRow)

    return NextResponse.json({ blocked_by: blockedBy, blocks, related })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/[id]/dependencies error')
    return NextResponse.json(
      { error: 'Failed to fetch dependencies' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/tasks/[id]/dependencies - Add a dependency
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const resolvedParams = await params
    const taskId = parseInt(resolvedParams.id)
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { depends_on_id, dependency_type = 'blocks' } = body

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    if (
      typeof depends_on_id !== 'number' ||
      !Number.isFinite(depends_on_id) ||
      depends_on_id <= 0
    ) {
      return NextResponse.json(
        { error: 'depends_on_id must be a positive integer' },
        { status: 400 }
      )
    }

    if (!['blocks', 'relates_to'].includes(dependency_type)) {
      return NextResponse.json(
        { error: 'dependency_type must be "blocks" or "relates_to"' },
        { status: 400 }
      )
    }

    if (taskId === depends_on_id) {
      return NextResponse.json(
        { error: 'A task cannot depend on itself' },
        { status: 400 }
      )
    }

    // Verify both tasks exist
    const task = db
      .prepare('SELECT id, title FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(taskId, workspaceId) as { id: number; title: string } | undefined
    const depTask = db
      .prepare('SELECT id, title FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(depends_on_id, workspaceId) as
      | { id: number; title: string }
      | undefined

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    if (!depTask) {
      return NextResponse.json(
        { error: 'Dependency task not found' },
        { status: 404 }
      )
    }

    // Cycle detection for blocking dependencies
    if (
      dependency_type === 'blocks' &&
      wouldCreateCycle(db, taskId, depends_on_id, workspaceId)
    ) {
      return NextResponse.json(
        { error: 'Would create a circular dependency' },
        { status: 409 }
      )
    }

    // Insert dependency
    try {
      db.prepare(
        `INSERT INTO task_dependencies (task_id, depends_on_id, dependency_type, workspace_id)
         VALUES (?, ?, ?, ?)`
      ).run(taskId, depends_on_id, dependency_type, workspaceId)
    } catch (err: any) {
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return NextResponse.json(
          { error: 'Dependency already exists' },
          { status: 409 }
        )
      }
      throw err
    }

    db_helpers.logActivity(
      'task_updated',
      'task',
      taskId,
      auth.user.username,
      `Added dependency: "${task.title}" ${dependency_type === 'blocks' ? 'blocked by' : 'related to'} "${depTask.title}"`,
      { depends_on_id, dependency_type },
      workspaceId
    )

    eventBus.broadcast('task.dependency_changed', {
      task_id: taskId,
      depends_on_id,
      action: 'added',
      dependency_type,
    })

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/[id]/dependencies error')
    return NextResponse.json(
      { error: 'Failed to add dependency' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/tasks/[id]/dependencies - Remove a dependency
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const resolvedParams = await params
    const taskId = parseInt(resolvedParams.id)
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { depends_on_id } = body

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    if (
      typeof depends_on_id !== 'number' ||
      !Number.isFinite(depends_on_id) ||
      depends_on_id <= 0
    ) {
      return NextResponse.json(
        { error: 'depends_on_id must be a positive integer' },
        { status: 400 }
      )
    }

    const result = db
      .prepare(
        `DELETE FROM task_dependencies
         WHERE task_id = ? AND depends_on_id = ? AND workspace_id = ?`
      )
      .run(taskId, depends_on_id, workspaceId)

    if (result.changes === 0) {
      return NextResponse.json(
        { error: 'Dependency not found' },
        { status: 404 }
      )
    }

    db_helpers.logActivity(
      'task_updated',
      'task',
      taskId,
      auth.user.username,
      `Removed dependency on task #${depends_on_id}`,
      { depends_on_id, action: 'removed' },
      workspaceId
    )

    eventBus.broadcast('task.dependency_changed', {
      task_id: taskId,
      depends_on_id,
      action: 'removed',
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/tasks/[id]/dependencies error')
    return NextResponse.json(
      { error: 'Failed to remove dependency' },
      { status: 500 }
    )
  }
}
