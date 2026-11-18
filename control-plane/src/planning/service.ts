import { sql } from 'kysely'
import { DevRoundsError, fail } from '../errors/error.ts'
import {
  type Ctx,
  findCriterion,
  findMember,
  findPhase,
  findProject,
  findTarget,
  findTask,
  type Lock,
  lockPhases,
  type PhaseRow,
  run,
  type Target,
  type Trx,
} from './resolve.ts'
import { checkPhaseClose, checkTransition, isBlockerOpen, type TaskState, wouldCycle } from './rules.ts'

export type { Actor, Ctx } from './resolve.ts'

export type Mutation = { eventId: string }
// `delivered` is the key of the phase this call delivered automatically, or null.
export type DeliveringMutation = Mutation & { delivered: string | null }

// Also the plan file schema pattern, so a bad evidence string fails at parse time with its line and column.
export const EVIDENCE = /^(commit:[0-9a-f]{7,40}|gate:\S+|url:https?:\/\/\S+|note:.+)$/

function requireReason(reason: string | undefined): void {
  if (reason === undefined || reason.trim() === '') fail('DR101', { path: '/reason', reason: 'a reason is required' })
}

function requireNewKey(exists: unknown, kind: string, key: string): void {
  if (exists) fail('DR101', { path: '/key', reason: `${kind} ${key} already exists` })
}

// Two calls adding the same key at once both pass requireNewKey; the second then hits the unique index (23505).
async function insertKeyed<T>(kind: string, key: string, insert: () => Promise<T>): Promise<T> {
  try {
    return await insert()
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === '23505') requireNewKey(true, kind, key)
    throw err
  }
}

// A delivered phase accepts no open work; closing it again or reopening an open phase is the same conflict.
function phaseConflict(phase: { key: string; state: string }): never {
  return fail('DR306', { phase: phase.key, state: phase.state })
}

