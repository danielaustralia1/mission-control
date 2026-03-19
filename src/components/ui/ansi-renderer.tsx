import React from 'react'

interface SpanStyle {
  color?: string
  backgroundColor?: string
  fontWeight?: string
  opacity?: string
  textDecoration?: string
}

const FG_COLORS: Record<number, string> = {
  30: '#1e1e1e', 31: '#e55561', 32: '#8cc265', 33: '#d18f52',
  34: '#4d9ee0', 35: '#c162de', 36: '#42b3c2', 37: '#d0d0d0',
  90: '#666666', 91: '#ff6b6b', 92: '#a6e22e', 93: '#ffd866',
  94: '#82aaff', 95: '#c792ea', 96: '#89ddff', 97: '#ffffff',
}

const BG_COLORS: Record<number, string> = {
  40: '#1e1e1e', 41: '#e55561', 42: '#8cc265', 43: '#d18f52',
  44: '#4d9ee0', 45: '#c162de', 46: '#42b3c2', 47: '#d0d0d0',
  100: '#666666', 101: '#ff6b6b', 102: '#a6e22e', 103: '#ffd866',
  104: '#82aaff', 105: '#c792ea', 106: '#89ddff', 107: '#ffffff',
}

interface Segment {
  text: string
  style: SpanStyle
}

function parseAnsi(text: string): Segment[] {
  const segments: Segment[] = []
  let currentStyle: SpanStyle = {}
  const regex = /\x1b\[([0-9;]*)m/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // Push text before this escape
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), style: { ...currentStyle } })
    }
    lastIndex = regex.lastIndex

    const codes = match[1].split(';').map(Number)
    for (const code of codes) {
      if (code === 0 || isNaN(code)) {
        currentStyle = {}
      } else if (code === 1) {
        currentStyle = { ...currentStyle, fontWeight: 'bold' }
      } else if (code === 2) {
        currentStyle = { ...currentStyle, opacity: '0.6' }
      } else if (code === 4) {
        currentStyle = { ...currentStyle, textDecoration: 'underline' }
      } else if (FG_COLORS[code]) {
        currentStyle = { ...currentStyle, color: FG_COLORS[code] }
      } else if (BG_COLORS[code]) {
        currentStyle = { ...currentStyle, backgroundColor: BG_COLORS[code] }
      }
    }
  }

  // Push remaining text
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), style: { ...currentStyle } })
  }

  // Strip any remaining unsupported escape sequences
  return segments.map(seg => ({
    text: seg.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
    style: seg.style,
  }))
}

export function AnsiRenderer({ text }: { text: string }): React.JSX.Element {
  const segments = parseAnsi(text)

  if (segments.length === 0) {
    return <span>{text}</span>
  }

  return (
    <span>
      {segments.map((seg, i) => {
        const hasStyle = Object.keys(seg.style).length > 0
        if (!hasStyle) return <React.Fragment key={i}>{seg.text}</React.Fragment>
        return (
          <span key={i} style={seg.style}>
            {seg.text}
          </span>
        )
      })}
    </span>
  )
}
