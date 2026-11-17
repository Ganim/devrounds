import type { Kysely, Transaction } from 'kysely'
import type { Database, MemberKind } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { withTenant } from '../tenancy/scope.ts'

export type Actor = { id: string; kind: MemberKind }

// With `trx` set every call joins that transaction (import wraps many calls in one); otherwise each call opens its own.
export type Ctx = { db: Kysely<Database>; tenantId: string; actor: Actor; trx?: Transaction<Database> }

export type Trx = Transaction<Database>

// Criteria and links belong to exactly one task or phase.
export type Target = { projectKey: string; taskKey?: string; phaseKey?: string }

export function run<T>(ctx: Ctx, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return ctx.trx ? fn(ctx.trx) : withTenant(ctx.db, ctx.tenantId, fn)
}

// Keys resolve inside the given project (and RLS keeps it inside the tenant), so a phase, parent or blocker of another
// project is "not found" by construction; the schema alone only guarantees the same tenant.

export async function findProject(trx: Trx, key: string) {
  const row = await trx.selectFrom('projects').select(['id', 'key', 'name']).where('key', '=', key).executeTakeFirst()
  return row ?? fail('DR201', { kind: 'project', key })
}

export async function findPhase(trx: Trx, projectId: string, key: string) {
  const row = await trx
    .selectFrom('phases')
    .select(['id', 'key', 'state'])
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .executeTakeFirst()
  return row ?? fail('DR201', { kind: 'phase', key })
}

export async function findTask(trx: Trx, projectId: string, key: string, opts: { lock?: boolean } = {}) {
  let query = trx
    .selectFrom('tasks')
    .select(['id', 'key', 'state', 'phase_id'])
    .where('project_id', '=', projectId)
    .where('key', '=', key)
  if (opts.lock) query = query.forUpdate()
  return (await query.executeTakeFirst()) ?? fail('DR201', { kind: 'task', key })
}

export async function findMember(trx: Trx, name: string) {
  const row = await trx.selectFrom('members').select('id').where('name', '=', name).executeTakeFirst()
  return row ?? fail('DR201', { kind: 'member', key: name })
}

// `phaseToCheck` is the phase whose delivery may change when something on this target changes.
export async function findTarget(trx: Trx, projectId: string, i: Target) {
  if ((i.taskKey === undefined) === (i.phaseKey === undefined)) {
    fail('DR101', { path: '/', reason: 'give exactly one of taskKey or phaseKey' })
  }
  if (i.taskKey !== undefined) {
    const task = await findTask(trx, projectId, i.taskKey)
    return { taskId: task.id, phaseId: null, label: task.key, phaseToCheck: task.phase_id }
  }
  const phase = await findPhase(trx, projectId, i.phaseKey as string)
  return { taskId: null, phaseId: phase.id, label: phase.key, phaseToCheck: phase.id }
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