async function record(
  trx: Trx,
  ctx: Ctx,
  e: {
    projectId: string
    taskId?: string | null
    phaseId?: string | null
    kind: string
    reason?: string
    data: object
  },
): Promise<string> {
  const row = await trx
    .insertInto('plan_events')
    .values({
      tenant_id: ctx.tenantId,
      project_id: e.projectId,
      task_id: e.taskId ?? null,
      phase_id: e.phaseId ?? null,
      actor_id: ctx.actor.id,
      kind: e.kind,
      reason: e.reason ?? null,
      data: JSON.stringify(e.data),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

async function insertCriteria(
  trx: Trx,
  ctx: Ctx,
  owner: { taskId: string | null; phaseId: string | null },
  texts: string[],
): Promise<void> {
  if (texts.length === 0) return
  const ownerColumn = owner.taskId ? 'task_id' : 'phase_id'
  const ownerId = (owner.taskId ?? owner.phaseId) as string
  const last = await trx
    .selectFrom('criteria')
    .select((eb) => eb.fn.max('position').as('max'))
    .where(ownerColumn, '=', ownerId)
    .executeTakeFirst()
  const start = last?.max ?? 0
  await trx
    .insertInto('criteria')
    .values(
      texts.map((text, index) => ({
        tenant_id: ctx.tenantId,
        task_id: owner.taskId,
        phase_id: owner.phaseId,
        position: start + index + 1,
        text,
      })),
    )
    .execute()
}

// Positions stay 1..n: the caller passes the full order and only rows whose position changed are written.
async function renumberPhases(trx: Trx, ids: string[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await trx
      .updateTable('phases')
      .set({ position: index + 1 })
      .where('id', '=', id)
      .where('position', '<>', index + 1)
      .execute()
  }
}

async function phaseIdsInOrder(trx: Trx, projectId: string, except?: string): Promise<string[]> {
  let query = trx.selectFrom('phases').select('id').where('project_id', '=', projectId)
  if (except) query = query.where('id', '<>', except)
  const rows = await query.orderBy('position').orderBy('key').execute()
  return rows.map((row) => row.id)
}

function requirePosition(position: number | undefined): void {
  if (position !== undefined && (!Number.isInteger(position) || position < 1)) {
    fail('DR101', { path: '/position', reason: 'must be an integer of at least 1' })
  }
}

// A position past the end appends.
function insertAt(ids: string[], id: string, position: number | undefined): string[] {
  const index = position === undefined ? ids.length : Math.min(position - 1, ids.length)
  return [...ids.slice(0, index), id, ...ids.slice(index)]
}

async function closeState(trx: Trx, phaseId: string) {
  const tasks = await trx.selectFrom('tasks').select('state').where('phase_id', '=', phaseId).execute()
  const open = await trx
    .selectFrom('criteria')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('phase_id', '=', phaseId)
    .where('checked_at', 'is', null)
    .executeTakeFirstOrThrow()
  return { states: tasks.map((t) => t.state), openCriteria: Number(open.count) }
}

async function deliver(trx: Trx, ctx: Ctx, projectId: string, phaseId: string, data: object): Promise<string> {
  await trx
    .updateTable('phases')
    .set({ state: 'delivered', delivered_at: sql<Date>`now()`, delivered_by: ctx.actor.id })
    .where('id', '=', phaseId)
    .execute()
  return record(trx, ctx, { projectId, phaseId, kind: 'deliver_phase', data })
}

// Delivers an open phase as soon as checkPhaseClose passes, so the cycle closes without a human. The phase lock makes
// two last tasks finishing at once deliver exactly once: the second waits, then reads the first's committed state.
async function deliverIfClosable(trx: Trx, ctx: Ctx, projectKey: string, projectId: string, phaseId: string | null) {
  if (!phaseId) return null
  const phase = await trx
    .selectFrom('phases')
    .select(['key', 'state'])
    .where('id', '=', phaseId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow()
  if (phase.state !== 'open') return null
  try {
    checkPhaseClose(await closeState(trx, phaseId))
  } catch (err) {
    if (err instanceof DevRoundsError && err.code === 'DR305') return null
    throw err
  }
  await deliver(trx, ctx, projectId, phaseId, { projectKey, phaseKey: phase.key, automatic: true })
  return phase.key
}

export function createProject(ctx: Ctx, i: { key: string; name: string }): Promise<Mutation & { projectId: string }> {
  return run(ctx, async (trx) => {
    const existing = await trx.selectFrom('projects').select('id').where('key', '=', i.key).executeTakeFirst()
    requireNewKey(existing, 'project', i.key)
    const { id } = await insertKeyed('project', i.key, () =>
      trx
        .insertInto('projects')
        .values({ tenant_id: ctx.tenantId, key: i.key, name: i.name })
        .returning('id')
        .executeTakeFirstOrThrow(),
    )
    const eventId = await record(trx, ctx, { projectId: id, kind: 'create_project', data: i })
    return { eventId, projectId: id }
  })
}

export function addPhase(
  ctx: Ctx,
  i: { projectKey: string; key: string; title: string; goal: string; position?: number; criteria?: string[] },
): Promise<Mutation> {
  return run(ctx, async (trx) => {
    requirePosition(i.position)
    const project = await findProject(trx, i.projectKey, { lock: true })
    const existing = await trx
      .selectFrom('phases')
      .select('id')
      .where('project_id', '=', project.id)
      .where('key', '=', i.key)
      .executeTakeFirst()
    requireNewKey(existing, 'phase', i.key)
    const order = await phaseIdsInOrder(trx, project.id)
    const { id } = await insertKeyed('phase', i.key, () =>
      trx
        .insertInto('phases')
        .values({
          tenant_id: ctx.tenantId,
          project_id: project.id,
          key: i.key,
          title: i.title,
          goal: i.goal,
          position: order.length + 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    )
    await renumberPhases(trx, insertAt(order, id, i.position))
    await insertCriteria(trx, ctx, { taskId: null, phaseId: id }, i.criteria ?? [])
    return { eventId: await record(trx, ctx, { projectId: project.id, phaseId: id, kind: 'add_phase', data: i }) }
  })
}

export function editPhase(
  ctx: Ctx,
  i: { projectKey: string; phaseKey: string; title?: string; goal?: string; reason: string },
): Promise<Mutation> {
  return run(ctx, async (trx) => {
    requireReason(i.reason)
    const project = await findProject(trx, i.projectKey)
    const phase = await findPhase(trx, project.id, i.phaseKey)
    const changes = { ...(i.title !== undefined && { title: i.title }), ...(i.goal !== undefined && { goal: i.goal }) }
    if (Object.keys(changes).length > 0)
      await trx.updateTable('phases').set(changes).where('id', '=', phase.id).execute()
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      phaseId: phase.id,
      kind: 'edit_phase',
      reason: i.reason,
      data: i,
    })
    return { eventId }
  })
}

export function movePhase(
  ctx: Ctx,
  i: { projectKey: string; phaseKey: string; position: number; reason: string },
): Promise<Mutation> {
  return run(ctx, async (trx) => {
    requireReason(i.reason)
    requirePosition(i.position)
    const project = await findProject(trx, i.projectKey, { lock: true })
    const phase = await findPhase(trx, project.id, i.phaseKey)
    const others = await phaseIdsInOrder(trx, project.id, phase.id)
    await renumberPhases(trx, insertAt(others, phase.id, i.position))
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      phaseId: phase.id,
      kind: 'move_phase',
      reason: i.reason,
      data: i,
    })
    return { eventId }
  })
}

type PhaseDependency = { projectKey: string; phaseKey: string; blockedByKey: string; reason?: string }

export function addPhaseDependency(ctx: Ctx, i: PhaseDependency): Promise<Mutation> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey, { lock: true })
    const phase = await findPhase(trx, project.id, i.phaseKey)
    const blocker = await findPhase(trx, project.id, i.blockedByKey)
    const edges = await trx
      .selectFrom('phase_dependencies as d')
      .innerJoin('phases as p', 'p.id', 'd.phase_id')
      .innerJoin('phases as b', 'b.id', 'd.blocked_by_phase_id')
      .select(['p.key as key', 'b.key as blockedBy'])
      .where('p.project_id', '=', project.id)
      .execute()
    if (edges.some((e) => e.key === phase.key && e.blockedBy === blocker.key)) {
      fail('DR101', { path: '/blockedByKey', reason: `${phase.key} is already blocked by ${blocker.key}` })
    }
    const pairs = edges.map((e): [string, string] => [e.key, e.blockedBy])
    if (wouldCycle(pairs, [phase.key, blocker.key])) fail('DR103', { key: phase.key, blockedBy: blocker.key })
    await trx
      .insertInto('phase_dependencies')
      .values({ tenant_id: ctx.tenantId, phase_id: phase.id, blocked_by_phase_id: blocker.id })
      .execute()
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      phaseId: phase.id,
      kind: 'add_phase_dependency',
      reason: i.reason,
      data: i,
    })
    return { eventId }
  })
}

