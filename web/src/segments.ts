import type { PhaseView } from '../../control-plane/src/planning/view.ts'

export type Segment = {
  state: 'done' | 'in_progress' | 'blocked' | 'todo' | 'cancelled'
  count: number
  widthPct: number
}

// Cancelled is last (and greyed by the caller) so it never reads as progress.
export function segments(progress: PhaseView['progress']): Segment[] {
  const parts: Array<[Segment['state'], number]> = [
    ['done', progress.done],
    ['in_progress', progress.inProgress],
    ['blocked', progress.blocked],
    ['todo', progress.todo],
    ['cancelled', progress.cancelled],
  ]
  const present = parts.filter(([, count]) => count > 0)
  const total = present.reduce((sum, [, count]) => sum + count, 0)
  if (total === 0) return []
  // Largest remainder: whole-number widths that always add up to exactly 100.
  const exact = present.map(([, count]) => (100 * count) / total)
  const widths = exact.map(Math.floor)
  const order = exact
    .map((value, i) => ({ i, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (let n = 100 - widths.reduce((sum, w) => sum + w, 0), k = 0; n > 0; n--, k++) widths[order[k].i] += 1
  return present.map(([state, count], i) => ({ state, count, widthPct: widths[i] }))
}
