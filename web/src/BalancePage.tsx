import { useState } from 'react'
import { type BalanceRow, useRemote } from './api.ts'
import { Loading } from './ui.tsx'

export function BalancePage() {
  const [period, setPeriod] = useState<'day' | 'week'>('day')
  const balance = useRemote<BalanceRow[]>(`/balance?period=${period}`)
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
    </>
  )
}
