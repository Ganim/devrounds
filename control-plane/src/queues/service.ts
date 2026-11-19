import { type Static, Type } from '@sinclair/typebox'
import { sql } from 'kysely'
import { fail } from '../errors/error.ts'
import { findJobType } from '../job-types/service.ts'
import { type Ctx, findProject, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { validate } from '../validate.ts'

export const DEFAULT_QUEUE = 'default'

const INT_MAX = 2147483647

/** What `PUT /queues/:queue` takes. An omitted field keeps its value; `concurrency: null` removes the cap and
 * `jobTypes: []` lets every job type in. */
export const QueueSettings = Type.Object(
  {
    priority: Type.Optional(Type.Integer({ minimum: -INT_MAX - 1, maximum: INT_MAX })),
    concurrency: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: INT_MAX }), Type.Null()])),
    jobTypes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 200 })),
  },
  { additionalProperties: false },
)

export type QueueSettings = Static<typeof QueueSettings>

export type QueueRow = { id: string; key: string; priority: number; concurrency: number | null }

export type QueueView = {
  key: string
  priority: number
  concurrency: number | null
  // Empty: every job type of the project.
  jobTypes: string[]
  // Runs queued in it.
  depth: number
  // Runs offered, admitted or running; the ones a concurrency cap counts.
  inFlight: number
  oldestQueuedAt: Date | null
}

function findQueue(trx: Trx, projectId: string, key: string): Promise<QueueRow | undefined> {
  return trx
    .selectFrom('queues')
    .select(['id', 'key', 'priority', 'concurrency'])
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .executeTakeFirst()
}

/**
 * The queue `key` of the project. Only `default` is created on first use, so a job never needs a queue set up first;
 * any other key must have been created with putQueue (DR201 otherwise), so a typo does not open a new queue.
 */
export async function ensureQueue(trx: Trx, projectId: string, key = DEFAULT_QUEUE): Promise<QueueRow> {
  const found = await findQueue(trx, projectId, key)
  if (found) return found
  if (key !== DEFAULT_QUEUE) fail('DR201', { kind: 'queue', key })
  // The tenant comes from the project row (RLS already limits it to the current tenant). A concurrent first use
  // waits on the unique key and then inserts nothing; the read below sees its row.
  await trx
    .insertInto('queues')
    .columns(['tenant_id', 'project_id', 'key'])
    .expression((eb) =>
      eb
        .selectFrom('projects')
        .select(['tenant_id', 'id', eb.val(key).as('key')])
        .where('id', '=', projectId),
    )
    .onConflict((oc) => oc.columns(['project_id', 'key']).doNothing())
    .execute()
  return (await findQueue(trx, projectId, key)) ?? fail('DR201', { kind: 'queue', key })
}

/** Creates the queue `i.key` of the project, or changes the fields `i` gives. */
export async function putQueue(ctx: Ctx, projectKey: string, i: { key: string } & QueueSettings): Promise<QueueView> {
  const { key, ...settings } = i
  validate(Type.String({ minLength: 1, maxLength: 200 }), key)
  validate(QueueSettings, settings)
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    await trx
      .insertInto('queues')
      .values({ tenant_id: ctx.tenantId, project_id: project.id, key })
      .onConflict((oc) => oc.columns(['project_id', 'key']).doNothing())
      .execute()
    // Locked so two puts of the job type list of one queue cannot interleave their delete and insert.
    const queue = await trx
      .selectFrom('queues')
      .select('id')
      .where('project_id', '=', project.id)
      .where('key', '=', key)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow()
    const set: { priority?: number; concurrency?: number | null } = {}
    if (settings.priority !== undefined) set.priority = settings.priority
    if (settings.concurrency !== undefined) set.concurrency = settings.concurrency
    if (Object.keys(set).length > 0) await trx.updateTable('queues').set(set).where('id', '=', queue.id).execute()
    if (settings.jobTypes !== undefined) {
      const ids = new Set<string>()
      for (const jobType of settings.jobTypes) ids.add((await findJobType(trx, project.id, jobType)).id)
      await trx.deleteFrom('queue_job_types').where('queue_id', '=', queue.id).execute()
      if (ids.size > 0) {
        await trx
          .insertInto('queue_job_types')
          .values([...ids].map((id) => ({ tenant_id: ctx.tenantId, queue_id: queue.id, job_type_id: id })))
          .execute()
      }
    }
    const [view] = await queueViews(trx, project.id, key)
    return view
  })
}

/** The project's queues, highest priority first. */
export function listQueues(ctx: TenantCtx, projectKey: string): Promise<QueueView[]> {
  return run(ctx, async (trx) => queueViews(trx, (await findProject(trx, projectKey)).id))
}

async function queueViews(trx: Trx, projectId: string, onlyKey?: string): Promise<QueueView[]> {
  // Runs of the project not ended yet, by queue; ended runs never count, so the join stays small.
  const { rows } = await sql<{
    id: string
    key: string
    priority: number
    concurrency: number | null
    depth: string
    in_flight: string
    oldest_queued_at: Date | null
  }>`
    select q.id, q.key, q.priority, q.concurrency,
      count(*) filter (where a.state = 'queued') as depth,
      count(*) filter (where a.state in ('offered', 'admitted', 'running')) as in_flight,
      min(a.queued_at) filter (where a.state = 'queued') as oldest_queued_at
    from queues q
    left join (
      select j.queue_id, r.state, r.queued_at
      from runs r join jobs j on j.id = r.job_id
      where r.project_id = ${projectId} and r.state in ('queued', 'offered', 'admitted', 'running')
    ) a on a.queue_id = q.id
    where q.project_id = ${projectId} ${onlyKey === undefined ? sql`` : sql`and q.key = ${onlyKey}`}
    group by q.id
    order by q.priority desc, q.key`.execute(trx)
  if (rows.length === 0) return []
  const jobTypes = await trx
    .selectFrom('queue_job_types as qjt')
    .innerJoin('job_types as jt', 'jt.id', 'qjt.job_type_id')
    .select(['qjt.queue_id', 'jt.key'])
    .where(
      'qjt.queue_id',
      'in',
      rows.map((row) => row.id),
    )
    .orderBy('jt.key')
    .execute()
  return rows.map((row) => ({
    key: row.key,
    priority: row.priority,
    concurrency: row.concurrency,
    jobTypes: jobTypes.filter((jt) => jt.queue_id === row.id).map((jt) => jt.key),
    depth: Number(row.depth),
    inFlight: Number(row.in_flight),
    oldestQueuedAt: row.oldest_queued_at,
  }))
}
