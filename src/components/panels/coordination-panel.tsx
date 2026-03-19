'use client'

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { GraphCanvas, GraphCanvasRef, type GraphNode as ReagraphNode, type GraphEdge as ReagraphEdge, type InternalGraphNode, type Theme } from 'reagraph'
import { useSmartPoll } from '@/lib/use-smart-poll'

// --- Types ---

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

interface CoordinationStats {
  active_collaborations: number
  handoffs_today: number
  most_connected: string
}

interface CoordinationData {
  nodes: AgentNode[]
  edges: InteractionEdge[]
  stats: CoordinationStats
}

// --- Constants ---

const TIMEFRAMES = ['1h', '6h', '24h', '7d'] as const

const STATUS_COLORS: Record<string, string> = {
  active: '#a6e3a1',
  idle: '#f9e2af',
  busy: '#89b4fa',
  offline: '#6c7086',
  error: '#f38ba8',
}

const TYPE_COLORS: Record<string, string> = {
  handoff: '#f9e2af',
  delegation: '#89b4fa',
  message: '#cba6f7',
  shared_context: '#94e2d5',
  review_request: '#f5c2e7',
  implicit_handoff: '#fab387',
}

const TYPE_LABELS: Record<string, string> = {
  handoff: 'Handoff',
  delegation: 'Delegation',
  message: 'Message',
  shared_context: 'Shared Context',
  review_request: 'Review Request',
  implicit_handoff: 'Implicit Handoff',
}

// --- Graph theme ---

const coordinationTheme: Theme = {
  canvas: {
    background: '#111827',
    fog: '#111827',
  },
  node: {
    fill: '#6c7086',
    activeFill: '#cba6f7',
    opacity: 1,
    selectedOpacity: 1,
    inactiveOpacity: 0.2,
    label: {
      color: '#e5e7eb',
      stroke: '#111827',
      activeColor: '#f5f5f7',
    },
  },
  ring: {
    fill: '#6c7086',
    activeFill: '#cba6f7',
  },
  edge: {
    fill: '#4b5563',
    activeFill: '#cba6f7',
    opacity: 0.4,
    selectedOpacity: 0.8,
    inactiveOpacity: 0.1,
    label: {
      color: '#9ca3af',
      activeColor: '#e5e7eb',
    },
  },
  arrow: {
    fill: '#4b5563',
    activeFill: '#cba6f7',
  },
  lasso: {
    background: 'rgba(203, 166, 247, 0.08)',
    border: 'rgba(203, 166, 247, 0.25)',
  },
}

// --- Component ---

