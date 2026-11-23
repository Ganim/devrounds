import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import type { FailureClass, GateState } from '../db/schema.ts'
import { putJobType } from '../job-types/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import { gateIndicators } from './indicators.ts'
import { submitGate } from './service.ts'

const projectKey = 'devrounds'

// The local day 2026-11-10 in America/Sao_Paulo (UTC-3).
const DAY_10 = { period: 'day' as const, from: new Date('2026-11-10T03:00:00Z'), to: new Date('2026-11-11T02:59:59Z') }

type Check = { jobType?: 'check' | 'lint'; failed?: FailureClass | true; cached?: boolean }
type Gate = {
  key?: string
  state: GateState
  wallS?: number
  finishedAt?: string
  checks?: Check[]
}

// A tenant in America/Sao_Paulo with project `devrounds`, job types `check` and `lint` and machine `build-01`. A gate
// is submitted for real (so its batch, jobs and runs exist), then its ends are set by hand.
async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  await t.admin
    .updateTable('tenants')
    .set({ timezone: 'America/Sao_Paulo' })
    .where('id', '=', tenant.tenantId)
    .execute()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  for (const key of ['check', 'lint']) {
    await putJobType(ctx, projectKey, { key, command: { program: 'node', args: [key] } })
  }
  await withTenant(t.db, tenant.tenantId, (trx) =>
    trx
      .insertInto('machines')
      .values({
        tenant_id: tenant.tenantId,
        name: 'build-01',
        token_hash: randomBytes(32),
        os: 'windows',
        executor_version: '0.1.0',
      })
      .execute(),
  )
  let n = 0
  let anyRun: string | undefined
  const gate = async (g: Gate) => {
    const checks = g.checks ?? [{}]
    const view = await submitGate(ctx, projectKey, {
      file: {
        key: g.key ?? 'pre-pr',
        checks: checks.map((c, i) => ({ ref: `c${i}`, job_type: c.jobType ?? 'check' })),
      },
      cwd: `C:srcw${++n}`,
      machine: 'build-01',
    })
    const finished = Date.parse(g.finishedAt ?? '2026-11-10T15:00:00Z')
    if (g.state !== 'running') {
      await t.admin
        .updateTable('gates')
        .set({
          state: g.state,
          created_at: new Date(finished - (g.wallS ?? 1) * 1000),
          finished_at: new Date(finished),
        })
        .where('id', '=', view.id)
        .execute()
    }
    for (const [i, c] of checks.entries()) {
      const run = view.checks.find((v) => v.ref === `c${i}`)?.runId as string
      anyRun ??= run
      await t.admin
        .updateTable('runs')
        .set({
          state: c.failed ? 'failed' : 'finished',
          failure_class: c.failed === true ? 'unclassified' : (c.failed ?? null),
          cached_from_run_id: c.cached ? anyRun : null,
        })
        .where('id', '=', run)
        .execute()
    }
    return view
  }
  return { t, ctx, gate }
}

test('pass rate counts passed over passed + failed, cancelled apart', async () => {
  const { ctx, gate } = await setup()
  await gate({ state: 'passed' })
  await gate({ state: 'passed' })
  await gate({ state: 'passed' })
  await gate({ state: 'failed', checks: [{ failed: 'check_red' }] })
  await gate({ state: 'cancelled' })
  await gate({ key: 'only-cancelled', state: 'cancelled' })

  const { gates } = await gateIndicators(ctx, projectKey, DAY_10)
  assert.deepEqual(
    gates.map((g) => [g.period, g.gate, g.gates, g.passed, g.failed, g.cancelled, g.passRate]),
    [
      ['2026-11-10', 'only-cancelled', 1, 0, 0, 1, null],
      ['2026-11-10', 'pre-pr', 5, 3, 1, 1, 0.75],
    ],
  )
})

test('cache hit share is cached checks over all checks', async () => {
  const { ctx, gate } = await setup()
  await gate({ state: 'passed' }) // the source run of the hits
  await gate({ state: 'passed', checks: [{ cached: true }, { jobType: 'lint', cached: true }, {}] })

  const { gates } = await gateIndicators(ctx, projectKey, DAY_10)
  assert.equal(gates[0].cacheHitShare, 2 / 4)
})

test('red counts check_red failures per job type, other classes only in failed', async () => {
  const { ctx, gate } = await setup()
  await gate({
    state: 'failed',
    checks: [{ failed: 'check_red' }, { jobType: 'lint', failed: 'infra' }, { jobType: 'lint', failed: true }, {}],
  })
  await gate({ state: 'failed', checks: [{ failed: 'check_red' }, { jobType: 'lint', failed: 'check_red' }] })

  const { checks } = await gateIndicators(ctx, projectKey, DAY_10)
  assert.deepEqual(
    checks.map((c) => [c.jobType, c.checks, c.red, c.failed, c.cached]),
    [
      ['check', 3, 2, 2, 0],
      ['lint', 3, 1, 3, 0],
    ],
  )
})

test('wall p50 and p90 interpolate created to finished', async () => {
  const { ctx, gate } = await setup()
  for (const wallS of [10, 20, 30, 40, 50]) await gate({ state: 'passed', wallS })

  const { gates } = await gateIndicators(ctx, projectKey, DAY_10)
  assert.deepEqual([gates[0].wallP50Ms, gates[0].wallP90Ms], [30_000, 46_000])
})

test('running gates are not counted', async () => {
  const { ctx, gate } = await setup()
  await gate({ state: 'running' })
  const { gates, checks } = await gateIndicators(ctx, projectKey, DAY_10)
  assert.deepEqual([gates, checks], [[], []])
})

test("another tenant's gates are not seen", async () => {
  const mine = await setup()
  await mine.gate({ state: 'passed' })
  const other = await setup()
  const { gates, checks } = await gateIndicators(other.ctx, projectKey, DAY_10)
  assert.deepEqual([gates, checks], [[], []])
  assert.equal((await gateIndicators(mine.ctx, projectKey, DAY_10)).gates.length, 1)
})
