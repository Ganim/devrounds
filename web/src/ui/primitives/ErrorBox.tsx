// Any error with a code and a hint: data's ApiError fits, and ui never imports data.
export type ShownError = { code: string; message: string; hint: string }

export function ErrorBox({ error }: { error: ShownError | null }) {
  if (!error) return null
  return (
    <div className="error">
      <strong>{error.code}</strong> {error.message}
      {error.hint ? <div className="muted">{error.hint}</div> : null}
    </div>
  )
}