export function CoordinationPanel() {
  const [data, setData] = useState<CoordinationData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [timeframe, setTimeframe] = useState<string>('24h')
  const [agentFilter, setAgentFilter] = useState<string>('')
  const [view, setView] = useState<'graph' | 'list'>('graph')
  const [selectedNode, setSelectedNode] = useState<AgentNode | null>(null)
  const [actives, setActives] = useState<string[]>([])
  const graphRef = useRef<GraphCanvasRef | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({ timeframe })
      if (agentFilter) params.set('agent', agentFilter)
      const res = await fetch(`/api/coordination?${params}`)
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [timeframe, agentFilter])

  useSmartPoll(fetchData, 15000, { pauseWhenSseConnected: true })

  // Build reagraph data
  const { graphNodes, graphEdges } = useMemo(() => {
    if (!data || !data.nodes.length) return { graphNodes: [], graphEdges: [] }

    const nodes: ReagraphNode[] = data.nodes.map((node) => ({
      id: node.id,
      label: node.name,
      fill: STATUS_COLORS[node.status] || STATUS_COLORS.active,
      size: Math.max(4, Math.min(14, 4 + Math.sqrt(node.interaction_count) * 2)),
    }))

    const edges: ReagraphEdge[] = data.edges.map((edge, i) => ({
      id: `edge-${i}`,
      source: edge.from,
      target: edge.to,
      label: edge.count > 1 ? `${edge.count}` : '',
      fill: TYPE_COLORS[edge.type] || '#4b5563',
      size: Math.max(1, Math.min(4, edge.count)),
    }))

    return { graphNodes: nodes, graphEdges: edges }
  }, [data])

  // Auto-fit graph after data changes
  useEffect(() => {
    if (!graphNodes.length) return
    const t1 = setTimeout(() => graphRef.current?.fitNodesInView(undefined, { animated: false }), 800)
    const t2 = setTimeout(() => graphRef.current?.fitNodesInView(undefined, { animated: false }), 2500)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [graphNodes.length])

  const handleNodeClick = useCallback((node: InternalGraphNode) => {
    if (!data) return
    const agentNode = data.nodes.find((n) => n.id === node.id)
    setSelectedNode(agentNode || null)
  }, [data])

  const handleNodeHover = useCallback((node: InternalGraphNode) => {
    setActives([node.id])
  }, [])

  const handleNodeUnhover = useCallback(() => {
    setActives([])
  }, [])

  // Get unique agent names for filter dropdown
  const agentNames = useMemo(() => {
    if (!data) return []
    return Array.from(new Set(data.nodes.map((n) => n.name))).sort()
  }, [data])

  // Timeline items for list view
  const timelineItems = useMemo(() => {
    if (!data) return []
    return data.edges
      .flatMap((edge) => {
        const items = []
        for (let i = 0; i < edge.count; i++) {
          items.push({
            from: edge.from,
            to: edge.to,
            type: edge.type,
            last_at: edge.last_at,
          })
        }
        return items
      })
      .sort((a, b) => b.last_at - a.last_at)
      .slice(0, 100)
  }, [data])

  function formatTime(ts: number): string {
    const d = new Date(ts * 1000)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="bg-gray-900 h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700/50 flex items-center gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-100">Coordination</h2>

        {/* Timeframe selector */}
        <div className="flex items-center gap-1 ml-auto">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                timeframe === tf
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        {/* Agent filter */}
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="px-2 py-1 text-xs rounded-md bg-gray-800 text-gray-300 border border-gray-700 focus:outline-none focus:border-indigo-500"
        >
          <option value="">All agents</option>
          {agentNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        {/* View toggle */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView('graph')}
            className={`px-2 py-1 text-xs rounded-md transition-colors ${
              view === 'graph'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
            }`}
          >
            Graph
          </button>
          <button
            onClick={() => setView('list')}
            className={`px-2 py-1 text-xs rounded-md transition-colors ${
              view === 'list'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
            }`}
          >
            List
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {data && (
        <div className="px-4 py-2 border-b border-gray-700/50 flex items-center gap-6 text-xs">
          <div>
            <span className="text-gray-500">Active Collaborations</span>{' '}
            <span className="text-gray-200 font-medium">{data.stats.active_collaborations}</span>
          </div>
          <div>
            <span className="text-gray-500">Handoffs</span>{' '}
            <span className="text-gray-200 font-medium">{data.stats.handoffs_today}</span>
          </div>
          <div>
            <span className="text-gray-500">Most Connected</span>{' '}
            <span className="text-gray-200 font-medium">{data.stats.most_connected || 'N/A'}</span>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden relative">
        {loading && !data && (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 rounded-full border-2 border-indigo-500/30 border-t-indigo-500 animate-spin" />
              <span className="text-gray-500 text-sm">Loading coordination data...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <span className="text-red-400 text-sm">{error}</span>
            <button
              onClick={() => { setLoading(true); fetchData() }}
              className="px-3 py-1.5 text-xs rounded-md bg-gray-800 border border-gray-700 text-gray-300 hover:border-indigo-500/50 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && data && data.nodes.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <span className="text-gray-500 text-sm">No coordination activity in this timeframe</span>
            <span className="text-gray-600 text-xs">Agent interactions will appear here as they occur</span>
          </div>
        )}

        {data && data.nodes.length > 0 && view === 'graph' && (
          <>
            <GraphCanvas
              ref={graphRef}
              nodes={graphNodes}
              edges={graphEdges}
              theme={coordinationTheme}
              layoutType="forceDirected2d"
              layoutOverrides={{
                linkDistance: 120,
                nodeStrength: -100,
              }}
              labelType="auto"
              edgeArrowPosition="end"
              animated={true}
              draggable={true}
              defaultNodeSize={6}
              minNodeSize={3}
              maxNodeSize={14}
              cameraMode="pan"
              actives={actives}
              onNodeClick={handleNodeClick}
              onNodePointerOver={handleNodeHover}
              onNodePointerOut={handleNodeUnhover}
              onCanvasClick={() => { setActives([]); setSelectedNode(null) }}
            />

            {/* Legend */}
            <div className="absolute bottom-3 right-3 z-10">
              <div className="px-3 py-2 rounded-lg bg-gray-900/80 backdrop-blur-xl border border-gray-700/30">
                <div className="flex items-center gap-3 text-[9px] font-mono text-gray-500 flex-wrap">
                  {Object.entries(TYPE_COLORS).map(([type, color]) => (
                    <span key={type} className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                      {TYPE_LABELS[type] || type}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Selected node detail */}
            {selectedNode && (
              <div className="absolute bottom-3 left-3 z-10 max-w-xs">
                <div className="px-4 py-3 rounded-lg bg-gray-900/90 backdrop-blur-xl border border-gray-700/40 shadow-2xl">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <h3 className="text-xs font-medium text-gray-200">{selectedNode.name}</h3>
                    <button
                      onClick={() => setSelectedNode(null)}
                      className="text-gray-500 hover:text-gray-300 text-xs transition-colors"
                    >
                      x
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-gray-500">
                    <span className="flex items-center gap-1">
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: STATUS_COLORS[selectedNode.status] || STATUS_COLORS.active }}
                      />
                      {selectedNode.status}
                    </span>
                    <span>{selectedNode.interaction_count} interactions</span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {data && data.nodes.length > 0 && view === 'list' && (
          <div className="overflow-auto h-full">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-900 z-10">
                <tr className="border-b border-gray-700/50">
                  <th className="text-left px-4 py-2 text-gray-500 font-medium">Time</th>
                  <th className="text-left px-4 py-2 text-gray-500 font-medium">From</th>
                  <th className="text-left px-4 py-2 text-gray-500 font-medium">To</th>
                  <th className="text-left px-4 py-2 text-gray-500 font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {timelineItems.map((item, i) => (
                  <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-2 text-gray-400 font-mono">{formatTime(item.last_at)}</td>
                    <td className="px-4 py-2 text-gray-200">{item.from}</td>
                    <td className="px-4 py-2 text-gray-200">{item.to}</td>
                    <td className="px-4 py-2">
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
                        style={{ background: `${TYPE_COLORS[item.type] || '#4b5563'}20`, color: TYPE_COLORS[item.type] || '#9ca3af' }}
                      >
                        {TYPE_LABELS[item.type] || item.type}
                      </span>
                    </td>
                  </tr>
                ))}
                {timelineItems.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-600">
                      No interactions in this timeframe
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
