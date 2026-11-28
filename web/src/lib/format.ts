const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

/** Binary units, at most one decimal and none when whole: `536870912` → `512 MiB`. */
export function formatBytes(n: number | null): string {
  if (n === null) return '—'
  let value = n
  let unit = 0
  while (Math.abs(value) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : Number(value.toFixed(1))} ${UNITS[unit]}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `65000` → `1m 05s`; under a second in ms, under a minute in seconds; null → `—`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))}s`
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`
}

/** An ISO timestamp as `YYYY-MM-DD HH:MM`, as the server wrote it (UTC); null → empty. */
export const when = (iso: string | null): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '')

/** The first 8 characters of a uuid, enough to tell runs and jobs apart on one page. */
export const shortId = (id: string): string => id.slice(0, 8)
