import { useState } from 'react'
import type { IndicatorRow } from '../../data/contract.ts'
import { useBalance, useIndicators, useIndicatorsNow } from '../../data/resources.ts'
import { formatBytes, formatDuration } from '../../lib/format.ts'
import { Loading } from '../../ui/index.ts'

export function BalancePage() {
  const [period, setPeriod] = useState<'day' | 'week'>('day')
  const balance = useBalance(period)
  const rows = [...(balance.data ?? [])].reverse()
  const maxDone = Math.max(1, ...rows.map((r) => r.done))
  const maxHours = Math.max(1, ...rows.map((r) => r.hoursInProgress))
  return (
    <>
      <div className="toggle">
        {(['day', 'week'] as const).map((p) => (
          <button key={p} type="button" className={p === period ? 'on' : ''} onClick={() => setPeriod(p)}>
            {p === 'day' ? 'Daily' : 'Weekly'}
          </button>
        ))}
      </div>
      <Loading data={balance.data} error={balance.error}>
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>{period === 'day' ? 'Day' : 'Week of (Monday)'}</th>
              <th className="num">Done</th>
              <th style={{ width: '22%' }} />
              <th className="num">Opened</th>
              <th className="num">Cancelled</th>
              <th className="num">Hours in progress</th>
              <th style={{ width: '22%' }} />
              <th className="num">Avg cycle (h)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.periodStart}>
                <td>{r.periodStart}</td>
                <td className="num">{r.done}</td>
                <td>
                  <div className="hbar done" style={{ width: `${(100 * r.done) / maxDone}%` }} />
                </td>
                <td className="num">{r.opened}</td>
                <td className="num">{r.cancelled}</td>
                <td className="num">{r.hoursInProgress}</td>
                <td>
                  <div className="hbar" style={{ width: `${(100 * r.hoursInProgress) / maxHours}%` }} />
                </td>
                <td className="num">{r.avgCycleHours ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Loading>
      <RunsSection period={period} />
    </>
  )
}

const pair = (p50: number | null, p90: number | null) => `${formatDuration(p50)} / ${formatDuration(p90)}`
const classes = (r: IndicatorRow) =>
  Object.entries(r.failureClasses)
    .map(([failureClass, n]) => `${failureClass} ${n}`)
    .join(' · ')

// Runs that ended in each local period, by job type, then queues, machines and learned needs as they stand.
function RunsSection({ period }: { period: 'day' | 'week' }) {
  const indicators = useIndicators(period)
  const now = useIndicatorsNow()
  const rows = [...(indicators.data ?? [])].sort(
    (a, b) => b.period.localeCompare(a.period) || a.jobType.localeCompare(b.jobType),
  )
  return (
    <>
      <h2>Runs</h2>
      <Loading data={indicators.data} error={indicators.error}>
        <table>
          <thead>
            <tr>
              <th>{period === 'day' ? 'Day' : 'Week of (Monday)'}</th>
              <th>Job type</th>
              <th className="num">Runs</th>
              <th className="num">Failed</th>
              <th>Failure classes</th>
              <th className="num">Retries</th>
              <th className="num">Requeues</th>
              <th className="num">Queue wait p50 / p90</th>
              <th className="num">Admission p50</th>
              <th className="num">Run time p50 / p90</th>
              <th className="num">Peak p50 / max</th>
              <th className="num">CPU (s)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.period} ${r.jobType}`}>
                <td>{r.period}</td>
                <td>{r.jobType}</td>
                <td className="num">{r.runs}</td>
                <td className="num">{r.failed}</td>
                <td className="muted">{classes(r)}</td>
                <td className="num">{r.retries}</td>
                <td className="num">{r.requeues}</td>
                <td className="num">{pair(r.queueWaitP50Ms, r.queueWaitP90Ms)}</td>
                <td className="num">{formatDuration(r.admissionDelayP50Ms)}</td>
                <td className="num">{pair(r.runTimeP50Ms, r.runTimeP90Ms)}</td>
                <td className="num">
                  {formatBytes(r.peakP50Bytes)} / {formatBytes(r.peakMaxBytes)}
                </td>
                <td className="num">{r.cpuSeconds === null ? '—' : Number(r.cpuSeconds.toFixed(1))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="muted">No runs ended in this window.</p> : null}
      </Loading>
      <h2>Now</h2>
      <Loading data={now.data} error={now.error}>
        <table>
          <thead>
            <tr>
              <th>Queue</th>
              <th className="num">Depth</th>
              <th className="num">Oldest wait</th>
            </tr>
          </thead>
          <tbody>
            {now.data?.queues.map((q) => (
              <tr key={q.key}>
                <td>{q.key}</td>
                <td className="num">{q.depth}</td>
                <td className="num">{formatDuration(q.oldestWaitMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Machine</th>
              <th className="num">Free</th>
              <th className="num">Reserved</th>
              <th className="num">Reserve</th>
            </tr>
          </thead>
          <tbody>
            {now.data?.machines.map((m) => (
              <tr key={m.name}>
                <td>{m.name}</td>
                <td className="num">{formatBytes(m.freeBytes)}</td>
                <td className="num">{formatBytes(m.reservedBytes)}</td>
                <td className="num">{formatBytes(m.reserveBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Learned need: job type</th>
              <th>Machine</th>
              <th className="num">Need</th>
              <th className="num">Samples</th>
            </tr>
          </thead>
          <tbody>
            {now.data?.learnedNeeds.map((n) => (
              <tr key={`${n.jobType} ${n.machine}`}>
                <td>{n.jobType}</td>
                <td>{n.machine}</td>
                <td className="num">{formatBytes(n.needBytes)}</td>
                <td className="num">{n.samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Loading>
    </>
  )
}
