import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { type Kysely, sql } from 'kysely'
import type { Database, JobState, RunState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import type { JobSummary } from '../jobs/enqueue.ts'
import { findProject, run, type TenantCtx } from '../planning/resolve.ts'
import { indicatorsNow, runIndicators } from '../runs/indicators.ts'
import type { RunSummary } from '../runs/view.ts'
import { authenticateMembers, memberCtx } from './members.ts'
import { periodWindow } from './period-window.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const oneOf = <T extends string>(values: T[]) => Type.Unsafe<T>({ type: 'string', enum: values })
const RUN_STATES: RunState[] = [
  'queued',
  'offered',
  'admitted',
  'running',
  'finished',
  'failed',
  'stopped',
  'orphaned',
  'skipped',
]
const JOB_STATES: JobState[] = ['open', 'finished', 'failed', 'stopped', 'skipped']
const Page = {
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
}

// A keyset cursor over (time, id), base64url of `<microseconds since epoch>.<uuid>`. Microseconds, not a Date:
// timestamptz keeps them and a JS Date does not, so a cursor built from a Date would repeat or skip rows queued in
// the same millisecond.
type Cursor = { us: string; id: string }
const CURSOR = /^(\d{1,17})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

const encodeCursor = (us: string, id: string): string => Buffer.from(`${us}.${id}`).toString('base64url')

function decodeCursor(cursor: string | undefined): Cursor | null {
  if (cursor === undefined) return null
  const match = CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (!match) fail('DR101', { path: 'querystring/cursor', reason: 'is not a cursor this list returned' })
  return { us: match[1], id: match[2] }
}

// Rows strictly after the cursor in (time desc, id desc) order. The bigint times an interval of one microsecond is
// exact: the product stays below 2^53.
const before = (time: string, id: string, c: Cursor) =>
  sql<boolean>`(${sql.ref(time)}, ${sql.ref(id)}) < (timestamptz 'epoch' + ${c.us}::bigint * interval '1 microsecond', ${c.id}::uuid)`
const micros = (time: string) => sql<string>`(extract(epoch from ${sql.ref(time)}) * 1000000)::bigint`

// One page plus one row: the extra row says whether there is a next page, and is not returned.
function paged<T>(rows: (T & { us: string; id: string })[], limit: number) {
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return { page, nextCursor: rows.length > limit && last ? encodeCursor(last.us, last.id) : null }
}

/** Runs of the project, newest `queued_at` first. */
export function listRuns(
  ctx: TenantCtx,
  projectKey: string,
  q: { state?: RunState; jobType?: string; queue?: string; cursor?: string; limit: number },
): Promise<{ runs: RunSummary[]; nextCursor: string | null }> {
  const cursor = decodeCursor(q.cursor)
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const rows = await trx
      .selectFrom('runs as r')
      .innerJoin('jobs as j', 'j.id', 'r.job_id')
      .innerJoin('job_types as jt', 'jt.id', 'r.job_type_id')
      .innerJoin('queues as q', 'q.id', 'j.queue_id')
      .leftJoin('machines as m', 'm.id', 'r.machine_id')
      .select([
        'r.id',
        'r.state',
        'r.attempt',
        'r.cause',
        'r.queued_at',
        'r.finished_at',
        'r.failure_class',
        'jt.key as job_type',
        'q.key as queue',
        'm.name as machine',
        micros('r.queued_at').as('us'),
      ])
      .where('r.project_id', '=', project.id)
      .$if(q.state !== undefined, (query) => query.where('r.state', '=', q.state as RunState))
      .$if(q.jobType !== undefined, (query) => query.where('jt.key', '=', q.jobType as string))
      .$if(q.queue !== undefined, (query) => query.where('q.key', '=', q.queue as string))
      .$if(cursor !== null, (query) => query.where(before('r.queued_at', 'r.id', cursor as Cursor)))
      .orderBy('r.queued_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(q.limit + 1)
      .execute()
    const { page, nextCursor } = paged(rows, q.limit)
    return {
      runs: page.map((r) => ({
        id: r.id,
        state: r.state,
        attempt: r.attempt,
        cause: r.cause,
        jobType: r.job_type,
        queue: r.queue,
        machine: r.machine,
        queuedAt: r.queued_at,
        finishedAt: r.finished_at,
        failureClass: r.failure_class,
        totalMs: r.finished_at ? r.finished_at.getTime() - r.queued_at.getTime() : null,
      })),
      nextCursor,
    }
  })
}

