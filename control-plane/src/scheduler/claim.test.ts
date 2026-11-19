import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'kysely'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun, submitBatch } from '../jobs/enqueue.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { putQueue } from '../queues/service.ts'
import { storedNeed } from '../runs/learned-need.ts'
import { applyRunEvent, createRun, markOffered } from '../runs/record.ts'
import { withTenant } from '../tenancy/scope.ts'
import { TEST_APP_ROLE, testDb } from '../test-support/db.ts'
import { claimRun, defaultReserve } from './claim.ts'

const projectKey = 'devrounds'
const MIB = 1024n * 1024n
const GIB = 1024n * MIB
const PLENTY = 64n * GIB

// A tenant with project `devrounds`, job type `check` and live machines `build-01` and `build-02`.
async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await putJobType(ctx, projectKey, { key: 'check', command: { program: 'pnpm', args: ['check'] } })
  const machines = await withTenant(t.db, tenant.tenantId, (trx) =>
    trx
      .insertInto('machines')
      .values(
        ['build-01', 'build-02'].map((name) => ({
          tenant_id: tenant.tenantId,
          name,
          token_hash: randomBytes(32),
          os: 'windows',
          executor_version: '0.1.0',
        })),
      )
      .returning(['id', 'name'])
      .execute(),
  )
  const machineId = (name: string) => machines.find((m) => m.name === name)?.id as string
  const ids = await withTenant(t.db, tenant.tenantId, (trx) =>
    trx.selectFrom('job_types').select(['id as jobTypeId', 'project_id as projectId']).executeTakeFirstOrThrow(),
  )
  const enqueue = async (i: { queueKey?: string; machineName?: string } = {}) =>
    (await enqueueRun(ctx, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work', ...i })).id
  const claim = (machine = 'build-01', freeBytes = PLENTY, reserveBytes = 0n) =>
    withTenant(t.db, tenant.tenantId, (trx) =>
      claimRun(trx, machineId(machine), { freeBytes, reserveBytes, offerTimeoutS: 120 }),
    )
  // Sets the learned need of `check` on `machine`, as updateLearnedNeed would after runs reported their peaks.
  const learn = (needBytes: bigint, machine = 'build-01') =>
    withTenant(t.db, tenant.tenantId, (trx) =>
      trx
        .insertInto('learned_needs')
        .values({
          tenant_id: tenant.tenantId,
          project_id: ids.projectId,
          job_type_id: ids.jobTypeId,
          machine_id: machineId(machine),
          need_bytes: needBytes,
          samples: 1,
        })
        .onConflict((oc) =>
          oc.columns(['project_id', 'job_type_id', 'machine_id']).doUpdateSet({ need_bytes: needBytes }),
        )
        .execute(),
    )
  const setRun = (runId: string, set: Record<string, unknown>) =>
    t.admin.updateTable('runs').set(set).where('id', '=', runId).execute()
  return { t, tenant, ctx, machineId, ids, enqueue, claim, learn, setRun }
}

test('defaultReserve is a tenth of the total, at most 2 GiB', () => {
  assert.equal(defaultReserve(8n * GIB), (8n * GIB) / 10n)
  assert.equal(defaultReserve(64n * GIB), 2n * GIB)
})

test('claims by queue priority, then FIFO', async () => {
  const s = await setup()
  await putQueue(s.ctx, projectKey, { key: 'high', priority: 10 })
  const low = await s.enqueue()
  const first = await s.enqueue({ queueKey: 'high' })
  const second = await s.enqueue({ queueKey: 'high' })

  const claimed = [await s.claim(), await s.claim(), await s.claim(), await s.claim()]
  assert.deepEqual(
    claimed.map((c) => c?.runId ?? null),
    [first, second, low, null],
  )

  const row = await s.t.admin
    .selectFrom('runs')
    .select(['state', 'machine_id', 'memory_need', sql<boolean>`offered_at is not null`.as('stamped')])
    .select(sql<number>`extract(epoch from offer_expires_at - offered_at)::int`.as('timeout'))
    .where('id', '=', first)
    .executeTakeFirstOrThrow()
  assert.deepEqual(row, {
    state: 'offered',
    machine_id: s.machineId('build-01'),
    memory_need: '536870912',
    stamped: true,
    timeout: 120,
  })
})

test('a job waits until every dependency job is finished', async () => {
  const s = await setup()
  const batch = await submitBatch(s.ctx, projectKey, {
    jobs: [
      { ref: 'a', job_type: 'check', cwd: 'C:\\work' },
      { ref: 'b', job_type: 'check', cwd: 'C:\\work' },
      { ref: 'c', job_type: 'check', cwd: 'C:\\work', depends_on: ['a', 'b'] },
    ],
  })
  const job = (ref: string) => batch.jobs.find((j) => j.ref === ref) as (typeof batch.jobs)[number]
  const firstTwo = [(await s.claim())?.runId, (await s.claim())?.runId].sort()
  assert.deepEqual(firstTwo, [job('a').runId, job('b').runId].sort())
  assert.equal(await s.claim(), null)

  await s.t.admin.updateTable('jobs').set({ state: 'finished' }).where('id', '=', job('a').jobId).execute()
  await s.t.admin.updateTable('jobs').set({ state: 'failed' }).where('id', '=', job('b').jobId).execute()
  assert.equal(await s.claim(), null)

  await s.t.admin.updateTable('jobs').set({ state: 'finished' }).where('id', '=', job('b').jobId).execute()
  assert.equal((await s.claim())?.runId, job('c').runId)
})

test('the queue cap counts offered, admitted and running runs', async () => {
  const s = await setup()
  await putQueue(s.ctx, projectKey, { key: 'capped', concurrency: 2 })
  const runs = [
    await s.enqueue({ queueKey: 'capped' }),
    await s.enqueue({ queueKey: 'capped' }),
    await s.enqueue({ queueKey: 'capped' }),
  ]
  // Another queue is not held back by the cap.
  const free = await s.enqueue()

  assert.equal((await s.claim())?.runId, runs[0])
  await s.setRun(runs[0], { state: 'admitted' })
  assert.equal((await s.claim())?.runId, runs[1])
  await s.setRun(runs[1], { state: 'running' })
  assert.equal((await s.claim())?.runId, free)
  assert.equal(await s.claim(), null)

  await s.setRun(runs[0], { state: 'finished' })
  assert.equal((await s.claim())?.runId, runs[2])
})

test('need must fit free minus reserve minus in-flight needs', async () => {
  const s = await setup()
  await s.learn(GIB)
  const offered = await s.enqueue()
  await s.setRun(offered, { state: 'offered', machine_id: s.machineId('build-01'), memory_need: GIB.toString() })
  const queued = [await s.enqueue(), await s.enqueue(), await s.enqueue()]

  // 4 GiB free − 1 GiB reserve − 1 GiB offered leaves room for two runs of 1 GiB; each claim adds to the in-flight need.
  const claim = () => s.claim('build-01', 4n * GIB, GIB)
  assert.equal((await claim())?.runId, queued[0])
  assert.equal((await claim())?.runId, queued[1])
  assert.equal(await claim(), null)

  // In-flight is per machine: the other machine has the whole 4 GiB − reserve for itself.
  assert.equal((await s.claim('build-02', 4n * GIB, GIB))?.runId, queued[2])
})

test('a burst of 20 claims never offers more need than free minus reserve', async () => {
  const s = await setup()
  for (let i = 0; i < 20; i++) await s.enqueue()

  const claimed = await Promise.all(Array.from({ length: 20 }, () => s.claim('build-01', 8n * GIB, GIB)))
  const offered = claimed.filter((c) => c !== null)
  assert.equal(offered.length, 14)
  assert.equal(new Set(offered.map((c) => c.runId)).size, 14)

  const { total } = await s.t.admin
    .selectFrom('runs')
    .select(sql<string>`sum(memory_need)`.as('total'))
    .where('tenant_id', '=', s.tenant.tenantId)
    .where('state', '=', 'offered')
    .executeTakeFirstOrThrow()
  assert.equal(BigInt(total), 7n * GIB)
})

test('learned need defaults to 536870912 and follows learned_needs', async () => {
  const s = await setup()
  const need = () =>
    withTenant(s.t.db, s.tenant.tenantId, (trx) =>
      storedNeed(trx, s.ids.projectId, s.ids.jobTypeId, s.machineId('build-01')),
    )
  assert.equal(await need(), 536870912n)
  await s.enqueue()
  assert.equal((await s.claim())?.memoryNeed, 536870912n)

  await s.learn(300n * MIB)
  assert.equal(await need(), 300n * MIB)
  await s.enqueue()
  assert.equal((await s.claim())?.memoryNeed, 300n * MIB)

  // A need learned on another machine does not apply here.
  await s.learn(3n * GIB, 'build-02')
  const big = await s.enqueue()
  assert.equal(await s.claim('build-02', 2n * GIB), null)
  assert.equal((await s.claim('build-01', 2n * GIB))?.runId, big)
})

test('a run pinned to another machine is not claimed', async () => {
  const s = await setup()
  const pinned = await s.enqueue({ machineName: 'build-02' })
  assert.equal(await s.claim('build-01'), null)
  assert.equal((await s.claim('build-02'))?.runId, pinned)
})

test('a run with not_before in the future is not claimed', async () => {
  const s = await setup()
  const later = await s.enqueue()
  await s.setRun(later, { not_before: sql`now() + interval '1 hour'` })
  assert.equal(await s.claim(), null)
  await s.setRun(later, { not_before: sql`now() - interval '1 second'` })
  assert.equal((await s.claim())?.runId, later)
})

test('a revoked machine claims nothing', async () => {
  const s = await setup()
  await s.enqueue()
  await s.t.admin
    .updateTable('machines')
    .set({ revoked_at: new Date() })
    .where('id', '=', s.machineId('build-01'))
    .execute()
  assert.equal(await s.claim('build-01'), null)
  assert.ok(await s.claim('build-02'))
})

test('a queued run of another tenant is never returned', async () => {
  const a = await setup()
  const b = await setup()
  const theirs = await b.enqueue()
  assert.equal(await a.claim(), null)
  // A's transaction naming B's machine claims nothing either: the machine must belong to the current tenant.
  const crossed = await withTenant(a.t.db, a.tenant.tenantId, (trx) =>
    claimRun(trx, b.machineId('build-01'), { freeBytes: PLENTY, reserveBytes: 0n, offerTimeoutS: 120 }),
  )
  assert.equal(crossed, null)
  assert.equal((await b.claim())?.runId, theirs)
})

test('two concurrent claims never take the same run', async () => {
  const s = await setup()
  const only = await s.enqueue()
  const one = await Promise.all([s.claim('build-01'), s.claim('build-02')])
  assert.deepEqual(one.map((c) => c?.runId ?? null).sort(), [null, only].sort())

  const runs = [await s.enqueue(), await s.enqueue()]
  const two = await Promise.all([s.claim('build-01'), s.claim('build-02')])
  assert.deepEqual(two.map((c) => c?.runId).sort(), [...runs].sort())
})

test('public cannot execute claim_run; the app role can', async () => {
  const { admin } = await testDb()
  const fn = 'claim_run(uuid, bigint, bigint, integer)'
  const { rows } = await sql<{ pub: boolean; app: boolean; definer: boolean; config: string[] }>`
    select has_function_privilege('public', ${fn}, 'execute') as pub,
      has_function_privilege(${TEST_APP_ROLE}, ${fn}, 'execute') as app,
      p.prosecdef as definer, p.proconfig as config
    from pg_proc p where p.oid = ${fn}::regprocedure`.execute(admin)
  assert.deepEqual(rows, [
    { pub: false, app: true, definer: true, config: ['search_path=pg_catalog, public, pg_temp'] },
  ])
  // The app role really calls it: an unknown machine claims nothing.
  const s = await setup()
  const none = await withTenant(s.t.db, s.tenant.tenantId, (trx) =>
    claimRun(trx, '00000000-0000-4000-8000-000000000000', { freeBytes: PLENTY, reserveBytes: 0n, offerTimeoutS: 5 }),
  )
  assert.equal(none, null)
})

test('a RunFinished with a peak updates learned_needs to the median of the last 10 peaks', async () => {
  const s = await setup()
  const machineId = s.machineId('build-01')
  const row = () =>
    s.t.admin
      .selectFrom('learned_needs')
      .select(['tenant_id', 'need_bytes', 'samples'])
      .where('project_id', '=', s.ids.projectId)
      .where('job_type_id', '=', s.ids.jobTypeId)
      .where('machine_id', '=', machineId)
      .executeTakeFirst()
  assert.equal(await row(), undefined)

  // 12 runs; the two oldest (huge) fall out of the window, leaving peaks 1..10 MiB: median = 5.5 MiB.
  const peaks = [1000, 1000, 3, 1, 4, 10, 5, 9, 2, 6, 8, 7].map((mib) => mib * Number(MIB))
  const base = Date.now() + 1000
  for (const [i, peak] of peaks.entries()) {
    const created = await createRun(s.ctx, {
      projectKey,
      jobTypeKey: 'check',
      machineName: 'build-01',
      cwd: 'C:\\work',
    })
    await markOffered(s.ctx, created.id)
    const at = new Date(base + i * 1000)
    await applyRunEvent(s.ctx, machineId, { kind: 'Admitted', run: created.id }, at)
    await applyRunEvent(
      s.ctx,
      machineId,
      { kind: 'RunStarted', run: created.id, pid: 1, start_time: '1', boot_id: 'b' },
      at,
    )
    await applyRunEvent(
      s.ctx,
      machineId,
      {
        kind: 'RunFinished',
        run: created.id,
        reason: 'exited',
        exit_code: 0,
        peak,
        p95: peak,
        p50: peak,
        cpu_seconds: 1,
        swept: 0,
        visible_windows: 0,
        tail: [],
        summary: null,
      },
      at,
    )
    if (i === 0)
      assert.deepEqual(await row(), { tenant_id: s.tenant.tenantId, need_bytes: String(1000n * MIB), samples: 1 })
  }
  assert.deepEqual(await row(), {
    tenant_id: s.tenant.tenantId,
    need_bytes: String((11n * MIB) / 2n),
    samples: 10,
  })
  const stored = await withTenant(s.t.db, s.tenant.tenantId, (trx) =>
    storedNeed(trx, s.ids.projectId, s.ids.jobTypeId, machineId),
  )
  assert.equal(stored, (11n * MIB) / 2n)
})
