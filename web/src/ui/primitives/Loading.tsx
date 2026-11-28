import type { ReactNode } from 'react'
import { ErrorBox, type ShownError } from './ErrorBox.tsx'
import { Spinner } from './Spinner.tsx'

/** A spinner until the first data, the error alone if it failed first, else the error (if any) above the content. */
export function Loading({ data, error, children }: { data: unknown; error: ShownError | null; children: ReactNode }) {
  if (data === null) return error ? <ErrorBox error={error} /> : <Spinner label="Loading..." showLabel />
  return (
    <>
      <ErrorBox error={error} />
      {children}
    </>
  )
}
