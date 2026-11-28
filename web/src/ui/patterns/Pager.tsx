export function Pager(p: { page: number; next: string | null; onNewer: () => void; onOlder: (next: string) => void }) {
  if (p.page === 1 && p.next === null) return null
  const { next } = p
  return (
    <p className="pager">
      <button type="button" className="link" disabled={p.page === 1} onClick={p.onNewer}>
        newer
      </button>
      <span className="muted"> page {p.page} </span>
      <button type="button" className="link" disabled={next === null} onClick={() => next && p.onOlder(next)}>
        older
      </button>
    </p>
  )
}
