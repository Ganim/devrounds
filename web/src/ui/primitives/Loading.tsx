import type { ReactNode } from 'react'
import { ErrorBox, type ShownError } from './ErrorBox.tsx'

export function Loading({ data, error, children }: { data: unknown; error: ShownError | null; children: ReactNode }) {
  if (data === null) return error ? <ErrorBox error={error} /> : <p className="muted">Loading...</p>
  return (
    <>
      <ErrorBox error={error} />
      {children}
    </>
  )
}
