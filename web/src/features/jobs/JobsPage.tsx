import { useState } from 'react'
import { useJobs, usePages } from '../../data/resources.ts'
import { shortId } from '../../lib/format.ts'
import { runTone } from '../../lib/tones.ts'
import { Badge, Loading, Pager } from '../../ui/index.ts'

const STATES = ['open', 'finished', 'failed', 'stopped', 'skipped']

export function JobsPage() {
  const [state, setState] = useState('')
  const query = new URLSearchParams(state ? { state } : {})
  const pages = usePages(query.toString())
  if (pages.cursor) query.set('cursor', pages.cursor)
  const jobs = useJobs(query)
  const rows = jobs.data?.jobs ?? []
  return (
    <>
      <div className="toggle">
        {['', ...STATES].map((s) => (
          <button key={s} type="button" className={s === state ? 'on' : ''} onClick={() => setState(s)}>
            {s || 'all'}
          </button>
        ))}
      </div>
      <Loading data={jobs.data} error={jobs.error}>
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Job</th>
              <th>Batch</th>
              <th>Job type</th>
              <th>State</th>
              <th className="num">Attempts</th>
              <th>Depends on</th>
              <th>Last run</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.id}>
                <td>{j.ref ?? <span className="mono muted">{shortId(j.id)}</span>}</td>
                <td className="mono muted">{j.batch ? shortId(j.batch) : '—'}</td>
                <td>{j.jobType}</td>
                <td>
                  <span className={`pill ${j.state}`}>{j.state}</span>
                </td>
                <td className="num">{j.attempts}</td>
                <td>{j.dependsOn.length > 0 ? j.dependsOn.join(', ') : <span className="muted">—</span>}</td>
                <td>
                  <a href={`#/run/${j.lastRun.id}`} className="mono">
                    {shortId(j.lastRun.id)}
                  </a>{' '}
                  <Badge tone={runTone(j.lastRun.state)} notes={[j.lastRun.failureClass]}>
                    {j.lastRun.state}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="muted">No jobs match.</p> : null}
        <Pager page={pages.page} onNewer={pages.newer} next={jobs.data?.nextCursor ?? null} onOlder={pages.older} />
      </Loading>
    </>
  )
}
