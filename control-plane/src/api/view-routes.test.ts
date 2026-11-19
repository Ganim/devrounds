import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { sql } from 'kysely'
import { createToken } from '../auth/tokens.ts'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun, submitBatch } from '../jobs/enqueue.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { putQueue } from '../queues/service.ts'
import { type TestDb, testDb } from '../test-support/db.ts'
import { buildServer } from './server.ts'

const projectKey = 'devrounds'
const MIB = 1024 * 1024
const GIB = 1024 * MIB

let t: TestDb
let app: ReturnType<typeof buildServer>

before(async () => {
  t = await testDb()
  app = buildServer({ db: t.db, logger: false })
  await app.ready()
})

after(() => app.close())

// A tenant with project `devrounds`, job types `check` and `lint`, queue `nightly`, machine `build-01` paired, and a
// token for its human member.
async function setup() {
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  for (const key of ['check', 'lint']) {
    await putJobType(ctx, projectKey, { key, command: { program: 'pnpm', args: [key] } })
  }
  await putQueue(ctx, projectKey, { key: 'nightly' })
  const { code } = await createPairingCode(ctx, 'build-01')
  const { machineId } = await redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' })
  const token = await createToken(t.admin, tenant.tenantId, 'human', 'human')
  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
    return { status: res.statusCode, body: res.json() }
  }
  return { tenant, ctx, machineId, get }
}

const enqueue = (ctx: Ctx, jobTypeKey: string, queueKey?: string) =>
  enqueueRun(ctx, { projectKey, jobTypeKey, cwd: 'C:\\work', queueKey })

// queued_at with microseconds, which a JS Date cannot hold: a cursor built from a Date would skip or repeat rows.
const setQueuedAt = (id: string, at: string) =>
  t.admin
    .updateTable('runs')
    .set({ queued_at: sql<Date>`${at}::timestamptz` })
    .where('id', '=', id)
    .execute()

test('run list pages newest first with an exact cursor continuation', async () => {
  const { ctx, get } = await setup()
  const runs = []
  for (let i = 0; i < 5; i++) runs.push(await enqueue(ctx, 'check'))
  // Two runs share a timestamp (the id breaks the tie); two differ only in the microsecond.
  const times = [
    '2026-11-01 10:00:00.000001+00',
    '2026-11-01 10:00:00.000002+00',
    '2026-11-01 10:00:00.000003+00',
    '2026-11-01 10:00:00.000003+00',
    '2026-11-01 10:00:01+00',
  ]
  for (const [i, run] of runs.entries()) await setQueuedAt(run.id, times[i])
  const tied = [runs[2].id, runs[3].id].sort().reverse()
  const expected = [runs[4].id, ...tied, runs[1].id, runs[0].id]

  const seen: string[] = []
  const pages: number[] = []
  let cursor: string | null = null
  do {
    const query: string = cursor === null ? '' : `&cursor=${cursor}`
    const { status, body } = await get(`/api/projects/${projectKey}/runs?limit=2${query}`)
    assert.equal(status, 200, JSON.stringify(body))
    seen.push(...body.runs.map((r: { id: string }) => r.id))
    pages.push(body.runs.length)
    cursor = body.nextCursor
    if (cursor !== null) assert.match(cursor, /^[A-Za-z0-9_-]+$/)
  } while (cursor !== null)
  assert.deepEqual(seen, expected)
  assert.deepEqual(pages, [2, 2, 1])

  const { body } = await get(`/api/projects/${projectKey}/runs`)
  const first = body.runs[0]
  assert.deepEqual(Object.keys(first).sort(), [
    'attempt',
    'cause',
    'failureClass',
    'finishedAt',
    'id',
    'jobType',
    'machine',
    'queue',
    'queuedAt',
    'state',
    'totalMs',
  ])
  assert.deepEqual(
    { ...first, queuedAt: undefined },
    {
      id: runs[4].id,
      state: 'queued',
      attempt: 1,
      cause: 'first',
      jobType: 'check',
      queue: 'default',
      machine: null,
      queuedAt: undefined,
      finishedAt: null,
      failureClass: null,
      totalMs: null,
    },
  )

  const bad = await get(`/api/projects/${projectKey}/runs?cursor=not-a-cursor`)
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'DR101')
  assert.equal(bad.body.data.path, 'querystring/cursor')
  const tooMany = await get(`/api/projects/${projectKey}/runs?limit=101`)
  assert.equal(tooMany.body.code, 'DR101')
})

