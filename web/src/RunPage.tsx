import { useEffect, useRef, useState } from 'react'
import { type ApiError, type LogPageJson, projectUrl, type RunJson, request, useRemote } from './api.ts'
import { formatBytes, formatDuration } from './format.ts'
import { RunState } from './RunsPage.tsx'
import { ErrorBox, Loading, when } from './ui.tsx'

const ENDED = ['finished', 'failed', 'stopped', 'orphaned', 'skipped']

// Outcome and failure summary first, then timeline, durations, resources, steps, delays, and the log last: the same
// order as `devrounds run show`.
export function RunPage({ runId }: { runId: string }) {
  const run = useRemote<RunJson>(`/runs/${encodeURIComponent(runId)}`)
  const r = run.data
  return (
    <Loading data={r} error={run.error}>
      {r ? (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>
              <RunState state={r.state} failureClass={r.outcome.failureClass} /> <span className="mono">{r.id}</span>
            </h2>
            <div>
              {r.jobType} · queue {r.queue} · on {r.machine ?? 'no machine yet'} · attempt {r.attempt} ({r.cause})
              {r.task ? ` · task ${r.task}` : ''}
              {r.outcome.exitCode === null ? '' : ` · exit ${r.outcome.exitCode}`}
            </div>
            {r.outcome.failureSummary ? <pre className="summary">{r.outcome.failureSummary}</pre> : null}
            {r.state === 'queued' && new Date(r.notBefore).getTime() > Date.now() ? (
              <div className="muted">not placed before {when(r.notBefore)}</div>
            ) : null}
          </div>

          <h2>Timeline and durations</h2>
          <table>
            <tbody>
              <Row label="Queued" value={when(r.timeline.queuedAt)} />
              <Row label="Offered" value={when(r.timeline.offeredAt)} />
              <Row label="Admitted" value={when(r.timeline.admittedAt)} />
              <Row label="Started" value={when(r.timeline.startedAt)} />
              <Row label="Finished" value={when(r.timeline.finishedAt)} />
              <Row label="Queue wait" value={formatDuration(r.durations.queueWaitMs)} />
              <Row label="Admission delay" value={formatDuration(r.durations.admissionDelayMs)} />
              <Row label="Run time" value={formatDuration(r.durations.runTimeMs)} />
              <Row label="Total" value={formatDuration(r.durations.totalMs)} />
            </tbody>
          </table>

          <h2>Resources</h2>
          <table>
            <tbody>
              <Row label="Peak private" value={formatBytes(r.resources.peak)} />
              <Row
                label="p95 / p50 private"
                value={`${formatBytes(r.resources.p95)} / ${formatBytes(r.resources.p50)}`}
              />
              <Row label="CPU" value={r.resources.cpuSeconds === null ? '—' : `${r.resources.cpuSeconds} s`} />
              <Row label="Processes swept" value={String(r.resources.swept ?? '—')} />
              <Row label="Visible windows" value={String(r.resources.visibleWindows ?? '—')} />
            </tbody>
          </table>

          {r.steps.length > 0 ? (
            <>
              <h2>Steps</h2>
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Step</th>
                    <th>Outcome</th>
                    <th>Started</th>
                    <th className="num">Took</th>
                  </tr>
                </thead>
                <tbody>
                  {r.steps.map((s) => (
                    <tr key={s.step}>
                      <td className="num">{s.step}</td>
                      <td>{s.name}</td>
                      <td>
                        <RunState state={s.outcome ?? 'running'} />
                      </td>
                      <td className="muted">{when(s.startedAt)}</td>
                      <td className="num">
                        {formatDuration(
                          s.finishedAt ? new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime() : null,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          {r.delays.length > 0 ? (
            <>
              <h2>Admission delays</h2>
              <table>
                <thead>
                  <tr>
                    <th>At</th>
                    <th>Reason</th>
                    <th className="num">Position</th>
                    <th className="num">Need</th>
                    <th className="num">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {r.delays.map((d) => (
                    <tr key={`${d.at}-${d.position}`}>
                      <td className="muted">{when(d.at)}</td>
                      <td>{d.reason}</td>
                      <td className="num">{d.position}</td>
                      <td className="num">{formatBytes(d.needBytes)}</td>
                      <td className="num">{formatBytes(d.availableBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          <h2>Log</h2>
          <RunLog key={r.id} runId={r.id} ended={ENDED.includes(r.state)} />
        </>
      ) : null}
    </Loading>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <th style={{ width: '25%' }}>{label}</th>
      <td>{value || '—'}</td>
    </tr>
  )
}

const logPage = (runId: string, cursor: number | null): Promise<LogPageJson> =>
  request<LogPageJson>(
    projectUrl(`/runs/${encodeURIComponent(runId)}/logs${cursor === null ? '' : `?cursor=${cursor}`}`),
  )

// The first log page, then one more page per "more" (GET /runs/:id/logs?cursor=<nextCursor>). Not polled: a running
// run's output grows, so its last page offers "more" again from the line after the last one shown.
function RunLog({ runId, ended }: { runId: string; ended: boolean }) {
  const [lines, setLines] = useState<LogPageJson['lines']>([])
  const [next, setNext] = useState<number | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  // A new object per ask, so asking again from the same seq (a running run with nothing new yet) fetches again.
  const [ask, setAsk] = useState<{ cursor: number | null }>({ cursor: null })

  // `cursor` null: the first page, replacing what is shown; otherwise the page from that seq, appended.
  useEffect(() => {
    const { cursor } = ask
    let live = true
    setLoading(true)
    logPage(runId, cursor).then(
      (page) => {
        if (!live) return
        setLines((shown) => (cursor === null ? page.lines : [...shown, ...page.lines]))
        setNext(page.nextCursor)
        setError(null)
        setLoading(false)
      },
      (err: ApiError) => {
        if (!live) return
        setError(err)
        setLoading(false)
      },
    )
    return () => {
      live = false
    }
  }, [runId, ask])

  const last = lines.at(-1)
  const lastSeq = useRef<number | null>(null)
  lastSeq.current = last?.seq ?? null
  // The run ended after the last fetch: its last lines (often the error) came since, and once it has ended "more"
  // is no longer offered, so they are fetched once, from the line after the last one shown.
  const wasEnded = useRef(ended)
  useEffect(() => {
    if (ended && !wasEnded.current) setAsk({ cursor: lastSeq.current === null ? null : lastSeq.current + 1 })
    wasEnded.current = ended
  }, [ended])

  // A running run has no nextCursor once everything stored is shown; its next lines start after the last seq shown.
  const more = next ?? (ended ? null : last ? last.seq + 1 : 0)
  return (
    <>
      <ErrorBox error={error} />
      {lines.length > 0 ? (
        <pre className="log">{lines.map((line) => line.text).join('\n')}</pre>
      ) : (
        <p className="muted">{loading ? 'Loading...' : 'No output yet.'}</p>
      )}
      {more !== null ? (
        <button type="button" className="link" disabled={loading} onClick={() => setAsk({ cursor: more })}>
          more
        </button>
      ) : null}
    </>
  )
}
