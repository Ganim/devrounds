import { randomUUID } from 'node:crypto'
import type { Static } from '@sinclair/typebox'
import { sql } from 'kysely'
import type { FailureClass, JobState, RunState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { sameEnvName } from '../job-types/file.ts'
import { findJobType } from '../job-types/service.ts'
import { type Ctx, findProject, findTask, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { DEFAULT_QUEUE, ensureQueue, type QueueRow } from '../queues/service.ts'
import { isUuid, loadRunView, type RunView } from '../runs/view.ts'
import { notifyScheduler } from '../scheduler/notify.ts'
import { validate } from '../validate.ts'
import { BatchInput, type BatchJob } from './batch-file.ts'
import { findCachedRun } from './cache.ts'
import { checkGraph } from './graph.ts'

export type EnqueueInput = {
  projectKey: string
  jobTypeKey: string
  cwd: string
  machineName?: string
  queueKey?: string
  taskKey?: string
  // Appended to the job type's command args (needs args_from_job).
  args?: string[]
  // Values of names the job type lists in job_env, over its env_set.
  env?: Record<string, string>
  // The caller's key of the job's inputs; a recent finished run with it answers for the job (cache.ts).
  cacheKey?: string
}

export type BatchView = {
  id: string
  // By ref; runId is the job's latest run, cachedFrom the run it is a cache hit of.
  jobs: { ref: string; jobId: string; runId: string; jobType: string; state: JobState; cachedFrom: string | null }[]
}

// One row of GET /jobs (api/view-routes.ts listJobs).
export type JobSummary = {
  id: string
  // Null for a job not made by a batch (`run start`, a schedule).
  ref: string | null
  batch: string | null
  jobType: string
  state: JobState
  // Runs with cause first or retry: a requeue is not the job's fault and never counts (jobs/outcome.ts).
  attempts: number
  // Refs of the jobs it waits for (the id for one without a ref).
  dependsOn: string[]
  lastRun: { id: string; state: RunState; failureClass: FailureClass | null }
}

type JobValues = {
  job_type_id: string
  queue_id: string
  machine_id: string | null
  task_id: string | null
  cwd: string
  // JSON, for the jsonb columns.
  args: string
  env: string
  cache_key: string | null
}

function cached<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const seen = new Map<string, T>()
  return async (key) => {
    const hit = seen.get(key)
    if (hit !== undefined) return hit
    const value = await load(key)
    seen.set(key, value)
    return value
  }
}

// Resolves the keys of one job inside the project and checks its args and env against the job type; `path` prefixes
// the DR101 path (`/jobs/<i>` in a batch). Lookups repeat across the jobs of a batch, so they are cached per call.
export function resolver(trx: Trx, projectId: string) {
  const jobType = cached((key) => findJobType(trx, projectId, key))
  const queue = cached(async (key): Promise<QueueRow & { allowed: Set<string> }> => {
    const row = await ensureQueue(trx, projectId, key)
    const listed = await trx
      .selectFrom('queue_job_types')
      .select('job_type_id')
      .where('queue_id', '=', row.id)
      .execute()
    return { ...row, allowed: new Set(listed.map((l) => l.job_type_id)) }
  })
  // A pin names a live machine of the tenant; a revoked one could never run the job. Shared lock: a revoke waits for
  // this transaction, and then its sweep of pinned queued runs (failRevokedRuns) sees the new ones.
  const machine = cached(async (name) => {
    const row = await trx
      .selectFrom('machines')
      .select('id')
      .where('name', '=', name)
      .where('revoked_at', 'is', null)
      .forShare()
      .executeTakeFirst()
    return row?.id ?? fail('DR201', { kind: 'machine', key: name })
  })

  return async (i: Omit<EnqueueInput, 'projectKey'>, path = ''): Promise<JobValues> => {
    const type = await jobType(i.jobTypeKey)
    const args = i.args ?? []
    if (args.length > 0 && !type.args_from_job) {
      fail('DR101', { path: `${path}/args`, reason: `job type ${type.key} does not take job args (args_from_job)` })
    }
    for (const name of Object.keys(i.env ?? {})) {
      if (!type.job_env.some((allowed) => sameEnvName(allowed, name))) {
        fail('DR101', {
          path: `${path}/env/${name}`,
          reason: `job type ${type.key} does not let a job set ${name} (job_env)`,
        })
      }
    }
    const q = await queue(i.queueKey ?? DEFAULT_QUEUE)
    // A queue that lists no job types takes every one.
    if (q.allowed.size > 0 && !q.allowed.has(type.id)) fail('DR153', { jobType: type.key, queue: q.key })
    return {
      job_type_id: type.id,
      queue_id: q.id,
      machine_id: i.machineName === undefined ? null : await machine(i.machineName),
      task_id: i.taskKey === undefined ? null : (await findTask(trx, projectId, i.taskKey)).id,
      cwd: i.cwd,
      args: JSON.stringify(args),
      env: JSON.stringify(i.env ?? {}),
      cache_key: i.cacheKey ?? null,
    }
  }
}

type FirstRun = Awaited<ReturnType<typeof firstRunOf>>

// The job and first-run columns of a job: a cache hit ends both at insert (finished, nothing else stamped: no
// machine, no offer, no start), so claim_run never sees its run and its dependents may be claimed at once.
// `eligible` false (a job behind a job that runs) makes it a plain queued job.
async function firstRunOf(trx: Trx, projectId: string, values: JobValues, eligible = true) {
  const hit =
    !eligible || values.cache_key === null
      ? null
      : await findCachedRun(trx, projectId, values.job_type_id, values.cache_key)
  if (hit === null) return { hit, job: {}, run: {} }
  return {
    hit,
    job: { state: 'finished' as const },
    run: { state: 'finished' as const, finished_at: sql<Date>`now()`, cached_from_run_id: hit },
  }
}

/**
 * Queues a job outside any batch and its first run (attempt 1, cause first, no machine until the scheduler places
 * it), then wakes the scheduler at commit. A cache hit (cacheKey) ends at once and wakes nobody.
 */
export function enqueueRun(ctx: Ctx, i: EnqueueInput): Promise<RunView> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    const values = await resolver(trx, project.id)(i)
    const first = await firstRunOf(trx, project.id, values)
    const job = await trx
      .insertInto('jobs')
      .values({ tenant_id: ctx.tenantId, project_id: project.id, created_by: ctx.actor.id, ...values, ...first.job })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id } = await trx
      .insertInto('runs')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        job_id: job.id,
        job_type_id: values.job_type_id,
        ...first.run,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    if (first.hit === null) await notifyScheduler(trx, ctx.tenantId)
    return loadRunView(trx, id)
  })
}

