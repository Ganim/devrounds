import type { PlanView } from '../../data/contract.ts'
import type { Remote } from '../../data/resources.ts'
import { Loading } from '../../ui/index.ts'
import { StackedBar, StatePill } from './TaskState.tsx'

export function Roadmap({ plan }: { plan: PlanView }) {
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Phase</th>
            <th>State</th>
            <th>Progress</th>
            <th className="num">%</th>
            <th>Done / total</th>
            <th>Blocked by</th>
          </tr>
        </thead>
        <tbody>
          {plan.phases.map((p) => (
            <tr key={p.key}>
              <td>
                <a href={`#/phase/${p.key}`}>
                  <strong>{p.key}</strong> {p.title}
                </a>
              </td>
              <td>
                <StatePill state={p.state} />
              </td>
              <td style={{ minWidth: 180 }}>
                <StackedBar progress={p.progress} />
              </td>
              <td className="num">{p.progress.percent}%</td>
              <td className="muted">
                {p.progress.done}/{p.progress.total}
                {p.progress.inProgress > 0 ? `, ${p.progress.inProgress} in progress` : ''}
                {p.progress.blocked > 0 ? `, ${p.progress.blocked} blocked` : ''}
                {p.progress.cancelled > 0 ? `, ${p.progress.cancelled} cancelled` : ''}
              </td>
              <td>
                {p.blockedBy.length === 0
                  ? ''
                  : p.blockedBy.map((k) => (
                      <a key={k} href={`#/phase/${k}`} style={{ marginRight: 8 }}>
                        {k}
                      </a>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan.unphased.length > 0 ? <p className="muted">{plan.unphased.length} tasks have no phase.</p> : null}
    </>
  )
}

export function RoadmapPage({ plan }: { plan: Remote<PlanView> }) {
  return (
    <Loading data={plan.data} error={plan.error}>
      {plan.data ? <Roadmap plan={plan.data} /> : null}
    </Loading>
  )
}
