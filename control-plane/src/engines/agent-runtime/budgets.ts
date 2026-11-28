import { sql } from 'kysely'
import { fail } from '../../errors/error.ts'
import { findJobType } from '../../job-types/service.ts'
import { type Ctx, findMember, findProject, run, type TenantCtx, type Trx } from '../../planning/resolve.ts'

// Agent budgets (P4 design §2.C 20): per project, for one job type or for the member who made the job. The daily caps
// hold queued runs in placement (run_over_budget, migrations/0033), which delays a run and never kills one (manifesto
// §6); usd_per_run reaches the runtime as its own per-run cap (engine.ts). Setting one is a human decision (DR453).

export type BudgetInput = {
  projectKey: string
  jobType?: string
  member?: string
  // null removes that cap; a budget with no cap left is removed.
  usdPerDay: number | null
  tokensPerDay: number | null
  usdPerRun: number | null
}

export type BudgetView = {
  subject: { kind: 'job_type' | 'member'; key: string }
  usdPerDay: number | null
  tokensPerDay: number | null
  usdPerRun: number | null
  // Spent today, in the tenant's time zone, by the runs that finished.
  today: { usd: number; tokens: number }
  overBudget: boolean
}

const num = (value: string | null): number | null => (value === null ? null : Number(value))

/** Creates, changes or (with every cap null) removes the budget of one job type or member of the project. */
export async function setBudget(ctx: Ctx, input: BudgetInput): Promise<BudgetView | null> {
  if (ctx.actor.kind !== 'human') fail('DR453', { action: 'set an agent budget' })
  if ((input.jobType === undefined) === (input.member === undefined)) {
    fail('DR101', { path: '/', reason: 'give jobType or member, not both' })
  }
  return run(ctx, async (trx) => {
    const project = await findProject(trx, input.projectKey)
    const subject =
      input.jobType === undefined
        ? { member_id: (await findMember(trx, input.member as string)).id, job_type_id: null }
        : { job_type_id: (await findJobType(trx, project.id, input.jobType)).id, member_id: null }
    // Replaced whole: a budget is its caps together, and the unique indexes allow one per subject.
    await trx
      .deleteFrom('agent_budgets')
      .where('project_id', '=', project.id)
      .$if(subject.job_type_id !== null, (query) => query.where('job_type_id', '=', subject.job_type_id as string))
      .$if(subject.member_id !== null, (query) => query.where('member_id', '=', subject.member_id as string))
      .execute()
    if (input.usdPerDay === null && input.tokensPerDay === null && input.usdPerRun === null) return null
    await trx
      .insertInto('agent_budgets')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        ...subject,
        usd_per_day: input.usdPerDay,
        tokens_per_day: input.tokensPerDay,
        usd_per_run: input.usdPerRun,
        updated_by: ctx.actor.id,
      })
      .execute()
    const views = await loadBudgets(trx, project.id)
    const key = input.jobType ?? input.member
    return (
      views.find((view) => view.subject.key === key && view.subject.kind === (input.jobType ? 'job_type' : 'member')) ??
      null
    )
  })
}

export function listBudgets(ctx: TenantCtx, projectKey: string): Promise<BudgetView[]> {
  return run(ctx, async (trx) => loadBudgets(trx, (await findProject(trx, projectKey)).id))
}

async function loadBudgets(trx: Trx, projectId: string): Promise<BudgetView[]> {
  const { rows } = await sql<{
    kind: 'job_type' | 'member'
    key: string
    usd_per_day: string | null
    tokens_per_day: string | null
    usd_per_run: string | null
    usd: string
    tokens: string
  }>`
    select case when b.job_type_id is null then 'member' else 'job_type' end as kind,
      coalesce(jt.key, m.name) as key, b.usd_per_day, b.tokens_per_day, b.usd_per_run, spent.usd, spent.tokens
    from agent_budgets b
    join tenants t on t.id = b.tenant_id
    left join job_types jt on jt.id = b.job_type_id
    left join members m on m.id = b.member_id
    cross join lateral (
      select coalesce(sum(s.cost_usd), 0) as usd,
        coalesce(sum(coalesce(s.tokens_in, 0) + coalesce(s.tokens_out, 0)), 0) as tokens
      from runs s
      join jobs sj on sj.id = s.job_id
      where s.project_id = b.project_id
        and s.finished_at >= (date_trunc('day', now() at time zone t.timezone) at time zone t.timezone)
        and (s.cost_usd is not null or s.tokens_in is not null)
        and (s.job_type_id = b.job_type_id or sj.created_by = b.member_id)
    ) spent
    where b.project_id = ${projectId}
    order by 1, 2`.execute(trx)
  return rows.map((row) => {
    const usd = Number(row.usd)
    const tokens = Number(row.tokens)
    const usdPerDay = num(row.usd_per_day)
    const tokensPerDay = num(row.tokens_per_day)
    return {
      subject: { kind: row.kind, key: row.key },
      usdPerDay,
      tokensPerDay,
      usdPerRun: num(row.usd_per_run),
      today: { usd, tokens },
      overBudget: (usdPerDay !== null && usd >= usdPerDay) || (tokensPerDay !== null && tokens >= tokensPerDay),
    }
  })
}

/** The lowest usd_per_run of the budgets that apply to a run of `jobTypeId` made by `memberId`, if any. */
export async function usdPerRun(trx: Trx, projectId: string, jobTypeId: string, memberId: string) {
  const row = await trx
    .selectFrom('agent_budgets')
    .select((eb) => eb.fn.min('usd_per_run').as('cap'))
    .where('project_id', '=', projectId)
    .where((eb) => eb.or([eb('job_type_id', '=', jobTypeId), eb('member_id', '=', memberId)]))
    .executeTakeFirst()
  return row?.cap == null ? undefined : Number(row.cap)
}