export function removePhaseDependency(ctx: Ctx, i: PhaseDependency): Promise<Mutation> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    const phase = await findPhase(trx, project.id, i.phaseKey)
    const blocker = await findPhase(trx, project.id, i.blockedByKey)
    const removed = await trx
      .deleteFrom('phase_dependencies')
      .where('phase_id', '=', phase.id)
      .where('blocked_by_phase_id', '=', blocker.id)
      .executeTakeFirst()
    if (removed.numDeletedRows === 0n) {
      fail('DR201', { kind: 'dependency', key: `${phase.key} blocked by ${blocker.key}` })
    }
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      phaseId: phase.id,
      kind: 'remove_phase_dependency',
      reason: i.reason,
      data: i,
    })
    return { eventId }
  })
}

// Any member may close a phase; its one event is `deliver_phase`, the same kind automatic delivery writes.
export function closePhase(ctx: Ctx, i: { projectKey: string; phaseKey: string }): Promise<Mutation> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    const phase = await findPhase(trx, project.id, i.phaseKey, { lock: 'update' })
    if (phase.state === 'delivered') phaseConflict(phase)
    checkPhaseClose(await closeState(trx, phase.id))
    return { eventId: await deliver(trx, ctx, project.id, phase.id, i) }
  })
}

export function reopenPhase(ctx: Ctx, i: { projectKey: string; phaseKey: string; reason: string }): Promise<Mutation> {
  return run(ctx, async (trx) => {
    requireReason(i.reason)
    const project = await findProject(trx, i.projectKey)
    const phase = await findPhase(trx, project.id, i.phaseKey, { lock: 'update' })
    if (phase.state !== 'delivered') phaseConflict(phase)
    await trx
      .updateTable('phases')
      .set({ state: 'open', delivered_at: null, delivered_by: null })
      .where('id', '=', phase.id)
      .execute()
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      phaseId: phase.id,
      kind: 'reopen_phase',
      reason: i.reason,
      data: i,
    })
    return { eventId }
  })
}

