import type { Kysely, Transaction } from 'kysely'
import type { Database, MemberKind, PhaseState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { withTenant } from '../tenancy/scope.ts'

export type Actor = { id: string; kind: MemberKind }

// With `trx` set every call joins that transaction (import wraps many calls in one); otherwise each call opens its own.
// `via: 'import'` marks every event the call writes (data.via), so the balance can tell replayed states from work.
export type Ctx = { db: Kysely<Database>; tenantId: string; actor: Actor; trx?: Transaction<Database>; via?: 'import' }

export type TenantCtx = Omit<Ctx, 'actor'>

export type Trx = Transaction<Database>

// Criteria and links belong to exactly one task or phase.
export type Target = { projectKey: string; taskKey?: string; phaseKey?: string }

// Takes no actor, so tenant work done for a machine (the executor gateway) shares it too.
export function run<T>(ctx: TenantCtx, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return ctx.trx ? fn(ctx.trx) : withTenant(ctx.db, ctx.tenantId, fn)
}

// Keys resolve inside the given project (and RLS keeps it inside the tenant), so a phase, parent or blocker of another
// project is "not found" by construction; the schema alone only guarantees the same tenant.

// Row locks, always taken in the order project → task → phase so concurrent mutations cannot deadlock:
// - project `for no key update`: serializes the mutations that read a whole-project graph (dependency edges, phase
//   positions) before writing; two opposite edges added at once would otherwise both pass the cycle check.
// - task `for no key update`: serializes moves of one task and criterion positions on it.
// - phase `for no key update` (deciding delivery, positions) or `for share` (adding open work): delivery and new open
//   work in the same phase cannot interleave.
// `no key update` instead of `update` because FK inserts take `key share` on the parent, which `update` would block.
// A call that locks several phases takes them through lockPhases, in id order.
export type Lock = 'update' | 'share'

export type PhaseRow = { id: string; key: string; state: PhaseState; position: number }

// Locks each phase row in id order (one mode per id) and returns them by id, so two calls locking an overlapping set
// of phases cannot deadlock on each other.
export async function lockPhases(trx: Trx, locks: Map<string, Lock>) {
  const rows = new Map<string, PhaseRow>()
  for (const id of [...locks.keys()].sort()) {
    const query = trx.selectFrom('phases').select(['id', 'key', 'state', 'position']).where('id', '=', id)
    const locked = locks.get(id) === 'update' ? query.forNoKeyUpdate() : query.forShare()
    rows.set(id, await locked.executeTakeFirstOrThrow())
  }
  return rows
}

export async function findProject(trx: Trx, key: string, opts: { lock?: boolean } = {}) {
  let query = trx.selectFrom('projects').select(['id', 'key', 'name']).where('key', '=', key)
  if (opts.lock) query = query.forNoKeyUpdate()
  return (await query.executeTakeFirst()) ?? fail('DR201', { kind: 'project', key })
}

export async function findPhase(trx: Trx, projectId: string, key: string, opts: { lock?: Lock } = {}) {
  let query = trx
    .selectFrom('phases')
    .select(['id', 'key', 'state'])
    .where('project_id', '=', projectId)
    .where('key', '=', key)
  if (opts.lock === 'update') query = query.forNoKeyUpdate()
  if (opts.lock === 'share') query = query.forShare()
  return (await query.executeTakeFirst()) ?? fail('DR201', { kind: 'phase', key })
}

export async function findTask(trx: Trx, projectId: string, key: string, opts: { lock?: boolean } = {}) {
  let query = trx
    .selectFrom('tasks')
    .select(['id', 'key', 'state', 'phase_id', 'source_key'])
    .where('project_id', '=', projectId)
    .where('key', '=', key)
  if (opts.lock) query = query.forNoKeyUpdate()
  return (await query.executeTakeFirst()) ?? fail('DR201', { kind: 'task', key })
}

export async function findMember(trx: Trx, name: string) {
  const row = await trx.selectFrom('members').select('id').where('name', '=', name).executeTakeFirst()
  return row ?? fail('DR201', { kind: 'member', key: name })
}

// `phaseToCheck` is the phase whose delivery may change when something on this target changes.
// `lock` takes the owner row (task or phase) for no key update, e.g. before computing the next criterion position.
// `state` is the owner's state (a task state or a phase state).
export async function findTarget(trx: Trx, projectId: string, i: Target, opts: { lock?: boolean } = {}) {
  if ((i.taskKey === undefined) === (i.phaseKey === undefined)) {
    fail('DR101', { path: '/', reason: 'give exactly one of taskKey or phaseKey' })
  }
  if (i.taskKey !== undefined) {
    const task = await findTask(trx, projectId, i.taskKey, opts)
    return { taskId: task.id, phaseId: null, label: task.key, phaseToCheck: task.phase_id, state: task.state }
  }
  const phase = await findPhase(trx, projectId, i.phaseKey as string, opts.lock ? { lock: 'update' } : {})
  return { taskId: null, phaseId: phase.id, label: phase.key, phaseToCheck: phase.id, state: phase.state }
}

export async function findCriterion(
  trx: Trx,
  target: { taskId: string | null; phaseId: string | null; label: string },
  position: number,
) {
  const row = await trx
    .selectFrom('criteria')
    .select('id')
    .where(target.taskId ? 'task_id' : 'phase_id', '=', (target.taskId ?? target.phaseId) as string)
    .where('position', '=', position)
    .executeTakeFirst()
  return row ?? fail('DR201', { kind: 'criterion', key: `${target.label}#${position}` })
}