/** Jobs of the project, newest first, each with its dependencies and its latest run. */
export function listJobs(
  ctx: TenantCtx,
  projectKey: string,
  q: { state?: JobState; cursor?: string; limit: number },
): Promise<{ jobs: JobSummary[]; nextCursor: string | null }> {
  const cursor = decodeCursor(q.cursor)
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const rows = await trx
      .selectFrom('jobs as j')
      .innerJoin('job_types as jt', 'jt.id', 'j.job_type_id')
      // Every job has a run: a job is created with its first one (jobs/enqueue.ts).
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('runs as r')
            .select(['r.id', 'r.state', 'r.failure_class'])
            .whereRef('r.job_id', '=', 'j.id')
            .orderBy('r.queued_at', 'desc')
            .orderBy('r.id', 'desc')
            .limit(1)
            .as('last'),
        (join) => join.onTrue(),
      )
      .select((eb) => [
        'j.id',
        'j.ref',
        'j.batch_id',
        'j.state',
        'jt.key as job_type',
        'last.id as last_id',
        'last.state as last_state',
        'last.failure_class as last_failure_class',
        eb
          .selectFrom('runs as a')
          .select((a) => a.fn.countAll<string>().as('n'))
          .whereRef('a.job_id', '=', 'j.id')
          .where('a.cause', '<>', 'requeue')
          .as('attempts'),
        micros('j.created_at').as('us'),
      ])
      .where('j.project_id', '=', project.id)
      .$if(q.state !== undefined, (query) => query.where('j.state', '=', q.state as JobState))
      .$if(cursor !== null, (query) => query.where(before('j.created_at', 'j.id', cursor as Cursor)))
      .orderBy('j.created_at', 'desc')
      .orderBy('j.id', 'desc')
      .limit(q.limit + 1)
      .execute()
    const { page, nextCursor } = paged(rows, q.limit)
    const edges =
      page.length === 0
        ? []
        : await trx
            .selectFrom('job_dependencies as d')
            .innerJoin('jobs as dep', 'dep.id', 'd.depends_on_job_id')
            .select(['d.job_id', 'dep.id', 'dep.ref'])
            .where(
              'd.job_id',
              'in',
              page.map((row) => row.id),
            )
            .orderBy('dep.ref')
            .orderBy('dep.id')
            .execute()
    return {
      jobs: page.map((row) => ({
        id: row.id,
        ref: row.ref,
        batch: row.batch_id,
        jobType: row.job_type,
        state: row.state,
        attempts: Number(row.attempts ?? 0),
        dependsOn: edges.filter((e) => e.job_id === row.id).map((e) => e.ref ?? e.id),
        lastRun: { id: row.last_id, state: row.last_state, failureClass: row.last_failure_class },
      })),
      nextCursor,
    }
  })
}

// Read-only lists and indicators for the operational view, `devrounds run list` and `devrounds indicators`. Queues,
// a run and its log page are on the routes of job-routes.ts and run-routes.ts.
export const viewRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database> }> = async (app, { db }) => {
  authenticateMembers(app, db)

  app.get(
    '/runs',
    {
      schema: {
        params: Type.Object({ key: Key }),
        querystring: Type.Object(
          { state: Type.Optional(oneOf(RUN_STATES)), jobType: Type.Optional(Key), queue: Type.Optional(Key), ...Page },
          { additionalProperties: false },
        ),
      },
    },
    (request) => listRuns(memberCtx(db, request), request.params.key, request.query),
  )

  app.get(
    '/jobs',
    {
      schema: {
        params: Type.Object({ key: Key }),
        querystring: Type.Object({ state: Type.Optional(oneOf(JOB_STATES)), ...Page }, { additionalProperties: false }),
      },
    },
    (request) => listJobs(memberCtx(db, request), request.params.key, request.query),
  )

  app.get(
    '/indicators',
    {
      schema: {
        params: Type.Object({ key: Key }),
        querystring: Type.Object(
          {
            period: Type.Unsafe<'day' | 'week'>({ type: 'string', enum: ['day', 'week'], default: 'day' }),
            from: Type.Optional(Type.String()),
            to: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      },
    },
    (request) =>
      runIndicators(memberCtx(db, request), request.params.key, periodWindow('indicators window', request.query)),
  )

  app.get('/indicators/now', { schema: { params: Type.Object({ key: Key }) } }, (request) =>
    indicatorsNow(memberCtx(db, request), request.params.key),
  )
}
