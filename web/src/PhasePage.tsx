import type { CriterionView, LinkView, PlanView, Remote, TaskView } from './api.ts'
import { DependencyGraph } from './DependencyGraph.tsx'
import { Loading, Pill, StackedBar, when } from './ui.tsx'

function Criteria({ items }: { items: CriterionView[] }) {
  if (items.length === 0) return <p className="muted">No exit criteria.</p>
  return (
    <ul className="plain">
      {items.map((c) => (
        <li key={c.position} style={{ marginBottom: 6 }}>
          {c.checked ? '[x]' : '[ ]'} {c.text}
          {c.checked ? (
            <div className="evidence">
              {c.evidence} {c.checkedBy ? `by ${c.checkedBy}` : ''} {when(c.checkedAt)}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function Links({ items }: { items: LinkView[] }) {
  if (items.length === 0) return null
  return (
    <ul className="plain">
      {items.map((l) => (
        <li key={`${l.kind}:${l.ref}`}>
          <span className="muted">{l.kind}</span>{' '}
          {/^https?:\/\//.test(l.ref) ? (
            <a href={l.ref} target="_blank" rel="noreferrer">
              {l.title ?? l.ref}
            </a>
          ) : (
            <span>
              {l.title ? `${l.title} ` : ''}
              <span className="evidence">{l.ref}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function TaskRows({ tasks }: { tasks: TaskView[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Task</th>
          <th>State</th>
          <th>Assignee</th>
          <th className="num">Criteria</th>
          <th>Blocked by</th>
          <th>Parent</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((t) => (
          <tr key={t.key}>
            <td>
              <strong>{t.key}</strong> {t.title}
              {t.criteria
                .filter((c) => c.checked && c.evidence)
                .map((c) => (
                  <div key={c.position} className="evidence">
                    {c.evidence}
                  </div>
                ))}
              <Links items={t.links} />
            </td>
            <td>
              <Pill state={t.state} />
            </td>
            <td>{t.assignee ?? ''}</td>
            <td className="num">
              {t.criteria.filter((c) => c.checked).length}/{t.criteria.length}
            </td>
            <td>{t.blockedBy.join(', ')}</td>
            <td>{t.parent ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function PhasePage({ phaseKey, plan }: { phaseKey: string; plan: Remote<PlanView> }) {
  const phase = plan.data?.phases.find((p) => p.key === phaseKey)
  return (
    <Loading data={plan.data} error={plan.error}>
      {phase ? (
        <>
          <p>
            <a href="#/">Roadmap</a> / <strong>{phase.key}</strong> {phase.title} <Pill state={phase.state} />
          </p>
          <p>{phase.goal}</p>
          <div style={{ maxWidth: 420 }}>
            <StackedBar progress={phase.progress} />
          </div>
          <p className="muted">
            {phase.progress.percent}% done, {phase.progress.done}/{phase.progress.total} tasks
            {phase.blockedBy.length > 0 ? `, blocked by ${phase.blockedBy.join(', ')}` : ''}
            {phase.deliveredAt ? `, delivered ${when(phase.deliveredAt)} by ${phase.deliveredBy}` : ''}
          </p>
          <h2>Exit criteria</h2>
          <Criteria items={phase.criteria} />
          <Links items={phase.links} />
          <h2>Tasks</h2>
          <TaskRows tasks={phase.tasks} />
          <h2>Dependencies</h2>
          <DependencyGraph tasks={phase.tasks} />
        </>
      ) : (
        <p>
          No phase {phaseKey}. <a href="#/">Back to the roadmap</a>
        </p>
      )}
    </Loading>
  )
}