test('run list filters by state and job type', async () => {
  const { ctx, machineId, get } = await setup()
  const check = await enqueue(ctx, 'check')
  const lint = await enqueue(ctx, 'lint')
  const nightly = await enqueue(ctx, 'check', 'nightly')
  await t.admin
    .updateTable('runs')
    .set({
      state: 'failed',
      machine_id: machineId,
      failure_class: 'check_red',
      finished_at: sql<Date>`queued_at + interval '65 seconds'`,
    })
    .where('id', '=', lint.id)
    .execute()

  const ids = async (query: string) => {
    const { status, body } = await get(`/api/projects/${projectKey}/runs?${query}`)
    assert.equal(status, 200, JSON.stringify(body))
    return body.runs.map((r: { id: string }) => r.id).sort()
  }
  assert.deepEqual(await ids('state=failed'), [lint.id])
  assert.deepEqual(await ids('jobType=check'), [check.id, nightly.id].sort())
  assert.deepEqual(await ids('jobType=check&state=queued&queue=nightly'), [nightly.id])
  assert.deepEqual(await ids('jobType=nope'), [])

  const { body } = await get(`/api/projects/${projectKey}/runs?state=failed`)
  assert.deepEqual(
    [body.runs[0].machine, body.runs[0].failureClass, body.runs[0].totalMs],
    ['build-01', 'check_red', 65000],
  )
  assert.equal((await get(`/api/projects/${projectKey}/runs?state=bogus`)).body.code, 'DR101')
})

test("another tenant's runs, jobs and indicators never appear", async () => {
  const mine = await setup()
  const other = await setup()
  const myRun = await enqueue(mine.ctx, 'check')
  await enqueue(other.ctx, 'check')
  await submitBatch(other.ctx, projectKey, { jobs: [{ ref: 'x', job_type: 'check', cwd: 'C:\\work' }] })

  const runs = await mine.get(`/api/projects/${projectKey}/runs`)
  assert.deepEqual(
    runs.body.runs.map((r: { id: string }) => r.id),
    [myRun.id],
  )
  const jobs = await mine.get(`/api/projects/${projectKey}/jobs`)
  assert.equal(jobs.body.jobs.length, 1)
  assert.equal(jobs.body.jobs[0].lastRun.id, myRun.id)
  // The other tenant's queued run is not in this tenant's default queue.
  const now = await mine.get(`/api/projects/${projectKey}/indicators/now`)
  assert.equal(now.body.queues.find((q: { key: string }) => q.key === 'default').depth, 1)

  // A project key that exists only in the other tenant is not found.
  const stranger = await t.newTenant()
  const strangerCtx: Ctx = { db: t.db, tenantId: stranger.tenantId, actor: { id: stranger.human.id, kind: 'human' } }
  await createProject(strangerCtx, { key: 'hidden', name: 'Hidden' })
  for (const route of ['runs', 'jobs', 'indicators', 'indicators/now']) {
    const res = await mine.get(`/api/projects/hidden/${route}`)
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'DR201')
  }
})

