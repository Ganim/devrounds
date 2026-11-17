import type { MemberKind, PhaseState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { type Ctx, findProject, run } from './resolve.ts'
import { phaseProgress, type TaskState } from './rules.ts'

// Read side of planning. Every type here is plain JSON (dates as ISO strings): the HTTP API returns it as is and the
// CLI and web view render it, so keys are a contract; add keys, never rename them.

export type CriterionView = {
  position: number // 1-based, insertion order within its task or phase
  text: string
  checked: boolean
  checkedAt: string | null
  checkedBy: string | null // member name
  evidence: string | null
}

export type LinkView = { kind: string; ref: string; title: string | null }

export type TaskView = {
  key: string
  title: string
  description: string
  state: TaskState
  assignee: string | null // member name
  estimateHours: number | null
  parent: string | null // task key
  blockedBy: string[] // task keys, sorted
  startedAt: string | null
  finishedAt: string | null
  version: number
  criteria: CriterionView[]
  links: LinkView[]
}

export type PhaseView = {
  key: string
  title: string
  goal: string
  position: number
  state: PhaseState
  deliveredAt: string | null
  deliveredBy: string | null // member name
  progress: ReturnType<typeof phaseProgress>
  blockedBy: string[] // phase keys, sorted
  criteria: CriterionView[]
  links: LinkView[]
  tasks: TaskView[] // sorted by key
}

export type PlanView = {
  project: { key: string; name: string }
  phases: PhaseView[] // sorted by position
  unphased: TaskView[] // tasks without a phase, sorted by key
}

export type EventView = {
  id: string // bigint as string; events are ordered by it
  kind: string
  actor: string // member name
  actorKind: MemberKind
  taskKey: string | null
  phaseKey: string | null
  reason: string | null
  data: unknown
  at: string
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

function groupBy<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    if (k !== null) map.set(k, [...(map.get(k) ?? []), row])
  }
  return map
}

