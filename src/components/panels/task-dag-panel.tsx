'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useSmartPoll } from '@/lib/use-smart-poll'
import dagre from '@dagrejs/dagre'

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
  from: number
  to: number
  type: string
}

interface DagData {
  nodes: TaskNode[]
  edges: DependencyEdge[]
}

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  inbox: { bg: '#374151', border: '#6B7280', text: '#D1D5DB' },
  assigned: { bg: '#1E3A5F', border: '#3B82F6', text: '#93C5FD' },
  awaiting_owner: { bg: '#4A2C0A', border: '#F97316', text: '#FDBA74' },
  in_progress: { bg: '#3B3A0A', border: '#EAB308', text: '#FDE047' },
  review: { bg: '#2E1065', border: '#8B5CF6', text: '#C4B5FD' },
  quality_review: { bg: '#1E1B4B', border: '#6366F1', text: '#A5B4FC' },
  done: { bg: '#052E16', border: '#22C55E', text: '#86EFAC' },
}

const NODE_WIDTH = 200
const NODE_HEIGHT = 60
const PADDING = 40

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

function DagSvg({
  data,
  onNodeClick,
}: {
  data: DagData
  onNodeClick: (id: number) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [viewBox, setViewBox] = useState('0 0 800 600')
  const [isPanning, setIsPanning] = useState(false)
  const panStart = useRef({ x: 0, y: 0, vbX: 0, vbY: 0 })
  const currentVB = useRef({ x: 0, y: 0, w: 800, h: 600 })

  const layout = useMemo(() => {
    if (data.nodes.length === 0) return { nodes: [], edges: [] }

    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60 })
    g.setDefaultEdgeLabel(() => ({}))

    for (const node of data.nodes) {
      g.setNode(String(node.id), { width: NODE_WIDTH, height: NODE_HEIGHT })
    }
    for (const edge of data.edges) {
      g.setEdge(String(edge.from), String(edge.to))
    }

    dagre.layout(g)

    const laidOutNodes = data.nodes.map((n) => {
      const gNode = g.node(String(n.id))
      return { ...n, x: gNode.x - NODE_WIDTH / 2, y: gNode.y - NODE_HEIGHT / 2 }
    })

    const laidOutEdges = data.edges.map((e) => {
      const gEdge = g.edge(String(e.from), String(e.to))
      return { ...e, points: gEdge.points }
    })

    // Compute viewBox
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const n of laidOutNodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + NODE_WIDTH)
      maxY = Math.max(maxY, n.y + NODE_HEIGHT)
    }

    const vb = {
      x: minX - PADDING,
      y: minY - PADDING,
      w: maxX - minX + PADDING * 2,
      h: maxY - minY + PADDING * 2,
    }

    return { nodes: laidOutNodes, edges: laidOutEdges, viewBox: vb }
  }, [data])

  useEffect(() => {
    if (layout.viewBox) {
      const { x, y, w, h } = layout.viewBox
      setViewBox(`${x} ${y} ${w} ${h}`)
      currentVB.current = { x, y, w, h }
    }
  }, [layout])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 1.1 : 0.9
    const vb = currentVB.current
    const cx = vb.x + vb.w / 2
    const cy = vb.y + vb.h / 2
    const nw = vb.w * factor
    const nh = vb.h * factor
    const newVb = { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh }
    currentVB.current = newVb
    setViewBox(`${newVb.x} ${newVb.y} ${newVb.w} ${newVb.h}`)
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setIsPanning(true)
    panStart.current = {
      x: e.clientX,
      y: e.clientY,
      vbX: currentVB.current.x,
      vbY: currentVB.current.y,
    }
  }, [])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning || !svgRef.current) return
      const svg = svgRef.current
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const scale = currentVB.current.w / svg.clientWidth
      const dx = (e.clientX - panStart.current.x) * scale
      const dy = (e.clientY - panStart.current.y) * scale
      const newVb = {
        ...currentVB.current,
        x: panStart.current.vbX - dx,
        y: panStart.current.vbY - dy,
      }
      currentVB.current = newVb
      setViewBox(`${newVb.x} ${newVb.y} ${newVb.w} ${newVb.h}`)
    },
    [isPanning]
  )

  const handleMouseUp = useCallback(() => setIsPanning(false), [])

  if (layout.nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        No tasks with dependencies found
      </div>
    )
  }

  return (
    <svg
      ref={svgRef}
      viewBox={viewBox}
      className="flex-1 w-full bg-gray-950 rounded-lg"
      style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <defs>
        <marker
          id="arrowhead"
          markerWidth="10"
          markerHeight="7"
          refX="10"
          refY="3.5"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill="#6B7280" />
        </marker>
        <marker
          id="arrowhead-related"
          markerWidth="10"
          markerHeight="7"
          refX="10"
          refY="3.5"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill="#4B5563" />
        </marker>
      </defs>

      {/* Edges */}
      {layout.edges.map((edge, i) => {
        const pts = edge.points
        if (!pts || pts.length < 2) return null
        const d = pts
          .map((p: { x: number; y: number }, j: number) =>
            j === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`
          )
          .join(' ')
        const isRelated = edge.type === 'relates_to'
        return (
          <path
            key={`edge-${i}`}
            d={d}
            fill="none"
            stroke={isRelated ? '#4B5563' : '#6B7280'}
            strokeWidth={isRelated ? 1 : 1.5}
            strokeDasharray={isRelated ? '4 4' : undefined}
            markerEnd={`url(#arrowhead${isRelated ? '-related' : ''})`}
          />
        )
      })}

      {/* Nodes */}
      {layout.nodes.map((node) => {
        const colors = STATUS_COLORS[node.status] || STATUS_COLORS.inbox
        return (
          <g
            key={node.id}
            onClick={(e) => {
              e.stopPropagation()
              onNodeClick(node.id)
            }}
            style={{ cursor: 'pointer' }}
          >
            <rect
              x={node.x}
              y={node.y}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={6}
              fill={colors.bg}
              stroke={node.is_blocked ? '#EF4444' : colors.border}
              strokeWidth={node.is_blocked ? 2 : 1.5}
              strokeDasharray={node.is_blocked ? '6 3' : undefined}
            />
            {/* Title */}
            <text
              x={node.x + 10}
              y={node.y + 22}
              fill={colors.text}
              fontSize={12}
              fontFamily="monospace"
            >
              {truncate(node.ticket_ref ? `${node.ticket_ref} ` : '', 12)}
              {truncate(node.title, node.ticket_ref ? 18 : 26)}
            </text>
            {/* Status badge */}
            <text
              x={node.x + 10}
              y={node.y + 42}
              fill="#9CA3AF"
              fontSize={10}
              fontFamily="monospace"
            >
              {node.status.replace(/_/g, ' ')}
              {node.assigned_to ? ` \u2022 ${truncate(node.assigned_to, 12)}` : ''}
            </text>
            {/* Blocked indicator */}
            {node.is_blocked && (
              <text
                x={node.x + NODE_WIDTH - 30}
                y={node.y + 22}
                fill="#EF4444"
                fontSize={11}
              >
                {'\uD83D\uDD12'}{node.blocked_by_count}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function ListView({
  data,
  onNodeClick,
}: {
  data: DagData
  onNodeClick: (id: number) => void
}) {
  // Build maps for display
  const blockedByMap = new Map<number, number[]>()
  const blocksMap = new Map<number, number[]>()
  const relatedMap = new Map<number, number[]>()

  for (const edge of data.edges) {
    if (edge.type === 'blocks') {
      blockedByMap.set(edge.to, [...(blockedByMap.get(edge.to) || []), edge.from])
      blocksMap.set(edge.from, [...(blocksMap.get(edge.from) || []), edge.to])
    } else {
      relatedMap.set(edge.from, [...(relatedMap.get(edge.from) || []), edge.to])
      relatedMap.set(edge.to, [...(relatedMap.get(edge.to) || []), edge.from])
    }
  }

  const nodeMap = new Map(data.nodes.map((n) => [n.id, n]))

  if (data.nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        No tasks with dependencies found
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-800 text-gray-400">
          <tr>
            <th className="text-left p-2 font-medium">Task</th>
            <th className="text-left p-2 font-medium">Status</th>
            <th className="text-left p-2 font-medium">Blocked by</th>
            <th className="text-left p-2 font-medium">Blocks</th>
          </tr>
        </thead>
        <tbody>
          {data.nodes.map((node) => (
            <tr
              key={node.id}
              className="border-t border-gray-800 hover:bg-gray-800/50 cursor-pointer"
              onClick={() => onNodeClick(node.id)}
            >
              <td className="p-2">
                <span className="text-gray-200">
                  {node.ticket_ref && (
                    <span className="text-gray-500 mr-1">{node.ticket_ref}</span>
                  )}
                  {node.title}
                </span>
                {node.is_blocked && (
                  <span className="ml-2 text-red-400 text-xs">{'\uD83D\uDD12'} blocked</span>
                )}
              </td>
              <td className="p-2">
                <span
                  className="px-1.5 py-0.5 rounded text-xs"
                  style={{
                    backgroundColor:
                      (STATUS_COLORS[node.status] || STATUS_COLORS.inbox).bg,
                    color: (STATUS_COLORS[node.status] || STATUS_COLORS.inbox).text,
                  }}
                >
                  {node.status.replace(/_/g, ' ')}
                </span>
              </td>
              <td className="p-2 text-gray-400">
                {(blockedByMap.get(node.id) || []).map((id) => {
                  const n = nodeMap.get(id)
                  return n ? (
                    <span
                      key={id}
                      className="inline-block mr-1 text-xs bg-gray-800 px-1.5 py-0.5 rounded"
                    >
                      #{id} {truncate(n.title, 20)}
                    </span>
                  ) : null
                })}
              </td>
              <td className="p-2 text-gray-400">
                {(blocksMap.get(node.id) || []).map((id) => {
                  const n = nodeMap.get(id)
                  return n ? (
                    <span
                      key={id}
                      className="inline-block mr-1 text-xs bg-gray-800 px-1.5 py-0.5 rounded"
                    >
                      #{id} {truncate(n.title, 20)}
                    </span>
                  ) : null
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function TaskDagPanel() {
  const [data, setData] = useState<DagData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'dag' | 'list'>('dag')
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([])
  const [selectedProject, setSelectedProject] = useState<number | 0>(0)

  const fetchDag = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (selectedProject) params.set('project_id', String(selectedProject))
      const res = await fetch(`/api/tasks/dag?${params}`)
      if (!res.ok) throw new Error('Failed to fetch')
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch DAG')
    } finally {
      setLoading(false)
    }
  }, [selectedProject])

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d) => {
        if (d.projects) setProjects(d.projects)
      })
      .catch(() => {})
  }, [])

  useSmartPoll(fetchDag, 15000, { pauseWhenSseConnected: true })

  const handleNodeClick = useCallback((id: number) => {
    // Navigate to task board with task selected
    window.history.pushState(null, '', `/tasks?selected=${id}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [])

  return (
    <div className="h-full flex flex-col bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-200">Task Dependencies</h2>
          {data && (
            <span className="text-xs text-gray-500">
              {data.nodes.length} tasks, {data.edges.length} dependencies
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Project filter */}
          <select
            className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
            value={selectedProject}
            onChange={(e) => {
              setSelectedProject(Number(e.target.value))
              setLoading(true)
            }}
          >
            <option value={0}>All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {/* View toggle */}
          <div className="flex rounded overflow-hidden border border-gray-700">
            <button
              className={`px-2 py-1 text-xs ${view === 'dag' ? 'bg-gray-700 text-gray-200' : 'bg-gray-800 text-gray-400'}`}
              onClick={() => setView('dag')}
            >
              Graph
            </button>
            <button
              className={`px-2 py-1 text-xs ${view === 'list' ? 'bg-gray-700 text-gray-200' : 'bg-gray-800 text-gray-400'}`}
              onClick={() => setView('list')}
            >
              List
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-3 mt-2 p-2 bg-red-900/20 border border-red-500/30 rounded text-red-400 text-xs">
          {error}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <Loader variant="panel" />
      ) : data && view === 'dag' ? (
        <DagSvg data={data} onNodeClick={handleNodeClick} />
      ) : data && view === 'list' ? (
        <ListView data={data} onNodeClick={handleNodeClick} />
      ) : null}
    </div>
  )
}
