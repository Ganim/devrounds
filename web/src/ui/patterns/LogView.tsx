import { useEffect, useRef, useState } from 'react'
import { cx } from '../cx.ts'
import './LogView.css'

// Must match .dr-log line-height (13px * 1.5): rows are positioned from it.
const LINE_PX = 19.5
const OVERSCAN = 30

/**
 * Process output, windowed: only the lines in view (plus a margin) are in the DOM, so a run with 100k lines scrolls
 * as smoothly as one with 100. While the reader is at the bottom it follows new lines (tail); scrolling up stops
 * following until they come back down.
 */
export function LogView({
  lines,
  label,
  height = 480,
  empty = 'No output yet.',
}: {
  lines: string[]
  label: string
  height?: number
  empty?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [top, setTop] = useState(0)
  // After every render: new lines, or a resize, keep the tail in view while following.
  useEffect(() => {
    const el = box.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  })

  if (lines.length === 0) return <div className={cx('dr-log', 'dr-log--empty')}>{empty}</div>
  const first = Math.max(0, Math.floor(top / LINE_PX) - OVERSCAN)
  const last = Math.min(lines.length, Math.ceil((top + height) / LINE_PX) + OVERSCAN)
  return (
    <div
      ref={box}
      className="dr-log"
      role="log"
      aria-label={label}
      style={{ height }}
      onScroll={(event) => {
        const el = event.currentTarget
        setTop(el.scrollTop)
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_PX * 2
      }}
    >
      <div className="dr-log__space" style={{ height: lines.length * LINE_PX }}>
        <pre className="dr-log__lines" style={{ top: first * LINE_PX }}>
          {lines.slice(first, last).join('\n')}
        </pre>
      </div>
    </div>
  )
}
