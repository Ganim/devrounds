import { useQueues } from '../../data/resources.ts'
import { formatDuration } from '../../lib/format.ts'
import { Loading } from '../../ui/index.ts'

export function QueuesPage() {
  const queues = useQueues()
  const rows = queues.data ?? []
  // Ages are from this render; the 10 s poll moves them along.
  const now = Date.now()
  return (
    <Loading data={queues.data} error={queues.error}>
      <table>
        <thead>
          <tr>
            <th>Queue</th>
            <th className="num">Priority</th>
            <th className="num">Concurrency</th>
            <th className="num">Per machine</th>
            <th>Job types</th>
            <th className="num">Queued</th>
            <th className="num">In flight</th>
            <th className="num">Oldest wait</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.key}>
              <td>
                <a href={`#/runs?queue=${encodeURIComponent(q.key)}`}>
                  <strong>{q.key}</strong>
                </a>
              </td>
              <td className="num">{q.priority}</td>
              <td className="num">{q.concurrency ?? 'no cap'}</td>
              <td className="num">{q.machineConcurrency ?? 'no cap'}</td>
              <td>{q.jobTypes.length > 0 ? q.jobTypes.join(', ') : <span className="muted">any</span>}</td>
              <td className="num">{q.depth}</td>
              <td className="num">{q.inFlight}</td>
              <td className="num">
                {formatDuration(q.oldestQueuedAt ? now - new Date(q.oldestQueuedAt).getTime() : null)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="muted">No queues yet; the default queue appears with the first job.</p> : null}
    </Loading>
  )
}