export function addTask(
  ctx: Ctx,
  i: {
    projectKey: string
    phaseKey?: string
    parentKey?: string
    key: string
    title: string
    description?: string
    assigneeName?: string
    estimateHours?: number
    criteria?: string[]
    blockedBy?: string[]
  },
): Promise<Mutation> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    const existing = await trx
      .selectFrom('tasks')
      .select('id')
      .where('project_id', '=', project.id)
      .where('key', '=', i.key)
      .executeTakeFirst()
    requireNewKey(existing, 'task', i.key)
    const phase = i.phaseKey === undefined ? null : await findPhase(trx, project.id, i.phaseKey, { lock: 'share' })
    if (phase?.state === 'delivered') phaseConflict(phase)
    const parent = i.parentKey === undefined ? null : await findTask(trx, project.id, i.parentKey)
    const assignee = i.assigneeName === undefined ? null : await findMember(trx, i.assigneeName)
    const blockers = []
    for (const key of new Set(i.blockedBy ?? [])) blockers.push(await findTask(trx, project.id, key))
    // A new task has no dependents yet, so its own blockers can never close a cycle.
    const { id } = await insertKeyed('task', i.key, () =>
      trx
        .insertInto('tasks')
        .values({
          tenant_id: ctx.tenantId,
          project_id: project.id,
          phase_id: phase?.id ?? null,
          parent_id: parent?.id ?? null,
          key: i.key,
          title: i.title,
          description: i.description ?? '',
          assignee_id: assignee?.id ?? null,
          estimate_hours: i.estimateHours ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    )
    await insertCriteria(trx, ctx, { taskId: id, phaseId: null }, i.criteria ?? [])
    if (blockers.length > 0) {
      await trx
        .insertInto('task_dependencies')
        .values(blockers.map((b) => ({ tenant_id: ctx.tenantId, task_id: id, blocked_by_task_id: b.id })))
        .execute()
    }
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      taskId: id,
      phaseId: phase?.id,
      kind: 'add_task',
      data: i,
    })
    return { eventId }
  })
}

// `null` clears phaseKey, assigneeName or estimateHours; an omitted field stays as it is.
export function editTask(
  ctx: Ctx,
  i: {
    projectKey: string
    taskKey: string
    title?: string
    description?: string
    phaseKey?: string | null
    assigneeName?: string | null
    estimateHours?: number | null
    reason: string
  },
): Promise<Mutation> {
  return run(ctx, async (trx) => {
    requireReason(i.reason)
    const project = await findProject(trx, i.projectKey)
    // Task before phase (the lock order). The target phase is locked for share like in addTask; the source phase too,
    // so a concurrent close or delivery of it waits for the move instead of counting the task on a stale read.
    const task = await findTask(trx, project.id, i.taskKey, { lock: true })
    const changes: {
      title?: string
      description?: string
      phase_id?: string | null
      assignee_id?: string | null
      estimate_hours?: number | null
    } = {}
    if (i.title !== undefined) changes.title = i.title
    if (i.description !== undefined) changes.description = i.description
    if (i.phaseKey !== undefined) {
      const targetId = i.phaseKey === null ? null : (await findPhase(trx, project.id, i.phaseKey)).id
      const locks = new Map<string, Lock>()
      if (task.phase_id) locks.set(task.phase_id, 'share')
      if (targetId) locks.set(targetId, 'share')
      const phases = await lockPhases(trx, locks)
      const phase = targetId ? phases.get(targetId) : undefined
      if (phase?.state === 'delivered' && isBlockerOpen(task.state)) phaseConflict(phase)
      changes.phase_id = targetId
    }
    if (i.assigneeName !== undefined) changes.assignee_id = i.assigneeName && (await findMember(trx, i.assigneeName)).id
    if (i.estimateHours !== undefined) changes.estimate_hours = i.estimateHours
    if (Object.keys(changes).length > 0) await trx.updateTable('tasks').set(changes).where('id', '=', task.id).execute()
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      taskId: task.id,
      kind: 'edit_task',
      reason: i.reason,
      data: i,
    })
    return { eventId }
  })
}

type TaskDependency = { projectKey: string; taskKey: string; blockedByKey: string; reason?: string }

