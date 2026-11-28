import { useEvents } from '../../data/resources.ts'
import { when } from '../../lib/format.ts'
import { Loading } from '../../ui/index.ts'

// The newest 200 events; older history has no UI in P0.
export function HistoryPage() {
  const events = useEvents(new URLSearchParams({ order: 'desc', limit: '200' }))
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
