/**
 * The semantic tones a primitive can show. ui reads them as `--state-*` tokens; a domain state never reaches ui as a
 * color, it is mapped to a tone here (shared by several features) or in the feature that owns it.
 */
export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'idle' | 'neutral'

const TASK: Record<string, Tone> = {
  done: 'ok',
  delivered: 'ok',
  in_progress: 'info',
  blocked: 'danger',
  todo: 'neutral',
  open: 'neutral',
  cancelled: 'idle',
}

/** Phase, task and criterion states. */
export const taskTone = (state: string): Tone => TASK[state] ?? 'neutral'

const RUN: Record<string, Tone> = {
  finished: 'ok',
  running: 'info',
  queued: 'neutral',
  offered: 'neutral',
  admitted: 'neutral',
  failed: 'danger',
  orphaned: 'danger',
  stopped: 'idle',
  skipped: 'idle',
}

/** Run and job-run states. */
export const runTone = (state: string): Tone => RUN[state] ?? 'neutral'