export function addDependency(ctx: Ctx, i: TaskDependency): Promise<Mutation> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey, { lock: true })
    const task = await findTask(trx, project.id, i.taskKey)
    const blocker = await findTask(trx, project.id, i.blockedByKey)
    const edges = await trx
      .selectFrom('task_dependencies as d')
      .innerJoin('tasks as t', 't.id', 'd.task_id')
      .innerJoin('tasks as b', 'b.id', 'd.blocked_by_task_id')
      .select(['t.key as key', 'b.key as blockedBy'])
      .where('t.project_id', '=', project.id)
      .execute()
    if (edges.some((e) => e.key === task.key && e.blockedBy === blocker.key)) {
      fail('DR101', { path: '/blockedByKey', reason: `${task.key} is already blocked by ${blocker.key}` })
    }
    const pairs = edges.map((e): [string, string] => [e.key, e.blockedBy])
    if (wouldCycle(pairs, [task.key, blocker.key])) fail('DR103', { key: task.key, blockedBy: blocker.key })
    await trx
      .insertInto('task_dependencies')
      .values({ tenant_id: ctx.tenantId, task_id: task.id, blocked_by_task_id: blocker.id })
      .execute()
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      taskId: task.id,
      kind: 'add_dependency',
      reason: i.reason,
      data: i,
    })
    return { eventId }
  })
}

export function removeDependency(ctx: Ctx, i: TaskDependency): Promise<Mutation> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    const task = await findTask(trx, project.id, i.taskKey)
    const blocker = await findTask(trx, project.id, i.blockedByKey)
    const removed = await trx
      .deleteFrom('task_dependencies')
      .where('task_id', '=', task.id)
      .where('blocked_by_task_id', '=', blocker.id)
      .executeTakeFirst()
    if (removed.numDeletedRows === 0n) {
      fail('DR201', { kind: 'dependency', key: `${task.key} blocked by ${blocker.key}` })
    }
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      taskId: task.id,
      kind: 'remove_dependency',
      reason: i.reason,
      data: i,
    })
    return { eventId }
  })
}

export function transition(
  ctx: Ctx,
  i: { projectKey: string; taskKey: string; to: TaskState; reason?: string },
): Promise<DeliveringMutation> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    // Row lock: of two concurrent moves the second waits, then sees the new state and fails DR301.
    const task = await findTask(trx, project.id, i.taskKey, { lock: true })
    // Phase locks (after the task): a reopen cannot slip past a concurrent delivery of the same phase, and a start
    // reads its blocking phases under a share lock, so a concurrent reopen of one either waits for the start or is
    // seen by it (DR304).
    const blockerIds =
      task.phase_id && i.to === 'in_progress'
        ? await trx
            .selectFrom('phase_dependencies')
            .select('blocked_by_phase_id as id')
            .where('phase_id', '=', task.phase_id)
            .execute()
        : []
    const locks = new Map<string, Lock>(blockerIds.map((b) => [b.id, 'share']))
    if (task.phase_id) locks.set(task.phase_id, 'update')
    const phases = await lockPhases(trx, locks)
    const phase = task.phase_id ? (phases.get(task.phase_id) ?? null) : null
    const blockers = await trx
      .selectFrom('task_dependencies as d')
      .innerJoin('tasks as b', 'b.id', 'd.blocked_by_task_id')
      .select(['b.key', 'b.state'])
      .where('d.task_id', '=', task.id)
      .orderBy('b.key')
      .execute()
    const openCriteria = await trx
      .selectFrom('criteria')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('task_id', '=', task.id)
      .where('checked_at', 'is', null)
      .executeTakeFirstOrThrow()
    const blockingPhases = blockerIds
      .map((b) => phases.get(b.id) as PhaseRow)
      .filter((p) => p.state !== 'delivered')
      .sort((a, b) => a.position - b.position)
    const from = task.state
    checkTransition({
      from,
      to: i.to,
      openBlockers: blockers.filter((b) => isBlockerOpen(b.state)).map((b) => b.key),
      openCriteria: Number(openCriteria.count),
      blockingPhasesOpen: blockingPhases.map((p) => p.key),
      reason: i.reason,
    })
    if (phase?.state === 'delivered' && isBlockerOpen(i.to)) phaseConflict(phase)
    // started_at keeps the first start; finished_at is set on done/cancelled and cleared on any move out of them.
    const finished = i.to === 'done' || i.to === 'cancelled'
    await trx
      .updateTable('tasks')
      .set((eb) => ({
        state: i.to,
        version: eb('version', '+', 1),
        started_at: i.to === 'in_progress' ? sql<Date>`coalesce(started_at, now())` : eb.ref('started_at'),
        finished_at: finished ? sql<Date>`now()` : null,
      }))
      .where('id', '=', task.id)
      .execute()
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      taskId: task.id,
      phaseId: task.phase_id,
      kind: 'transition',
      reason: i.reason,
      data: { ...i, from, to: i.to },
    })
    const delivered = await deliverIfClosable(trx, ctx, i.projectKey, project.id, task.phase_id)
    return { eventId, delivered }
  })
}

