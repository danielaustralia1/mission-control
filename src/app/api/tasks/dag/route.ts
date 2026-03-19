import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

interface TaskNode {
  id: number
  title: string
  status: string
  priority: string
  assigned_to: string | null
  is_blocked: boolean
  blocked_by_count: number
  blocks_count: number
  ticket_ref?: string
}

interface DependencyEdge {
  from: number // depends_on_id (blocker)
  to: number // task_id (blocked)
  type: string
}

/**
 * GET /api/tasks/dag - Get full task dependency graph
 * Query params: project_id, status (comma-separated to exclude)
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const { searchParams } = new URL(request.url)
    const projectIdParam = Number.parseInt(
      searchParams.get('project_id') || '',
      10
    )

    // Get all tasks that have dependencies (either as source or target)
    let taskFilter = 'WHERE t.workspace_id = ?'
    const taskParams: any[] = [workspaceId]

    if (Number.isFinite(projectIdParam)) {
      taskFilter += ' AND t.project_id = ?'
      taskParams.push(projectIdParam)
    }

    // Get tasks involved in dependencies
    const tasksWithDeps = db
      .prepare(
        `SELECT DISTINCT t.id, t.title, t.status, t.priority, t.assigned_to,
                p.ticket_prefix as project_prefix, t.project_ticket_no
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
         ${taskFilter}
         AND (
           t.id IN (SELECT task_id FROM task_dependencies WHERE workspace_id = ?)
           OR t.id IN (SELECT depends_on_id FROM task_dependencies WHERE workspace_id = ?)
         )`
      )
      .all(...taskParams, workspaceId, workspaceId) as any[]

    // Get all dependency edges
    let edgeFilter = 'WHERE td.workspace_id = ?'
    const edgeParams: any[] = [workspaceId]

    if (Number.isFinite(projectIdParam)) {
      edgeFilter += ` AND td.task_id IN (SELECT id FROM tasks WHERE project_id = ? AND workspace_id = ?)
                      AND td.depends_on_id IN (SELECT id FROM tasks WHERE project_id = ? AND workspace_id = ?)`
      edgeParams.push(
        projectIdParam,
        workspaceId,
        projectIdParam,
        workspaceId
      )
    }

    const edges = db
      .prepare(
        `SELECT td.task_id, td.depends_on_id, td.dependency_type
         FROM task_dependencies td
         ${edgeFilter}`
      )
      .all(...edgeParams) as {
      task_id: number
      depends_on_id: number
      dependency_type: string
    }[]

    // Compute blocked status per task
    const blockingEdges = edges.filter((e) => e.dependency_type === 'blocks')
    const taskStatusMap = new Map(
      tasksWithDeps.map((t) => [t.id, t.status])
    )

    const blockedByCount = new Map<number, number>()
    const blocksCount = new Map<number, number>()
    const isBlocked = new Map<number, boolean>()

    for (const edge of blockingEdges) {
      blockedByCount.set(
        edge.task_id,
        (blockedByCount.get(edge.task_id) || 0) + 1
      )
      blocksCount.set(
        edge.depends_on_id,
        (blocksCount.get(edge.depends_on_id) || 0) + 1
      )

      const depStatus = taskStatusMap.get(edge.depends_on_id)
      if (depStatus && depStatus !== 'done') {
        isBlocked.set(edge.task_id, true)
      }
    }

    function formatTicketRef(
      prefix?: string | null,
      num?: number | null
    ): string | undefined {
      if (
        !prefix ||
        typeof num !== 'number' ||
        !Number.isFinite(num) ||
        num <= 0
      )
        return undefined
      return `${prefix}-${String(num).padStart(3, '0')}`
    }

    const nodes: TaskNode[] = tasksWithDeps.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assigned_to: t.assigned_to,
      is_blocked: isBlocked.get(t.id) || false,
      blocked_by_count: blockedByCount.get(t.id) || 0,
      blocks_count: blocksCount.get(t.id) || 0,
      ticket_ref: formatTicketRef(t.project_prefix, t.project_ticket_no),
    }))

    const dependencyEdges: DependencyEdge[] = edges.map((e) => ({
      from: e.depends_on_id,
      to: e.task_id,
      type: e.dependency_type,
    }))

    return NextResponse.json({ nodes, edges: dependencyEdges })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/dag error')
    return NextResponse.json(
      { error: 'Failed to fetch task DAG' },
      { status: 500 }
    )
  }
}
