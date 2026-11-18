import { fail } from '../errors/error.ts'

export type TaskState = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled'

export const ALLOWED: Record<TaskState, TaskState[]> = {
  todo: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['done', 'blocked', 'todo', 'cancelled'],
  blocked: ['todo', 'in_progress', 'cancelled'],
  done: ['in_progress'],
  cancelled: ['todo'],
}

// done->in_progress (reopen) and cancelled->todo (restore) also need a reason.
const NEEDS_REASON = (from: TaskState, to: TaskState): boolean =>
  to === 'blocked' || to === 'cancelled' || from === 'done' || from === 'cancelled'

// A cancelled blocker no longer holds anything back, same as a done one.
export function isBlockerOpen(state: TaskState): boolean {
  return state !== 'done' && state !== 'cancelled'
}

// When several rules apply the first match wins: DR301 (move not allowed), DR104 (missing reason),
// then preconditions DR302, DR304 (entering in_progress) and DR303 (entering done).
export function checkTransition(i: {
  from: TaskState
  to: TaskState
  openBlockers: string[]
  openCriteria: number
  blockingPhasesOpen: string[]
  reason?: string
}): void {
  const { from, to } = i
  if (!ALLOWED[from].includes(to)) fail('DR301', { from, to })
  if (NEEDS_REASON(from, to) && (i.reason === undefined || i.reason.trim() === '')) fail('DR104')
  if (to === 'in_progress') {
    if (i.openBlockers.length > 0) fail('DR302', { blockers: i.openBlockers })
    if (i.blockingPhasesOpen.length > 0) fail('DR304', { phases: i.blockingPhasesOpen })
  }
  if (to === 'done' && i.openCriteria > 0) fail('DR303', { count: i.openCriteria })
}

// Callers pass [key, blockedByKey] ("key is blocked by blockedByKey") for both tasks and phases.
// Edges are [from, to]; adding `add` creates a cycle when `add[0]` is already reachable from `add[1]`.
export function wouldCycle(edges: Array<[string, string]>, add: [string, string]): boolean {
  const [from, to] = add
  if (from === to) return true
  const next = new Map<string, string[]>()
  for (const [a, b] of edges) next.set(a, [...(next.get(a) ?? []), b])
  const seen = new Set<string>()
  const stack = [to]
  while (stack.length > 0) {
    const node = stack.pop() as string
    if (node === from) return true
    if (seen.has(node)) continue
    seen.add(node)
    stack.push(...(next.get(node) ?? []))
  }
  return false
}

export function phaseProgress(states: TaskState[]): {
  done: number
  inProgress: number
  todo: number
  blocked: number
  cancelled: number
  total: number
  percent: number
} {
  const count = (s: TaskState) => states.filter((x) => x === s).length
  const done = count('done')
  const cancelled = count('cancelled')
  const total = states.length
  const denominator = total - cancelled
  return {
    done,
    inProgress: count('in_progress'),
    todo: count('todo'),
    blocked: count('blocked'),
    cancelled,
    total,
    percent: denominator === 0 ? 0 : Math.round((100 * done) / denominator),
  }
}

// A phase closes only with at least one done task, no task still open and no open phase criterion.
export function isPhaseClosable(i: { states: TaskState[]; openCriteria: number }): boolean {
  return !i.states.some(isBlockerOpen) && i.openCriteria === 0 && i.states.includes('done')
}

export function checkPhaseClose(i: { states: TaskState[]; openCriteria: number }): void {
  const openTasks = i.states.filter(isBlockerOpen).length
  const noDoneTask = !i.states.includes('done')
  if (!isPhaseClosable(i)) {
    fail('DR305', { openTasks, openCriteria: i.openCriteria, noDoneTask })
  }
}
