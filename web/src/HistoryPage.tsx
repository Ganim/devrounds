import { type EventView, useRemote } from './api.ts'
import { Loading, when } from './ui.tsx'

// The newest 200 events; older history has no UI in P0.
export function HistoryPage() {
  const events = useRemote<EventView[]>('/events?order=desc&limit=200')
  const rows = events.data ?? []
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
