// `state` picks the colour class; the feature that knows the domain passes the label and the muted notes after it.
export function Pill({
  state,
  label = state,
  notes = [],
}: {
  state: string
  label?: string
  notes?: (string | false | null | undefined)[]
}) {
  return (
    <>
      <span className={`pill ${state}`}>{label}</span>
      {notes.map((note) => (note ? <span key={note} className="muted"> {note}</span> : null))}
    </>
  )
}
