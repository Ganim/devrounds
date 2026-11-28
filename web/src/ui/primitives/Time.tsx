import { useEffect, useState } from 'react'
import { formatAgo } from '../../lib/time.ts'

// One clock for every <Time>: a page with 200 rows sets one interval, not 200.
const listeners = new Set<(now: number) => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: (now: number) => void) {
  listeners.add(listener)
  timer ??= setInterval(() => {
    const now = Date.now()
    for (const l of listeners) l(now)
  }, 10_000)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** A relative time (`5m ago`) refreshed every 10 s; the exact UTC timestamp is the tooltip and the datetime. */
export function Time({ at }: { at: string | null }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => subscribe(setNow), [])
  if (!at) return null
  return (
    <time dateTime={at} title={at.replace('T', ' ').slice(0, 19)}>
      {formatAgo(at, now)}
    </time>
  )
}
