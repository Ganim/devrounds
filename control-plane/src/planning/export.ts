import { stringify } from 'yaml'
import type { PlanFile, PlanFileCriterion, PlanFileTask } from './plan-file.ts'
import { type Ctx, run } from './resolve.ts'
import { type CriterionView, getPlan, type LinkView, type TaskView } from './view.ts'

const criteriaOf = (criteria: CriterionView[]): PlanFileCriterion[] =>
  criteria.map((c) => (c.evidence === null ? c.text : { text: c.text, evidence: c.evidence }))

const linksOf = (links: LinkView[]) =>
  links.length === 0
    ? {}
    : { links: links.map((l) => ({ kind: l.kind, ref: l.ref, ...(l.title !== null && { title: l.title }) })) }

// The current plan as a plan file that importPlan takes back as a no-op: optional fields appear only when set, and
// blocked/cancelled carry the reason of the task's latest transition. Tasks without a phase go in the top-level
// `tasks:`.
export function exportPlan(ctx: Ctx, projectKey: string): Promise<string> {
  return run(ctx, async (trx) => {
    const plan = await getPlan({ ...ctx, trx }, projectKey)
    const latest = await trx
      .selectFrom('plan_events as e')
      .innerJoin('projects as p', 'p.id', 'e.project_id')
      .innerJoin('tasks as t', 't.id', 'e.task_id')
      .select(['t.key', 'e.reason'])
      .distinctOn('e.task_id')
      .where('p.key', '=', projectKey)
      .where('e.kind', '=', 'transition')
      .orderBy('e.task_id')
      .orderBy('e.id', 'desc')
      .execute()
    const reasons = new Map(latest.map((row) => [row.key, row.reason]))

    const task = (t: TaskView): PlanFileTask => {
      const reason = t.state === 'blocked' || t.state === 'cancelled' ? reasons.get(t.key) : null
      return {
        key: t.key,
        title: t.title,
        ...(t.description !== '' && { description: t.description }),
        ...(t.assignee !== null && { assignee: t.assignee }),
        ...(t.estimateHours !== null && { estimate_hours: t.estimateHours }),
        ...(t.parent !== null && { parent: t.parent }),
        ...(t.blockedBy.length > 0 && { blocked_by: t.blockedBy }),
        ...(t.criteria.length > 0 && { criteria: criteriaOf(t.criteria) }),
        ...linksOf(t.links),
        ...(t.state !== 'todo' && { state: t.state }),
        ...(reason && { reason }),
      }
    }
    const file: PlanFile = {
      project: plan.project,
      ...(plan.unphased.length > 0 && { tasks: plan.unphased.map(task) }),
      phases: plan.phases.map((p) => ({
        key: p.key,
        title: p.title,
        goal: p.goal,
        ...(p.state === 'delivered' && { state: 'delivered' as const }),
        ...(p.blockedBy.length > 0 && { blocked_by: p.blockedBy }),
        ...(p.criteria.length > 0 && { criteria: criteriaOf(p.criteria) }),
        ...linksOf(p.links),
        tasks: p.tasks.map(task),
      })),
    }
    return stringify(file, { lineWidth: 0 })
  })
}
