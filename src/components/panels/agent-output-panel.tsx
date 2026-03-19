'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { AnsiRenderer } from '@/components/ui/ansi-renderer'
import { Loader } from '@/components/ui/loader'

interface OutputLine {
  id: number
  stream: string
  content: string
  created_at: number
}

interface AgentOption {
  id: number
  name: string
  status: string
}

const MAX_LINES = 5000

export function AgentOutputPanel() {
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const [streamFilter, setStreamFilter] = useState<'all' | 'stdout' | 'stderr'>('all')
  const [lines, setLines] = useState<OutputLine[]>([])
  const [connecting, setConnecting] = useState(false)
  const [scrollLocked, setScrollLocked] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const autoScrollRef = useRef(true)

  // Fetch agents list
  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.agents) {
          const opts = data.agents.map((a: any) => ({ id: a.id, name: a.name, status: a.status }))
          setAgents(opts)
          if (opts.length > 0 && !selectedAgent) {
            setSelectedAgent(opts[0].name)
          }
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (containerRef.current && autoScrollRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [])

  // Handle scroll events for scroll-lock detection
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    autoScrollRef.current = isAtBottom
    setScrollLocked(!isAtBottom)
  }, [])

  // Connect to SSE when agent or filter changes
  useEffect(() => {
    if (!selectedAgent) return

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    setLines([])
    setConnecting(true)
    autoScrollRef.current = true
    setScrollLocked(false)

    const params = new URLSearchParams()
    if (streamFilter !== 'all') params.set('stream', streamFilter)

    const es = new EventSource(`/api/agents/${encodeURIComponent(selectedAgent)}/output?${params.toString()}`)
    eventSourceRef.current = es

    es.onopen = () => {
      setConnecting(false)
    }

    es.onmessage = (event) => {
      try {
        const data: OutputLine = JSON.parse(event.data)
        if (!data.content) return
        setLines(prev => {
          const next = [...prev, data]
          if (next.length > MAX_LINES) {
            return next.slice(next.length - MAX_LINES)
          }
          return next
        })
      } catch {
        // Ignore parse errors (heartbeats etc)
      }
    }

    es.onerror = () => {
      setConnecting(false)
    }

    return () => {
      es.close()
      eventSourceRef.current = null
    }
  }, [selectedAgent, streamFilter])

  // Auto-scroll when new lines arrive
  useEffect(() => {
    scrollToBottom()
  }, [lines, scrollToBottom])

  const jumpToBottom = useCallback(() => {
    autoScrollRef.current = true
    setScrollLocked(false)
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [])

  const clearLines = useCallback(() => {
    setLines([])
  }, [])

  return (
    <div className="h-full flex flex-col bg-gray-900">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-gray-900/95 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-green-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="2" width="14" height="12" rx="2" />
            <path d="M4 7l2 2-2 2" />
            <path d="M9 11h3" />
          </svg>
          <span className="text-sm font-semibold text-foreground">Agent Terminal</span>
        </div>

        {/* Agent selector */}
        <select
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value)}
          className="text-xs bg-gray-800 border border-border/50 rounded px-2 py-1 text-foreground"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name} ({a.status})
            </option>
          ))}
        </select>

        {/* Stream filter */}
        <div className="flex gap-0.5 bg-gray-800 rounded p-0.5">
          {(['all', 'stdout', 'stderr'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStreamFilter(s)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${
                streamFilter === s
                  ? 'bg-gray-700 text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s === 'all' ? 'All' : s}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Line count */}
        <span className="text-2xs text-muted-foreground">
          {lines.length.toLocaleString()} line{lines.length !== 1 ? 's' : ''}
        </span>

        {/* Clear button */}
        <Button
          size="xs"
          variant="ghost"
          onClick={clearLines}
          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Clear
        </Button>
      </div>

      {/* Terminal output */}
      <div className="flex-1 relative">
        {connecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-950/80 z-10">
            <Loader variant="inline" />
          </div>
        )}

        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-auto bg-gray-950 p-3 font-mono text-xs leading-5"
        >
          {lines.length === 0 && !connecting && (
            <div className="text-muted-foreground/50 text-center py-8">
              {selectedAgent ? 'Waiting for output...' : 'Select an agent to view output'}
            </div>
          )}

          {lines.map((line) => (
            <div
              key={line.id}
              className={`whitespace-pre-wrap break-all ${
                line.stream === 'stderr' ? 'text-red-400' : 'text-gray-200'
              }`}
            >
              <AnsiRenderer text={line.content} />
            </div>
          ))}
        </div>

        {/* Jump to bottom */}
        {scrollLocked && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-4 right-4 z-20 bg-gray-800 border border-border/50 rounded-full px-3 py-1.5 text-xs text-foreground hover:bg-gray-700 transition-colors shadow-lg"
          >
            Jump to bottom
          </button>
        )}
      </div>
    </div>
  )
}