export function addCriterion(ctx: Ctx, i: Target & { text: string }): Promise<Mutation> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    // Owner lock: two concurrent adds would otherwise read the same max(position).
    const target = await findTarget(trx, project.id, i, { lock: true })
    // A new criterion is open work: a delivered phase (or a task in one) and a done or cancelled task would hold an
    // unchecked criterion after the fact. Plan import reaches this too, so it fails instead of writing it.
    if (target.taskId && target.phaseToCheck) {
      const phase = await trx
        .selectFrom('phases')
        .select(['key', 'state'])
        .where('id', '=', target.phaseToCheck)
        .forShare()
        .executeTakeFirstOrThrow()
      if (phase.state === 'delivered') phaseConflict(phase)
    }
    if (target.state === 'delivered') phaseConflict({ key: target.label, state: target.state })
    if (target.state === 'done' || target.state === 'cancelled') {
      fail('DR307', { task: target.label, state: target.state })
    }
    await insertCriteria(trx, ctx, target, [i.text])
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      taskId: target.taskId,
      phaseId: target.phaseId,
      kind: 'add_criterion',
      data: i,
    })
    return { eventId }
  })
}

export function editCriterion(
  ctx: Ctx,
  i: Target & { position: number; text: string; reason: string },
): Promise<Mutation> {
  return run(ctx, async (trx) => {
    requireReason(i.reason)
    const project = await findProject(trx, i.projectKey)
    const target = await findTarget(trx, project.id, i)
    const criterion = await findCriterion(trx, target, i.position)
    await trx.updateTable('criteria').set({ text: i.text }).where('id', '=', criterion.id).execute()
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      taskId: target.taskId,
      phaseId: target.phaseId,
      kind: 'edit_criterion',
      reason: i.reason,
      data: i,
    })
    return { eventId }
  })
}

// Checking again replaces the evidence. A task criterion never changes phase closability (a done task has all of
// its criteria checked), but checking it still runs the delivery check so both paths behave the same.
export function checkCriterion(
  ctx: Ctx,
  i: Target & { position: number; evidence: string },
): Promise<DeliveringMutation> {
  return run(ctx, async (trx) => {
    if (!EVIDENCE.test(i.evidence)) {
      fail('DR101', {
        path: '/evidence',
        reason: 'expected commit:<sha>, gate:<name>, url:<http(s) url> or note:<text>',
      })
    }
    const project = await findProject(trx, i.projectKey)
    const target = await findTarget(trx, project.id, i)
    const criterion = await findCriterion(trx, target, i.position)
    await trx
      .updateTable('criteria')
      .set({ checked_at: sql<Date>`now()`, checked_by: ctx.actor.id, evidence: i.evidence })
      .where('id', '=', criterion.id)
      .execute()
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      taskId: target.taskId,
      phaseId: target.phaseId,
      kind: 'check_criterion',
      data: i,
    })
    const delivered = await deliverIfClosable(trx, ctx, i.projectKey, project.id, target.phaseToCheck)
    return { eventId, delivered }
  })
}

export function addLink(ctx: Ctx, i: Target & { kind: string; ref: string; title?: string }): Promise<Mutation> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    const target = await findTarget(trx, project.id, i)
    await trx
      .insertInto('links')
      .values({
        tenant_id: ctx.tenantId,
        task_id: target.taskId,
        phase_id: target.phaseId,
        kind: i.kind,
        ref: i.ref,
        title: i.title ?? null,
      })
      .execute()
    const eventId = await record(trx, ctx, {
      projectId: project.id,
      taskId: target.taskId,
      phaseId: target.phaseId,
      kind: 'add_link',
      data: i,
    })
    return { eventId }
  })
}
