import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import type { RunState } from '../db/schema.ts'
import { DevRoundsError } from '../errors/error.ts'
import { submitGate } from '../gates/service.ts'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun } from '../jobs/enqueue.ts'
import type { Ctx } from '../planning/resolve.ts'
import { addTask, createProject } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import type { Violation } from './check.ts'
import { type CheckInput, conventionIndicators, recordCheck } from './results.ts'
import { decide, propose } from './service.ts'

const projectKey = 'devrounds'

// The local day 2026-11-10 in America/Sao_Paulo (UTC-3).
const DAY_10 = { period: 'day' as const, from: new Date('2026-11-10T03:00:00Z'), to: new Date('2026-11-11T02:59:59Z') }

const evidence = [{ path: 'AGENTS.md', excerpt: 'Never', role: 'source' as const }]
const rule = (key: string, check: object) => ({ key, section: 'Never', title: key, why: 'why', check, evidence })
const pattern = (key: string) => ({
  ...rule(key, { kind: 'pattern', forbid: 'TODO' }),
  paths: ['**/*.ts'],
  examples: { bad: ['// TODO'] },
})

// A tenant in America/Sao_Paulo with projects `devrounds` (version 1 active: pattern rules a, b, c, a path rule, a
// job_type rule and a judgment rule) and `other`, job type `conventions-check` in both, and machine `build-01`.
async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  await t.admin
    .updateTable('tenants')
    .set({ timezone: 'America/Sao_Paulo' })
    .where('id', '=', tenant.tenantId)
    .execute()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  for (const key of [projectKey, 'other']) {
    await createProject(ctx, { key, name: key })
    await putJobType(ctx, key, { key: 'conventions-check', command: { program: 'node', args: ['check'] } })
  }
  await addTask(ctx, { projectKey, key: 'P3-T07', title: 'Conventions' })
  await propose(ctx, projectKey, {
    document: {
      targets: [{ path: 'AGENTS.md' }],
      rules: [
        pattern('a'),
        pattern('b'),
        pattern('c'),
        rule('new-test', { kind: 'path', forbid_new: 'src/**/*.test.ts' }),
        rule('tests', { kind: 'job_type', enforced_by: 'devrounds-test' }),
        rule('adapters', { kind: 'judgment' }),
      ],
    },
    basedOn: null,
    headSha: null,
    task: 'P3-T07',
  })
  await decide(ctx, projectKey, 1, 'approve', undefined)
  const [machine] = await withTenant(t.db, tenant.tenantId, (trx) =>
    trx
      .insertInto('machines')
      .values({
        tenant_id: tenant.tenantId,
        name: 'build-01',
        token_hash: randomBytes(32),
        os: 'windows',
        executor_version: '0.1.0',
      })
      .returning('id')
      .execute(),
  )
  const setRun = (id: string, state: RunState) =>
    t.admin.updateTable('runs').set({ state, machine_id: machine.id }).where('id', '=', id).execute()
  // A running run of the project's check job type.
  const running = async (key = projectKey) => {
    const view = await enqueueRun(ctx, { projectKey: key, jobTypeKey: 'conventions-check', cwd: 'C:\\work' })
    await setRun(view.id, 'running')
    return view.id
  }
  // When the check was recorded, so it lands on a local day.
  const at = (runId: string, iso: string) =>
    t.admin
      .updateTable('convention_checks')
      .set({ created_at: new Date(iso) })
      .where('run_id', '=', runId)
      .execute()
  return { t, ctx, setRun, running, at }
}

const hit = (rule: string, severity: 'warn' | 'block', line = 1): Violation => ({
  rule,
  severity,
  path: 'src/x.ts',
  line,
  excerpt: '// TODO',
})

const input = (runId: string, violations: Violation[] = []): CheckInput => ({
  runId,
  version: 1,
  source: 'mechanical',
  filesChecked: 2,
  violations,
})

async function refusal(promise: Promise<unknown>): Promise<{ code: string; data: unknown }> {
  const err = await promise.then(
    () => assert.fail('expected a refusal'),
    (e: unknown) => e,
  )
  assert.ok(err instanceof DevRoundsError, String(err))
  return { code: err.code, data: err.data }
}

test('a check for a run of another project is DR201; a finished run or a second result is DR312', async () => {
  const { ctx, running, setRun } = await setup()
  const foreign = await running('other')
  assert.deepEqual(await refusal(recordCheck(ctx, projectKey, input(foreign))), {
    code: 'DR201',
    data: { kind: 'run', key: foreign },
  })

  const finished = await running()
  await setRun(finished, 'finished')
  assert.deepEqual(await refusal(recordCheck(ctx, projectKey, input(finished))), {
    code: 'DR312',
    data: { run: finished, state: 'finished' },
  })

  const once = await running()
  await recordCheck(ctx, projectKey, input(once))
  assert.deepEqual(await refusal(recordCheck(ctx, projectKey, input(once))), {
    code: 'DR312',
    data: { run: once, state: 'checked' },
  })
})