export function getPlan(ctx: Ctx, projectKey: string): Promise<PlanView> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const phases = await trx
      .selectFrom('phases as p')
      .leftJoin('members as m', 'm.id', 'p.delivered_by')
      .select([
        'p.id',
        'p.key',
        'p.title',
        'p.goal',
        'p.position',
        'p.state',
        'p.delivered_at',
        'm.name as deliveredBy',
      ])
      .where('p.project_id', '=', project.id)
      .orderBy('p.position')
      .orderBy('p.key')
      .execute()
    const phaseDeps = await trx
      .selectFrom('phase_dependencies as d')
      .innerJoin('phases as p', 'p.id', 'd.phase_id')
      .innerJoin('phases as b', 'b.id', 'd.blocked_by_phase_id')
      .select(['d.phase_id as owner', 'b.key'])
      .where('p.project_id', '=', project.id)
      .orderBy('b.key')
      .execute()
    const tasks = await trx
      .selectFrom('tasks as t')
      .leftJoin('members as m', 'm.id', 't.assignee_id')
      .leftJoin('tasks as parent', 'parent.id', 't.parent_id')
      .select([
        't.id',
        't.key',
        't.title',
        't.description',
        't.state',
        't.phase_id',
        't.estimate_hours',
        't.started_at',
        't.finished_at',
        't.version',
        'm.name as assignee',
        'parent.key as parent',
      ])
      .where('t.project_id', '=', project.id)
      .orderBy('t.key')
      .execute()
    const taskDeps = await trx
      .selectFrom('task_dependencies as d')
      .innerJoin('tasks as t', 't.id', 'd.task_id')
      .innerJoin('tasks as b', 'b.id', 'd.blocked_by_task_id')
      .select(['d.task_id as owner', 'b.key'])
      .where('t.project_id', '=', project.id)
      .orderBy('b.key')
      .execute()
    const criteria = await trx
      .selectFrom('criteria as c')
      .leftJoin('tasks as t', 't.id', 'c.task_id')
      .leftJoin('phases as p', 'p.id', 'c.phase_id')
      .leftJoin('members as m', 'm.id', 'c.checked_by')
      .select(['c.task_id', 'c.phase_id', 'c.position', 'c.text', 'c.checked_at', 'c.evidence', 'm.name as checkedBy'])
      .where((eb) => eb.or([eb('t.project_id', '=', project.id), eb('p.project_id', '=', project.id)]))
      .orderBy('c.position')
      .execute()
    const links = await trx
      .selectFrom('links as l')
      .leftJoin('tasks as t', 't.id', 'l.task_id')
      .leftJoin('phases as p', 'p.id', 'l.phase_id')
      .select(['l.task_id', 'l.phase_id', 'l.kind', 'l.ref', 'l.title'])
      .where((eb) => eb.or([eb('t.project_id', '=', project.id), eb('p.project_id', '=', project.id)]))
      .orderBy('l.kind')
      .orderBy('l.ref')
      .execute()

    const criterionView = (c: (typeof criteria)[number]): CriterionView => ({
      position: c.position,
      text: c.text,
      checked: c.checked_at !== null,
      checkedAt: iso(c.checked_at),
      checkedBy: c.checkedBy,
      evidence: c.evidence,
    })
    const linkView = (l: (typeof links)[number]): LinkView => ({ kind: l.kind, ref: l.ref, title: l.title })
    const criteriaOf = { task: groupBy(criteria, (c) => c.task_id), phase: groupBy(criteria, (c) => c.phase_id) }
    const linksOf = { task: groupBy(links, (l) => l.task_id), phase: groupBy(links, (l) => l.phase_id) }
    const taskBlockers = groupBy(taskDeps, (d) => d.owner)
    const phaseBlockers = groupBy(phaseDeps, (d) => d.owner)

    const taskViews = tasks.map((t) => ({
      phaseId: t.phase_id,
      view: {
        key: t.key,
        title: t.title,
        description: t.description,
        state: t.state,
        assignee: t.assignee,
        estimateHours: t.estimate_hours === null ? null : Number(t.estimate_hours),
        parent: t.parent,
        blockedBy: (taskBlockers.get(t.id) ?? []).map((d) => d.key),
        startedAt: iso(t.started_at),
        finishedAt: iso(t.finished_at),
        version: t.version,
        criteria: (criteriaOf.task.get(t.id) ?? []).map(criterionView),
        links: (linksOf.task.get(t.id) ?? []).map(linkView),
      } satisfies TaskView,
    }))
    const tasksOf = groupBy(taskViews, (t) => t.phaseId)

    return {
      project: { key: project.key, name: project.name },
      phases: phases.map((p) => {
        const phaseTasks = (tasksOf.get(p.id) ?? []).map((t) => t.view)
        return {
          key: p.key,
          title: p.title,
          goal: p.goal,
          position: p.position,
          state: p.state,
          deliveredAt: iso(p.delivered_at),
          deliveredBy: p.deliveredBy,
          progress: phaseProgress(phaseTasks.map((t) => t.state)),
          blockedBy: (phaseBlockers.get(p.id) ?? []).map((d) => d.key),
          criteria: (criteriaOf.phase.get(p.id) ?? []).map(criterionView),
          links: (linksOf.phase.get(p.id) ?? []).map(linkView),
          tasks: phaseTasks,
        }
      }),
      unphased: taskViews.filter((t) => t.phaseId === null).map((t) => t.view),
    }
  })
}

export function listEvents(
  ctx: Ctx,
  projectKey: string,
  opts: { afterId?: string; limit: number },
): Promise<EventView[]> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000) {
    fail('DR101', { path: '/limit', reason: 'must be an integer from 1 to 1000' })
  }
  if (opts.afterId !== undefined && !/^\d+$/.test(opts.afterId)) {
    fail('DR101', { path: '/afterId', reason: 'must be an event id' })
  }
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    let query = trx
      .selectFrom('plan_events as e')
      .innerJoin('members as m', 'm.id', 'e.actor_id')
      .leftJoin('tasks as t', 't.id', 'e.task_id')
      .leftJoin('phases as p', 'p.id', 'e.phase_id')
      .select([
        'e.id',
        'e.kind',
        'm.name as actor',
        'm.kind as actorKind',
        't.key as taskKey',
        'p.key as phaseKey',
        'e.reason',
        'e.data',
        'e.at',
      ])
      .where('e.project_id', '=', project.id)
    if (opts.afterId !== undefined) query = query.where('e.id', '>', opts.afterId)
    const rows = await query.orderBy('e.id').limit(opts.limit).execute()
    return rows.map((row) => ({ ...row, at: row.at.toISOString() }))
  })
}
