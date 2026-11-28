import { type Progress, segments } from '../../lib/segments.ts'
import { Pill } from '../../ui/index.ts'

export const STATE_LABEL: Record<string, string> = {
  todo: 'todo',
  in_progress: 'in progress',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'cancelled',
  open: 'open',
  delivered: 'delivered',
}

/** The state of a phase, task or criterion. */
export const StatePill = ({ state }: { state: string }) => <Pill state={state} label={STATE_LABEL[state] ?? state} />

export function StackedBar({ progress }: { progress: Progress }) {
  return (
    <div className="bar">
      {segments(progress).map((s) => (
        <span
          key={s.state}
          className={`seg-${s.state}`}
          style={{ width: `${s.widthPct}%` }}
          title={`${STATE_LABEL[s.state]}: ${s.count}`}
        />
      ))}
    </div>
  )
}
