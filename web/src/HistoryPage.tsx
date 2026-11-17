import { type EventView, useRemote } from './api.ts'
import { Loading, when } from './ui.tsx'

// The API pages oldest first with a 500 cap; the view shows the newest of that page on top. A longer history needs
// a cursor in the UI, which P0 does not have.
export function HistoryPage() {
  const events = useRemote<EventView[]>('/events?limit=500')
  const rows = [...(events.data ?? [])].reverse()
  return (
    <Loading data={events.data} error={events.error}>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Kind</th>
            <th>Target</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="muted">{when(e.at)}</td>
              <td>
                {e.actor} <span className="muted">({e.actorKind})</span>
              </td>
              <td>{e.kind}</td>
              <td>{e.taskKey ?? e.phaseKey ?? ''}</td>
              <td>{e.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="muted">No events yet.</p> : null}
    </Loading>
  )
}
