import type { RunState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'

export type RunTransition = 'offer' | 'delay' | 'admit' | 'start' | 'finish' | 'fail' | 'stop' | 'orphan' | 'skip'
export type RunStamp = 'offered_at' | 'admitted_at' | 'started_at' | 'finished_at'

type Move = { from: readonly RunState[]; to: RunState | 'same'; stamp?: RunStamp }

// The executor reports Delayed while the offer waits for admission, and may end a run before it starts: a spawn
// failure or a Stop while admitting. Only a started run can exit 0. Orphaned has no end stamp: nobody saw it end.
// An admitted run can be orphaned: an executor that crashed after storing the leader, before RunStarted, reports it.
const MOVES: Record<RunTransition, Move> = {
  offer: { from: ['queued'], to: 'offered', stamp: 'offered_at' },
  delay: { from: ['offered'], to: 'same' },
  admit: { from: ['offered'], to: 'admitted', stamp: 'admitted_at' },
  start: { from: ['admitted'], to: 'running', stamp: 'started_at' },
  finish: { from: ['running'], to: 'finished', stamp: 'finished_at' },
  fail: { from: ['offered', 'admitted', 'running'], to: 'failed', stamp: 'finished_at' },
  stop: { from: ['queued', 'offered', 'admitted', 'running'], to: 'stopped', stamp: 'finished_at' },
  orphan: { from: ['admitted', 'running'], to: 'orphaned' },
  skip: { from: ['queued'], to: 'skipped', stamp: 'finished_at' },
}

export const TERMINAL: readonly RunState[] = ['finished', 'failed', 'stopped', 'orphaned', 'skipped']

/** The state after `transition`, and the column to stamp; DR351 naming `run` when `state` does not allow it. */
export function nextRunState(
  state: RunState,
  transition: RunTransition,
  run: string,
): { state: RunState; stamp?: RunStamp } {
  const move = MOVES[transition]
  if (!move.from.includes(state)) fail('DR351', { run, state })
  const next = move.to === 'same' ? state : move.to
  return move.stamp ? { state: next, stamp: move.stamp } : { state: next }
}
