import { Banner } from './Banner.tsx'
import './ErrorBox.css'

// Any error with a code and a hint: data's ApiError fits, and ui never imports data.
export type ShownError = { code: string; message: string; hint: string }

/** An API error: code first (what an agent or a search needs), the message, then the hint muted under it. */
export function ErrorBox({ error }: { error: ShownError | null }) {
  if (!error) return null
  return (
    <Banner tone="danger">
      <strong className="dr-error__code">{error.code}</strong> {error.message}
      {error.hint ? <div className="dr-error__hint">{error.hint}</div> : null}
    </Banner>
  )
}
