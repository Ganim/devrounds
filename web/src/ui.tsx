import type { ReactNode } from 'react'
import type { ApiError, PhaseView } from './api.ts'
import { segments } from './segments.ts'

export const STATE_LABEL: Record<string, string> = {
  todo: 'todo',
  in_progress: 'in progress',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'cancelled',
  open: 'open',
  delivered: 'delivered',
}

export function Pill({ state }: { state: string }) {
  return <span className={`pill ${state}`}>{STATE_LABEL[state] ?? state}</span>
}

export function StackedBar({ progress }: { progress: PhaseView['progress'] }) {
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

export function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null
  return (
    <div className="error">
      <strong>{error.code}</strong> {error.message}
      {error.hint ? <div className="muted">{error.hint}</div> : null}
    </div>
  )
}

export function Loading({ data, error, children }: { data: unknown; error: ApiError | null; children: ReactNode }) {
  if (data === null) return error ? <ErrorBox error={error} /> : <p className="muted">Loading...</p>
  return (
    <>
      <ErrorBox error={error} />
      {children}
    </>
  )
}

export const when = (iso: string | null): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '')