// A batch job as insertBatch takes it: its cwd may come from the defaults.
export type BatchJobValues = Omit<Static<typeof BatchJob>, 'cwd'> & { cwd?: string }

/**
 * Inserts the jobs of `input` into batch `batchId` (the job_batches row is the caller's), each with its first run,
 * and their depends_on edges, and wakes the scheduler at commit when any run is queued. `defaults` fill a job's
 * missing cwd and queue, and pin a job without `machine` to a machine by id. The graph is checked before any job is
 * written; any error (graph, unknown key, DR153) throws, so the caller's transaction leaves nothing behind.
 */
export async function insertBatch(
  trx: Trx,
  ctx: Ctx,
  projectId: string,
  batchId: string,
  input: { jobs: BatchJobValues[] },
  defaults: { machineId?: string; queueKey?: string; cwd?: string } = {},
): Promise<void> {
  checkGraph(
    batchId,
    input.jobs.map((job) => ({ ref: job.ref, dependsOn: job.depends_on ?? [] })),
  )
  const resolve = resolver(trx, projectId)
  const valuesOf = new Map<string, JobValues>()
  for (const [index, job] of input.jobs.entries()) {
    const cwd = job.cwd ?? defaults.cwd ?? fail('DR101', { path: `/jobs/${index}/cwd`, reason: 'is required' })
    const values = await resolve(
      {
        jobTypeKey: job.job_type,
        cwd,
        machineName: job.machine,
        queueKey: job.queue ?? defaults.queueKey,
        taskKey: job.task,
        args: job.args,
        env: job.env,
        cacheKey: job.cache_key,
      },
      `/jobs/${index}`,
    )
    if (job.machine === undefined && defaults.machineId !== undefined) values.machine_id = defaults.machineId
    valuesOf.set(job.ref, values)
  }
  // A job is a hit only when every job it depends on is a hit of this submit too: claim_run gates on direct
  // dependencies and the skip walk (jobs/outcome.ts endJob) passes only through open jobs, so a finished job behind
  // one that runs would let its dependents run before it, and keep running them when it fails. Depth first over the
  // checked (acyclic) graph, so each dependency is decided before its dependents.
  const dependsOn = new Map(input.jobs.map((job) => [job.ref, job.depends_on ?? []]))
  const firstOf = new Map<string, FirstRun>()
  const decide = async (ref: string): Promise<FirstRun> => {
    const known = firstOf.get(ref)
    if (known) return known
    let eligible = true
    for (const dep of dependsOn.get(ref) ?? []) {
      if ((await decide(dep)).hit === null) eligible = false
    }
    const first = await firstRunOf(trx, projectId, valuesOf.get(ref) as JobValues, eligible)
    firstOf.set(ref, first)
    return first
  }
  for (const job of input.jobs) await decide(job.ref)
  const decided = (ref: string) => firstOf.get(ref) as FirstRun

  const base = { tenant_id: ctx.tenantId, project_id: projectId }
  const jobs = await trx
    .insertInto('jobs')
    .values(
      input.jobs.map((job) => ({
        ...base,
        created_by: ctx.actor.id,
        ...(valuesOf.get(job.ref) as JobValues),
        ...decided(job.ref).job,
        batch_id: batchId,
        ref: job.ref,
      })),
    )
    .returning(['id', 'ref', 'job_type_id'])
    .execute()
  const idOf = new Map(jobs.map((job) => [job.ref as string, job.id]))
  await trx
    .insertInto('runs')
    .values(
      jobs.map((job) => ({
        ...base,
        job_id: job.id,
        job_type_id: job.job_type_id,
        // By ref: RETURNING promises no order.
        ...decided(job.ref as string).run,
      })),
    )
    .execute()
  const edges = input.jobs.flatMap((job) =>
    // A ref listed twice in depends_on is one edge.
    [...new Set(job.depends_on ?? [])].map((ref) => ({
      tenant_id: ctx.tenantId,
      job_id: idOf.get(job.ref) as string,
      depends_on_job_id: idOf.get(ref) as string,
    })),
  )
  if (edges.length > 0) await trx.insertInto('job_dependencies').values(edges).execute()
  if (input.jobs.some((job) => decided(job.ref).hit === null)) await notifyScheduler(trx, ctx.tenantId)
}