test('600 violations keep 500, blocking first, and count 600', async () => {
  const { t, ctx, running } = await setup()
  const runId = await running()
  const violations = [
    ...Array.from({ length: 590 }, (_, i) => hit('a', 'warn', i + 1)),
    ...Array.from({ length: 10 }, (_, i) => hit('b', 'block', i + 1)),
  ]
  const recorded = await recordCheck(ctx, projectKey, input(runId, violations))
  assert.deepEqual(recorded, { runId, version: 1, blocking: 10, warnings: 590, kept: 500 })
  const row = await t.admin
    .selectFrom('convention_checks')
    .select(['blocking', 'warnings', 'violations'])
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()
  const kept = row.violations as Violation[]
  assert.equal(kept.length, 500)
  assert.deepEqual(
    kept.slice(0, 11).map((v) => v.severity),
    [...Array(10).fill('block'), 'warn'],
  )
  assert.deepEqual([row.blocking, row.warnings], [10, 590])
})

test('indicators count blocking per rule per local day and list silent rules', async () => {
  const { t, ctx, setRun, running, at } = await setup()
  // 01:00Z on the 11th is still the 10th in Sao Paulo; 03:30Z on the 11th is the 11th.
  const first = await running()
  await recordCheck(ctx, projectKey, input(first, [hit('a', 'block'), hit('a', 'block', 2), hit('b', 'warn')]))
  await at(first, '2026-11-11T01:00:00Z')
  const second = await running()
  await recordCheck(ctx, projectKey, input(second, [hit('a', 'warn')]))
  await at(second, '2026-11-10T12:00:00Z')
  const nextDay = await running()
  await recordCheck(ctx, projectKey, input(nextDay, [hit('c', 'block')]))
  await at(nextDay, '2026-11-11T03:30:00Z')
  // A failed gate whose conventions check rule `a` blocked.
  const gate = await submitGate(ctx, projectKey, {
    file: { key: 'pre-pr', checks: [{ ref: 'conventions', job_type: 'conventions-check' }] },
    cwd: 'C:\\src\\w1',
    machine: 'build-01',
  })
  const gated = gate.checks[0].runId as string
  await setRun(gated, 'running')
  await recordCheck(ctx, projectKey, input(gated, [hit('a', 'block'), hit('docs_drift', 'block')]))
  await at(gated, '2026-11-10T15:00:00Z')
  await t.admin
    .updateTable('gates')
    .set({ state: 'failed', finished_at: new Date('2026-11-10T15:01:00Z') })
    .where('id', '=', gate.id)
    .execute()

  const day10 = await conventionIndicators(ctx, projectKey, DAY_10)
  assert.deepEqual(day10.periods, [{ period: '2026-11-10', checks: 3, blocked: 2, filesChecked: 6 }])
  assert.deepEqual(
    day10.rows.map((r) => [r.rule, r.kind, r.checks, r.warnings, r.blocking, r.gatesFailed]),
    [
      ['a', 'pattern', 3, 1, 3, 1],
      ['b', 'pattern', 1, 1, 0, 0],
      ['docs_drift', 'drift', 1, 0, 1, 1],
    ],
  )
  // c fired only on the 11th; path rules count as checked, job_type and judgment rules never fire here.
  assert.deepEqual(day10.silentRules, ['c', 'new-test'])
  const week = await conventionIndicators(ctx, projectKey, { ...DAY_10, period: 'week' })
  assert.deepEqual(week.silentRules, ['new-test'])
  assert.deepEqual(
    week.rows.map((r) => [r.period, r.rule, r.blocking]),
    [
      ['2026-11-09', 'a', 3],
      ['2026-11-09', 'b', 0],
      ['2026-11-09', 'c', 1],
      ['2026-11-09', 'docs_drift', 1],
    ],
  )
})

test('mechanicalShare is pattern+path+job_type over all rules', async () => {
  const { ctx } = await setup()
  const indicators = await conventionIndicators(ctx, projectKey, DAY_10)
  assert.equal(indicators.mechanicalShare, 5 / 6)
  assert.deepEqual(indicators.rules, [
    { kind: 'job_type', count: 1 },
    { kind: 'judgment', count: 1 },
    { kind: 'path', count: 1 },
    { kind: 'pattern', count: 3 },
  ])
})
