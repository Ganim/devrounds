import { type Static, Type } from '@sinclair/typebox'
import { sql } from 'kysely'
import { fail } from '../errors/error.ts'
import { type Ctx, findProject, run, type TenantCtx } from '../planning/resolve.ts'
import { isUuid } from '../runs/view.ts'
import { keptViolations, type RuleCounts, ruleCounts } from './check.ts'
import type { ConventionsFile } from './file.ts'

const ViolationInput = Type.Object(
  {
    rule: Type.String({ minLength: 1, maxLength: 100 }),
    severity: Type.Union([Type.Literal('warn'), Type.Literal('block')]),
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    excerpt: Type.String({ maxLength: 200 }),
  },
  { additionalProperties: false },
)

const Count = Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
// 500 rules (file.ts) plus `docs_drift`.
const MAX_COUNTED_RULES = 501

// The body of `POST /conventions/checks` (design call 15). The CLI sends at most 500 violations, blocking first, with
// the exact totals in blocking/warnings and the exact hits per rule in counts, so a change with thousands of hits
// still fits one request and its per-rule indicators stay exact; what is left out is counted from `violations`.
// `review` is P4's (the judgment lens), so only `mechanical` is accepted.
export const CheckInput = Type.Object(
  {
    runId: Type.String({ minLength: 1, maxLength: 100 }),
    version: Type.Integer({ minimum: 1, maximum: 999_999_999 }),
    source: Type.Literal('mechanical'),
    filesChecked: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    violations: Type.Array(ViolationInput),
    blocking: Type.Optional(Count),
    warnings: Type.Optional(Count),
    counts: Type.Optional(
      Type.Record(
        Type.String({ pattern: '^.{1,100}$' }),
        Type.Object({ warn: Count, block: Count }, { additionalProperties: false }),
        { maxProperties: MAX_COUNTED_RULES },
      ),
    ),
  },
  { additionalProperties: false },
)

export type CheckInput = Static<typeof CheckInput>

export type CheckRecorded = { runId: string; version: number; blocking: number; warnings: number; kept: number }

function total(sent: number | undefined, counted: number, path: string): number {
  if (sent !== undefined && sent < counted) fail('DR101', { path, reason: `is below the ${counted} violations sent` })
  return sent ?? counted
}

// The hits per rule to store: `input.counts`, never below the violations sent for a rule, and matching the totals when
// both are sent (indicators read rows from counts and the totals from blocking/warnings, so they must agree).
function countsOf(input: CheckInput): RuleCounts {
  const sent = ruleCounts(input.violations)
  if (!input.counts) return sent
  const counts = input.counts
  for (const [rule, kept] of Object.entries(sent)) {
    const given = Object.hasOwn(counts, rule) ? counts[rule] : { warn: 0, block: 0 }
    for (const severity of ['warn', 'block'] as const) {
      if (given[severity] < kept[severity]) {
        fail('DR101', { path: `/counts/${rule}/${severity}`, reason: `is below the ${kept[severity]} violations sent` })
      }
    }
  }
  for (const [severity, field] of [
    ['block', 'blocking'],
    ['warn', 'warnings'],
  ] as const) {
    const sum = Object.values(counts).reduce((n, c) => n + c[severity], 0)
    const sentTotal = input[field]
    if (sentTotal !== undefined && sentTotal !== sum) {
      fail('DR101', { path: `/${field}`, reason: `does not match the ${sum} in counts` })
    }
  }
  return Object.fromEntries(Object.entries(counts).filter(([, c]) => c.warn + c.block > 0))
}

/**
 * Records the result of the check `input.runId` ran, once per run: a run of another project (or tenant) is DR201, a
 * run that is not running is DR312 with its state, a second result for the run DR312 with state `checked`. Serialized
 * on the run row, so two concurrent posts never reach the unique index.
 */
export async function recordCheck(ctx: Ctx, projectKey: string, input: CheckInput): Promise<CheckRecorded> {
  const counts = countsOf(input)
  const sum = (severity: 'warn' | 'block') => Object.values(counts).reduce((n, c) => n + c[severity], 0)
  const blocking = total(input.blocking, sum('block'), '/blocking')
  const warnings = total(input.warnings, sum('warn'), '/warnings')
  const kept = keptViolations(input.violations)
  if (!isUuid(input.runId)) fail('DR201', { kind: 'run', key: input.runId })
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const found = await trx
      .selectFrom('runs')
      .select(['id', 'state'])
      .where('id', '=', input.runId)
      .where('project_id', '=', project.id)
      .forNoKeyUpdate()
      .executeTakeFirst()
    if (!found) return fail('DR201', { kind: 'run', key: input.runId })
    const recorded = await trx
      .selectFrom('convention_checks')
      .select('id')
      .where('run_id', '=', input.runId)
      .executeTakeFirst()
    if (recorded) fail('DR312', { run: input.runId, state: 'checked' })
    if (found.state !== 'running') fail('DR312', { run: input.runId, state: found.state })
    // Superseded covers an approval landing between the CLI's fetch and its post; a version never approved (or
    // withdrawn) would add hits under kinds nobody approved.
    const set = await trx
      .selectFrom('convention_sets')
      .select('id')
      .where('project_id', '=', project.id)
      .where('version', '=', input.version)
      .where('state', 'in', ['active', 'superseded'])
      .executeTakeFirst()
    if (!set) return fail('DR201', { kind: 'conventions', key: String(input.version) })
    await trx
      .insertInto('convention_checks')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        run_id: input.runId,
        set_id: set.id,
        source: input.source,
        files_checked: input.filesChecked,
        blocking,
        warnings,
        violations: JSON.stringify(kept),
        counts: JSON.stringify(counts),
      })
      .execute()
    return { runId: input.runId, version: input.version, blocking, warnings, kept: kept.length }
  })
}

