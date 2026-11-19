import { type RunListJson, usePages, useRemote } from './api.ts'
import { formatDuration } from './format.ts'
import { Loading, when } from './ui.tsx'

const STATES = ['queued', 'offered', 'admitted', 'running', 'finished', 'failed', 'stopped', 'orphaned', 'skipped']

export function RunState({ state, failureClass }: { state: string; failureClass?: string | null }) {
  return (
    <>
      <span className={`pill ${state}`}>{state}</span>
      {failureClass ? <span className="muted"> {failureClass}</span> : null}
    </>
  )
}

export const shortId = (id: string): string => id.slice(0, 8)

// `filters` come from the hash (#/runs?state=failed&jobType=check&queue=nightly); changing one rewrites the hash, so
// a filtered list is a link that can be shared or reloaded.
export function RunsPage({ filters }: { filters: URLSearchParams }) {
  const query = new URLSearchParams()
  for (const name of ['state', 'jobType', 'queue']) {
    const value = filters.get(name)
    if (value) query.set(name, value)
  }
  const pages = usePages(query.toString())
  if (pages.cursor) query.set('cursor', pages.cursor)
  const runs = useRemote<RunListJson>(`/runs?${query}`)
  const filter = (name: string, value: string) => {
    const next = new URLSearchParams(filters)
    if (value) next.set(name, value)
    else next.delete(name)
    location.hash = `#/runs${next.size > 0 ? `?${next}` : ''}`
  }
  const rows = runs.data?.runs ?? []
  return (
    <>
      <div className="filters">
        <label>
          State{' '}
          <select value={filters.get('state') ?? ''} onChange={(e) => filter('state', e.target.value)}>
            <option value="">any</option>
            {STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Job type{' '}
          <input
            key={filters.get('jobType') ?? ''}
            defaultValue={filters.get('jobType') ?? ''}
            placeholder="any"
            onKeyDown={(e) => e.key === 'Enter' && filter('jobType', e.currentTarget.value.trim())}
            onBlur={(e) => filter('jobType', e.currentTarget.value.trim())}
          />
        </label>
        {filters.get('queue') ? (
          <span>
            Queue <strong>{filters.get('queue')}</strong>{' '}
            <button type="button" className="link" onClick={() => filter('queue', '')}>
              clear
            </button>
          </span>
        ) : null}
      </div>
      <Loading data={runs.data} error={runs.error}>
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>State</th>
              <th>Job type</th>
              <th>Queue</th>
              <th>Machine</th>
              <th className="num">Attempt</th>
              <th>Queued</th>
              <th>Finished</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <a href={`#/run/${r.id}`} className="mono">
                    {shortId(r.id)}
                  </a>
                </td>
                <td>
                  <RunState state={r.state} failureClass={r.failureClass} />
                </td>
                <td>{r.jobType}</td>
                <td>{r.queue}</td>
                <td>{r.machine ?? <span className="muted">—</span>}</td>
                <td className="num">
                  {r.attempt}
                  {r.cause === 'first' ? '' : <span className="muted"> {r.cause}</span>}
                </td>
                <td className="muted">{when(r.queuedAt)}</td>
                <td className="muted">{when(r.finishedAt)}</td>
                <td className="num">{formatDuration(r.totalMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="muted">No runs match.</p> : null}
        <Pager page={pages.page} onNewer={pages.newer} next={runs.data?.nextCursor ?? null} onOlder={pages.older} />
      </Loading>
    </>
  )
}

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
