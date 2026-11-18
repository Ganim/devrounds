import { sql } from 'kysely'
import { fail } from '../errors/error.ts'
import { type Ctx, findProject, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import type { ClassifyRule } from '../runs/classify.ts'
import { findJobTypeIssue, type JobTypeDef, type JobTypeFile, withDefaults } from './file.ts'

const COLUMNS = ['id', 'key', 'program', 'args', 'env_allow', 'timeout_s', 'orphan_policy', 'classify'] as const

type JobTypeRow = {
  id: string
  key: string
  program: string
  args: unknown
  env_allow: string[]
  timeout_s: number
  orphan_policy: 'kill' | 'let_finish'
  classify: unknown
}

export function toDef(row: JobTypeRow): JobTypeDef {
  return {
    key: row.key,
    command: { program: row.program, args: row.args as string[] },
    env: row.env_allow,
    timeout_s: row.timeout_s,
    orphan_policy: row.orphan_policy,
    classify: row.classify as ClassifyRule[],
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
 * Creates or replaces the job type `input.key` of the project. Runs read the classify rules when they finish, so a
 * change also applies to runs still in flight.
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