/** Queues every job of `input` (insertBatch) in a new batch, in one transaction: any error leaves nothing behind. */
export async function submitBatch(ctx: Ctx, projectKey: string, input: BatchInput): Promise<BatchView> {
  validate(BatchInput, input)
  // The id is chosen here so DR152 can name the batch it refuses.
  const batchId = randomUUID()
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    await trx
      .insertInto('job_batches')
      .values({ id: batchId, tenant_id: ctx.tenantId, project_id: project.id, created_by: ctx.actor.id })
      .execute()
    await insertBatch(trx, ctx, project.id, batchId, input)
    return loadBatchView(trx, project.id, batchId)
  })
}

/** A batch of another project or tenant answers DR201 as if it did not exist. */
export async function batchView(ctx: TenantCtx, projectKey: string, batchId: string): Promise<BatchView> {
  if (!isUuid(batchId)) fail('DR201', { kind: 'batch', key: batchId })
  return run(ctx, async (trx) => loadBatchView(trx, (await findProject(trx, projectKey)).id, batchId))
}

async function loadBatchView(trx: Trx, projectId: string, batchId: string): Promise<BatchView> {
  const batch = await trx
    .selectFrom('job_batches')
    .select('id')
    .where('id', '=', batchId)
    .where('project_id', '=', projectId)
    .executeTakeFirst()
  if (!batch) fail('DR201', { kind: 'batch', key: batchId })
  const jobs = await trx
    .selectFrom('jobs as j')
    .innerJoin('job_types as jt', 'jt.id', 'j.job_type_id')
    .innerJoin('runs as r', 'r.job_id', 'j.id')
    .select(['j.id', 'j.ref', 'j.state', 'jt.key as job_type', 'r.id as run_id', 'r.cached_from_run_id'])
    .where('j.batch_id', '=', batchId)
    .where(({ eb, selectFrom }) =>
      eb(
        'r.attempt',
        '=',
        selectFrom('runs as last')
          .select(({ fn }) => fn.max('last.attempt').as('a'))
          .whereRef('last.job_id', '=', 'j.id'),
      ),
    )
    .orderBy('j.ref')
    .execute()
  return {
    id: batch.id,
    jobs: jobs.map((job) => ({
      ref: job.ref as string,
      jobId: job.id,
      runId: job.run_id,
      jobType: job.job_type,
      state: job.state,
      cachedFrom: job.cached_from_run_id,
    })),
  }
}