test('job list shows dependsOn refs and the last run', async () => {
  const { ctx, get } = await setup()
  const batch = await submitBatch(ctx, projectKey, {
    jobs: [
      { ref: 'a', job_type: 'check', cwd: 'C:\\work' },
      { ref: 'b', job_type: 'lint', cwd: 'C:\\work', depends_on: ['a'] },
      { ref: 'c', job_type: 'check', cwd: 'C:\\work', depends_on: ['a', 'b'] },
    ],
  })
  const jobA = batch.jobs.find((j) => j.ref === 'a')
  assert.ok(jobA)
  // Job a failed, was retried, and the retry's offer expired into a requeue, which is no attempt (jobs/outcome.ts).
  const firstRun = await t.admin
    .updateTable('runs')
    .set({ state: 'failed', failure_class: 'infra', finished_at: sql<Date>`now()` })
    .where('id', '=', jobA.runId)
    .returningAll()
    .executeTakeFirstOrThrow()
  const base = {
    tenant_id: firstRun.tenant_id,
    project_id: firstRun.project_id,
    job_id: firstRun.job_id,
    job_type_id: firstRun.job_type_id,
  }
  await t.admin
    .insertInto('runs')
    .values({
      ...base,
      attempt: 2,
      cause: 'retry',
      state: 'stopped',
      failure_class: 'cancelled',
      queued_at: sql<Date>`now() + interval '1 second'`,
      not_before: sql<Date>`now()`,
    })
    .execute()
  const last = await t.admin
    .insertInto('runs')
    .values({
      ...base,
      attempt: 3,
      cause: 'requeue',
      state: 'queued',
      queued_at: sql<Date>`now() + interval '2 seconds'`,
      not_before: sql<Date>`now()`,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const { status, body } = await get(`/api/projects/${projectKey}/jobs`)
  assert.equal(status, 200, JSON.stringify(body))
  const byRef = Object.fromEntries(body.jobs.map((j: { ref: string }) => [j.ref, j]))
  assert.deepEqual(byRef.a, {
    id: jobA.jobId,
    ref: 'a',
    batch: batch.id,
    jobType: 'check',
    state: 'open',
    attempts: 2,
    dependsOn: [],
    lastRun: { id: last.id, state: 'queued', failureClass: null },
  })
  assert.deepEqual(byRef.b.dependsOn, ['a'])
  assert.deepEqual(byRef.c.dependsOn, ['a', 'b'])
  assert.equal(byRef.c.attempts, 1)

  const open = await get(`/api/projects/${projectKey}/jobs?state=open&limit=2`)
  assert.equal(open.body.jobs.length, 2)
  const rest = await get(`/api/projects/${projectKey}/jobs?state=open&limit=2&cursor=${open.body.nextCursor}`)
  assert.equal(rest.body.nextCursor, null)
  assert.deepEqual([...open.body.jobs, ...rest.body.jobs].map((j: { ref: string }) => j.ref).sort(), ['a', 'b', 'c'])
  assert.equal((await get(`/api/projects/${projectKey}/jobs?state=finished`)).body.jobs.length, 0)
})

test('machine list reports free, reserved and reserve bytes', async () => {
  const { ctx, machineId, get } = await setup()
  const before = await get('/api/machines')
  assert.deepEqual(
    [before.body[0].freeBytes, before.body[0].reservedBytes, before.body[0].reserveBytes, before.body[0].reportAt],
    [null, 0, null, null],
  )

  await t.admin
    .updateTable('machines')
    .set({
      last_report: JSON.stringify({ total_memory: 32 * GIB, available_memory: 8 * GIB }),
      last_seen_at: sql<Date>`now()`,
    })
    .where('id', '=', machineId)
    .execute()
  // In flight: offered and admitted needs count; a running run's memory is already out of the free figure.
  const needs: [string, number][] = [
    ['offered', 512 * MIB],
    ['admitted', GIB],
    ['running', 4 * GIB],
  ]
  for (const [state, need] of needs) {
    const run = await enqueue(ctx, 'check')
    await t.admin
      .updateTable('runs')
      .set({
        state: state as 'offered',
        machine_id: machineId,
        memory_need: need,
        offered_at: sql<Date>`now()`,
        offer_expires_at: sql<Date>`now() + interval '1 hour'`,
      })
      .where('id', '=', run.id)
      .execute()
  }

  const { status, body } = await get('/api/machines')
  assert.equal(status, 200)
  const [machine] = body
  assert.equal(machine.name, 'build-01')
  assert.equal(machine.freeBytes, 8 * GIB)
  assert.equal(machine.reservedBytes, 1536 * MIB)
  // A tenth of 32 GiB is past the 2 GiB cap.
  assert.equal(machine.reserveBytes, 2 * GIB)
  assert.equal(typeof machine.reportAt, 'string')
})
