import { fail } from '../../errors/error.ts'
import { findProject, run, type TenantCtx } from '../../planning/resolve.ts'
import { requireRunId } from '../../runs/view.ts'
import type { AgentDef } from './contract.ts'
import { RESULT_DATA_MAX } from './engine.ts'

export type RunResult = { label: string; data: Record<string, unknown> }
export type RunResultView = RunResult & { reportedBy: string | null; at: Date }

/**
 * Records the result run `runId` reports (`devrounds run result`), once, while it runs; the run's end reads it
 * (settleAgentRun). Who may report: any member of the tenant with a token, which an agent run gets through its job
 * type's env; P4-T02's per-run token narrows that to the run itself. DR201 for a run not in the project, DR101 for a
 * job type that does not take reported results or data past 64 KiB, DR351 for a run not running, DR353 for a second
 * report.
 */
export function reportResult(
  ctx: TenantCtx & { actor: { id: string } },
  projectKey: string,
  runId: string,
  result: RunResult,
): Promise<RunResultView> {
  requireRunId(runId)
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    // Locked, so a RunFinished applied at the same time reads this row or ends the run before it is written.
    const row = await trx
      .selectFrom('runs')
      .innerJoin('job_types', 'job_types.id', 'runs.job_type_id')
      .select(['runs.state', 'job_types.agent'])
      .where('runs.id', '=', runId)
      .where('runs.project_id', '=', project.id)
      .forNoKeyUpdate('runs')
      .executeTakeFirst()
    if (!row) fail('DR201', { kind: 'run', key: runId })
    const agent = row.agent as AgentDef | null
    if (agent?.result.kind !== 'reported') {
      fail('DR101', { path: '/label', reason: "the run's job type does not take a reported result" })
    }
    const data = JSON.stringify(result.data)
    if (Buffer.byteLength(data) > RESULT_DATA_MAX) {
      fail('DR101', { path: '/data', reason: `is over ${RESULT_DATA_MAX} bytes as JSON` })
    }
    if (row.state !== 'running') fail('DR351', { run: runId, state: row.state })
    const inserted = await trx
      .insertInto('run_results')
      .values({ tenant_id: ctx.tenantId, run_id: runId, label: result.label, data, reported_by: ctx.actor.id })
      .onConflict((oc) => oc.column('run_id').doNothing())
      .returning(['at'])
      .executeTakeFirst()
    if (!inserted) fail('DR353', { run: runId })
    return { ...result, reportedBy: ctx.actor.id, at: inserted.at }
  })
}
