import { type MachineJson, useRemote } from './api.ts'
import { formatBytes } from './format.ts'
import { Loading, when } from './ui.tsx'

// Room is what the scheduler can still place on the machine: free − reserve − reserved (scheduler/scheduler.ts).
const room = (m: MachineJson): number | null =>
  m.freeBytes === null || m.reserveBytes === null ? null : m.freeBytes - m.reserveBytes - m.reservedBytes

export function MachinesPage() {
  const machines = useRemote<MachineJson[]>('/api/machines', { absolute: true })
  const rows = machines.data ?? []
  return (
    <Loading data={machines.data} error={machines.error}>
      <table>
        <thead>
          <tr>
            <th>Machine</th>
            <th>Session</th>
            <th>OS / executor</th>
            <th className="num">Free</th>
            <th className="num">Reserved</th>
            <th className="num">Reserve</th>
            <th className="num">Room</th>
            <th>Report at</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>
                <strong>{m.name}</strong>
              </td>
              <td>
                <span className={`pill ${m.connected ? 'running' : 'offline'}`}>
                  {m.connected ? 'connected' : 'offline'}
                </span>
              </td>
              <td className="muted">
                {m.os} · {m.executorVersion}
              </td>
              <td className="num">{formatBytes(m.freeBytes)}</td>
              <td className="num">{formatBytes(m.reservedBytes)}</td>
              <td className="num">{formatBytes(m.reserveBytes)}</td>
              <td className="num">{formatBytes(room(m))}</td>
              <td className="muted">{m.reportAt ? when(m.reportAt) : 'no report yet'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="muted">No machines paired.</p> : null}
    </Loading>
  )
}
