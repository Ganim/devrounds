import { Button } from '../primitives/Button.tsx'
import './Pager.css'

/** Newer / older over keyset pages; hidden when everything fits on the first page. */
export function Pager(p: { page: number; next: string | null; onNewer: () => void; onOlder: (next: string) => void }) {
  if (p.page === 1 && p.next === null) return null
  const { next } = p
  return (
    <nav className="dr-pager" aria-label="Pages">
      <Button size="sm" variant="ghost" disabled={p.page === 1} onClick={p.onNewer}>
        Newer
      </Button>
      <span className="dr-pager__page">page {p.page}</span>
      <Button size="sm" variant="ghost" disabled={next === null} onClick={() => next && p.onOlder(next)}>
        Older
      </Button>
    </nav>
  )
}