// One row per local period and rule that had a hit, from each check's exact per-rule counts.
export type ConventionRuleRow = {
  period: string // local YYYY-MM-DD of the day, or of the Monday for weeks
  rule: string // a rule key, or `docs_drift`
  kind: string // the rule's check kind in the version that was checked; `drift` for docs_drift
  checks: number // checks with at least one hit of the rule
  warnings: number
  blocking: number
  gatesFailed: number // failed gates whose conventions check this rule blocked
}

// One row per local period with checks: how many, how many blocked, and the files they read.
export type ConventionPeriodRow = { period: string; checks: number; blocked: number; filesChecked: number }

export type ConventionIndicators = {
  periods: ConventionPeriodRow[]
  rows: ConventionRuleRow[]
  // The active version's rules by check kind (none without an active version).
  rules: { kind: string; count: number }[]
  // pattern + path + job_type over all rules of the active version; null without rules.
  mechanicalShare: number | null
  // Pattern and path rules of the active version (the kinds the check runs) with no hit in the window.
  silentRules: string[]
}

type PeriodRow = { period: string; checks: string; blocked: string; files: string }
type RuleRow = {
  period: string
  rule: string
  kind: string
  checks: string
  warnings: string
  blocking: string
  gates_failed: string
}

const MECHANICAL = new Set(['pattern', 'path', 'job_type'])
const CHECKED = new Set(['pattern', 'path'])

/**
 * Conventions indicators of the project over the local periods from `from` to `to`, whole periods at both ends, by
 * the tenant's local day of the check (plan call 9, as gate indicators). A cached check posts nothing and so counts
 * nothing.
 */
export function conventionIndicators(
  ctx: TenantCtx,
  projectKey: string,
  opts: { period: 'day' | 'week'; from: Date; to: Date },
): Promise<ConventionIndicators> {
  if (opts.from.getTime() > opts.to.getTime()) fail('DR101', { path: '/from', reason: 'from must not be after to' })
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const tenant = await trx
      .selectFrom('tenants')
      .select('timezone')
      .where('id', '=', ctx.tenantId)
      .executeTakeFirstOrThrow()
    const local = (at: unknown) => sql`date_trunc(${opts.period}, ${at} at time zone ${tenant.timezone})`
    // The failed gate a check ran in, if any (gates.batch_id is unique, so at most one).
    const checks = sql`
      checks as (
        select c.id, c.set_id, c.blocking, c.files_checked, c.counts,
          ${local(sql.ref('c.created_at'))} as local_period,
          (select g.id from runs r join jobs j on j.id = r.job_id join gates g on g.batch_id = j.batch_id
            where r.id = c.run_id and g.state = 'failed') as failed_gate
        from convention_checks c
        where c.project_id = ${project.id}
          and ${local(sql.ref('c.created_at'))}
            between ${local(sql`${opts.from}::timestamptz`)} and ${local(sql`${opts.to}::timestamptz`)}
      )`
    const periodRows = await sql<PeriodRow>`
      with ${checks}
      select to_char(local_period, 'YYYY-MM-DD') as period, count(*) as checks,
        count(*) filter (where blocking > 0) as blocked, coalesce(sum(files_checked), 0) as files
      from checks group by local_period order by local_period`.execute(trx)
    const ruleRows = await sql<RuleRow>`
      with ${checks},
      -- Each checked version's rule kinds, read once rather than once per hit (keys are unique in a document).
      kinds as (
        select s.id as set_id, r->>'key' as key, r->'check'->>'kind' as kind
        from convention_sets s cross join jsonb_array_elements(s.document->'rules') r
        where s.id in (select set_id from checks)
      ),
      hits as (
        select c.id, c.local_period, c.failed_gate, h.key as rule, coalesce(k.kind, 'drift') as kind,
          (h.value->>'warn')::int as warn, (h.value->>'block')::int as block
        from checks c cross join jsonb_each(c.counts) h
        left join kinds k on k.set_id = c.set_id and k.key = h.key
      )
      select to_char(local_period, 'YYYY-MM-DD') as period, rule, kind,
        count(distinct id) as checks,
        coalesce(sum(warn), 0) as warnings,
        coalesce(sum(block), 0) as blocking,
        count(distinct failed_gate) filter (where block > 0) as gates_failed
      from hits group by local_period, rule, kind order by local_period, rule, kind`.execute(trx)
    const active = await trx
      .selectFrom('convention_sets')
      .select('document')
      .where('project_id', '=', project.id)
      .where('state', '=', 'active')
      .executeTakeFirst()
    const rules = active ? (active.document as ConventionsFile).rules : []
    const byKind = new Map<string, number>()
    for (const r of rules) byKind.set(r.check.kind, (byKind.get(r.check.kind) ?? 0) + 1)
    const hit = new Set(ruleRows.rows.map((r) => r.rule))
    return {
      periods: periodRows.rows.map((r) => ({
        period: r.period,
        checks: Number(r.checks),
        blocked: Number(r.blocked),
        filesChecked: Number(r.files),
      })),
      rows: ruleRows.rows.map((r) => ({
        period: r.period,
        rule: r.rule,
        kind: r.kind,
        checks: Number(r.checks),
        warnings: Number(r.warnings),
        blocking: Number(r.blocking),
        gatesFailed: Number(r.gates_failed),
      })),
      rules: [...byKind].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => ({ kind, count })),
      mechanicalShare:
        rules.length === 0 ? null : rules.filter((r) => MECHANICAL.has(r.check.kind)).length / rules.length,
      silentRules: rules.filter((r) => CHECKED.has(r.check.kind) && !hit.has(r.key)).map((r) => r.key),
    }
  })
}
