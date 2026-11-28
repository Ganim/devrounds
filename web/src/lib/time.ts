const STEPS: [limitS: number, unitS: number, unit: string][] = [
  [60, 1, 's'],
  [3600, 60, 'm'],
  [86_400, 3600, 'h'],
  [30 * 86_400, 86_400, 'd'],
]

/**
 * How long ago `iso` was, coarse and short: `now`, `42s ago`, `5m ago`, `3h ago`, `12d ago`, then the date. A time
 * ahead of `now` (clock skew, a scheduled run) reads `in 5m`.
 */
export function formatAgo(iso: string, now: number): string {
  const diffS = Math.round((now - Date.parse(iso)) / 1000)
  const abs = Math.abs(diffS)
  if (abs < 5) return 'now'
  for (const [limit, unit, label] of STEPS) {
    if (abs < limit) {
      const n = `${Math.floor(abs / unit)}${label}`
      return diffS >= 0 ? `${n} ago` : `in ${n}`
    }
  }
  return iso.slice(0, 10)
}
