import { sql } from 'kysely'
import type { FailureClass } from '../db/schema.ts'
import type { JobTypeEnvironment } from '../environments/index.ts'
import { fail } from '../errors/error.ts'
import { type Ctx, findProject, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import type { ClassifyRule } from '../runs/classify.ts'
import { findJobTypeIssue, type JobTypeDef, type JobTypeFile, withDefaults } from './file.ts'

const COLUMNS = [
  'id',
  'key',
  'program',
  'args',
  'env_allow',
  'timeout_s',
  'orphan_policy',
  'classify',
  'max_attempts',
  'retry_backoff_s',
  'retry_on',
  'args_from_job',
  'job_env',
  'env_set',
  'need_bytes',
  'environment',
] as const

type JobTypeRow = {
  id: string
  key: string
  program: string
  args: unknown
  env_allow: string[]
  timeout_s: number
  orphan_policy: 'kill' | 'let_finish'
  classify: unknown
  max_attempts: number
  retry_backoff_s: number
  retry_on: FailureClass[]
  args_from_job: boolean
  job_env: string[]
  env_set: unknown
  need_bytes: string | null
  environment: unknown
}

const MIB = 1048576n

export function toDef(row: JobTypeRow): JobTypeDef {
  return {
    key: row.key,
    command: { program: row.program, args: row.args as string[] },
    env: row.env_allow,
    timeout_s: row.timeout_s,
    orphan_policy: row.orphan_policy,
    classify: row.classify as ClassifyRule[],
    retry: { max_attempts: row.max_attempts, backoff_s: row.retry_backoff_s, on: row.retry_on },
    args_from_job: row.args_from_job,
    job_env: row.job_env,
    env_set: row.env_set as Record<string, string>,
    need_mb: row.need_bytes === null ? null : Number(BigInt(row.need_bytes) / MIB),
    environment: row.environment as JobTypeEnvironment | null,
  }
}

export async function findJobType(trx: Trx, projectId: string, key: string): Promise<JobTypeRow> {
  const row = await trx
    .selectFrom('job_types')
    .select(COLUMNS)
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .executeTakeFirst()
  return row ?? fail('DR201', { kind: 'job type', key })
}

/**
 * Creates or replaces the job type `input.key` of the project. Runs read the classify rules and the retry policy
 * when they end, so a change also applies to runs still in flight.
 */
export async function putJobType(ctx: Ctx, projectKey: string, input: JobTypeFile): Promise<JobTypeDef> {
  const issue = findJobTypeIssue(input)
  if (issue) fail('DR101', issue)
  const def = withDefaults(input)
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const values = {
      program: def.command.program,
      args: JSON.stringify(def.command.args),
      env_allow: def.env,
      timeout_s: def.timeout_s,
      orphan_policy: def.orphan_policy,
      classify: JSON.stringify(def.classify),
      max_attempts: def.retry.max_attempts,
      retry_backoff_s: def.retry.backoff_s,
      retry_on: def.retry.on,
      args_from_job: def.args_from_job,
      job_env: def.job_env,
      env_set: JSON.stringify(def.env_set),
      need_bytes: def.need_mb === null ? null : (BigInt(def.need_mb) * MIB).toString(),
      environment: def.environment === null ? null : JSON.stringify(def.environment),
    }
    await trx
      .insertInto('job_types')
      .values({ tenant_id: ctx.tenantId, project_id: project.id, key: def.key, ...values })
      .onConflict((oc) => oc.columns(['project_id', 'key']).doUpdateSet({ ...values, updated_at: sql<Date>`now()` }))
      .execute()
    return def
  })
}

export function getJobType(ctx: TenantCtx, projectKey: string, key: string): Promise<JobTypeDef> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    return toDef(await findJobType(trx, project.id, key))
  })
}
