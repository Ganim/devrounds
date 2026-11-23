import { type RawBuilder, sql } from 'kysely'
import type { JobState } from '../db/schema.ts'
import { settleGate } from '../gates/settle.ts'
import type { Trx } from '../planning/resolve.ts'
import { notifyScheduler } from '../scheduler/notify.ts'

// The longest wait before a retry, however many attempts came before it.
const MAX_BACKOFF_S = 3600

/**
 * Queues a new run of job `jobId` with `cause` (retry by default) and the next attempt number, placeable from
 * `notBefore` (now by default), and opens the job again; returns the run id. Used by settleJob, by a person's retryRun
 * and, with cause requeue, by the offer expiry (scheduler/expiry.ts), by a revoke for a run that never started and by
 * retryRun for the skipped dependents it reopens (runs/record.ts).
 */
export async function queueRetry(
  trx: Trx,
  tenantId: string,
  jobId: string,
  notBefore: RawBuilder<Date> = sql<Date>`now()`,
  cause: 'retry' | 'requeue' = 'retry',
): Promise<string> {
  // Serializes the retries of one job (an automatic one and a person's), so two cannot pick the same attempt number.
  const job = await trx
    .selectFrom('jobs')
    .select(['project_id', 'job_type_id', 'machine_id'])
    .where('id', '=', jobId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow()
  const { last } = await trx
    .selectFrom('runs')
    .select((eb) => eb.fn.max('attempt').as('last'))
    .where('job_id', '=', jobId)
    .executeTakeFirstOrThrow()
  const { id } = await trx
    .insertInto('runs')
    .values({
      tenant_id: tenantId,
      job_id: jobId,
      attempt: last + 1,
      cause,
      not_before: notBefore,
      ...job,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await trx.updateTable('jobs').set({ state: 'open' }).where('id', '=', jobId).execute()
  return id
}

/**
 * Settles the job of run `runId` after the run's terminal transition, in that transition's transaction (every caller:
 * applyRunEvent, applyOrphans, failRevokedRuns, prepareStop of a queued run or of a withdrawn offer). Returns the retry
 * run queued, if any, and the ids of the runs skipped.
 *
 * - finished: the job is finished, and the scheduler is woken for its dependents.
 * - failed with a class in the job type's retry_on, after fewer attempts than max_attempts: a retry run waits
 *   backoff_s × 2^(attempts − 1) seconds after the end, at most MAX_BACKOFF_S; the job stays open. Attempts are the
 *   runs with cause first or retry: a requeue (the machine went away) is not the job's fault and never counts.
 * - any other failure, and orphaned (nobody saw the run end, so a retry could run twice at once): the job fails.
 * - stopped: the job is stopped. A person stopped it, so its policy never retries it.
 *
 * A job that fails or stops skips every open job that waits on it through depends_on, transitively: those jobs could
 * never be claimed. A run not ended (or skipped, which only settleJob writes) changes nothing. Callers wake the waiters
 * of the retry and skipped runs too (settledRuns), or `run show --wait` on them would only return at its deadline.
 */
export async function settleJob(
  trx: Trx,
  tenantId: string,
  runId: string,
): Promise<{ retryRunId: string | null; skipped: string[] }> {
  const run = await trx
    .selectFrom('runs as r')
    .innerJoin('jobs as j', 'j.id', 'r.job_id')
    .innerJoin('job_types as jt', 'jt.id', 'r.job_type_id')
    .select(['r.job_id', 'r.state', 'r.failure_class', 'j.ref', 'jt.max_attempts', 'jt.retry_backoff_s', 'jt.retry_on'])
    .where('r.id', '=', runId)
    .executeTakeFirstOrThrow()
  const end = (state: JobState) => endJob(trx, run.job_id, run.ref, state)

  switch (run.state) {
    case 'finished':
      await end('finished')
      await notifyScheduler(trx, tenantId)
      return { retryRunId: null, skipped: [] }
    case 'failed': {
      if (run.failure_class !== null && run.retry_on.includes(run.failure_class)) {
        const { attempts } = await trx
          .selectFrom('runs')
          .select((eb) => eb.fn.countAll<string>().as('attempts'))
          .where('job_id', '=', run.job_id)
          .where('cause', 'in', ['first', 'retry'])
          .executeTakeFirstOrThrow()
        const done = Number(attempts)
        if (done < run.max_attempts) {
          const delay = Math.min(run.retry_backoff_s * 2 ** (done - 1), MAX_BACKOFF_S)
          const notBefore = sql<Date>`(select coalesce(finished_at, now()) from runs where id = ${runId})
            + make_interval(secs => ${delay})`
          const retryRunId = await queueRetry(trx, tenantId, run.job_id, notBefore)
          await notifyScheduler(trx, tenantId)
          return { retryRunId, skipped: [] }
        }
      }
      return { retryRunId: null, skipped: await end('failed') }
    }
    case 'orphaned':
      return { retryRunId: null, skipped: await end('failed') }
    case 'stopped':
      return { retryRunId: null, skipped: await end('stopped') }
    default:
      return { retryRunId: null, skipped: [] }
  }
}

/**
 * Fails job `jobId` without its retry policy and skips its open dependents; returns the skipped runs. For a job pinned
 * to a revoked machine (runs/record.ts failRevokedRuns): every retry would be pinned there too, and never claimed.
 */
export async function failJob(trx: Trx, jobId: string): Promise<string[]> {
  const { ref } = await trx.selectFrom('jobs').select('ref').where('id', '=', jobId).executeTakeFirstOrThrow()
  return endJob(trx, jobId, ref, 'failed')
}

/** The runs settleJob changed besides the one that ended. */
export function settledRuns(settled: { retryRunId: string | null; skipped: string[] }): string[] {
  return settled.retryRunId === null ? settled.skipped : [settled.retryRunId, ...settled.skipped]
}

/** The failure summary of a run skipped because the dependency named `dependency` (its ref, or id) ended `state`. */
export function skippedSummary(dependency: string, state: JobState): string {
  return `skipped: dependency ${dependency} ${state}`
}

// Sets the job's outcome; a red one (failed, stopped) skips its open dependents and returns their skipped runs. The
// job's gate, if its batch has one, ends here once nothing of the batch is open (settleGate).
async function endJob(trx: Trx, jobId: string, ref: string | null, state: JobState): Promise<string[]> {
  const { batch_id } = await trx
    .updateTable('jobs')
    .set({ state })
    .where('id', '=', jobId)
    .returning('batch_id')
    .executeTakeFirstOrThrow()
  const skipped = await skipDependents(trx, jobId, ref, state)
  if (batch_id !== null) await settleGate(trx, batch_id)
  return skipped
}

async function skipDependents(trx: Trx, jobId: string, ref: string | null, state: JobState): Promise<string[]> {
  if (state === 'finished') return []
  // Only open jobs carry the walk on: a dependent that already finished (its dependency was retried by hand after
  // it ran) does not hold back the jobs after it.
  const { rows } = await sql<{ id: string }>`
    with recursive reach (id) as (
      select d.job_id from job_dependencies d join jobs j on j.id = d.job_id
      where d.depends_on_job_id = ${jobId} and j.state = 'open'
      union
      select d.job_id from job_dependencies d join reach r on d.depends_on_job_id = r.id join jobs j on j.id = d.job_id
      where j.state = 'open'
    )
    update jobs j set state = 'skipped' from reach where j.id = reach.id
    returning j.id`.execute(trx)
  if (rows.length === 0) return []
  // Named by the job that ended, so every skipped run points at the cause, not at the skipped job in between.
  const skipped = await trx
    .updateTable('runs')
    .set({
      state: 'skipped',
      finished_at: sql<Date>`now()`,
      failure_summary: skippedSummary(ref ?? jobId, state),
    })
    .where(
      'job_id',
      'in',
      rows.map((row) => row.id),
    )
    .where('state', '=', 'queued')
    .returning('id')
    .execute()
  return skipped.map((row) => row.id)
}
