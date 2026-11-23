import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { sql } from 'kysely'
import { buildServer } from '../api/server.ts'
import { Sessions } from '../executor/gateway.ts'
import { FEATURES, type RunEvent } from '../executor/protocol.ts'
import type { JobTypeFile } from '../job-types/file.ts'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun } from '../jobs/enqueue.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { stopRun, waitForRun } from '../runs/dispatch.ts'
import { applyRunEvent } from '../runs/record.ts'
import { withTenant } from '../tenancy/scope.ts'
import { type IsolatedTestDb, isolatedTestDb, TEST_APP_ROLE } from '../test-support/db.ts'
import { claimRun } from './claim.ts'
import { expireOffers } from './expiry.ts'
import { Scheduler } from './scheduler.ts'

// expired_offers reads every tenant: in the shared test database the scheduler of another test file would expire
// these offers first, so this file has a database of its own.
let t: IsolatedTestDb

before(async () => {
  t = await isolatedTestDb('expiry')
})

const projectKey = 'devrounds'
const PLENTY = 64n * 1024n * 1024n * 1024n
const GIB = 1024 * 1024 * 1024

const log = { warn: () => {}, error: () => {} }

// A tenant with project `devrounds`, job type `check` and machine `build-01` paired.
async function setup(retry?: JobTypeFile['retry']) {
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await putJobType(ctx, projectKey, {
    key: 'check',
    command: { program: 'pnpm', args: ['check'] },
    ...(retry === undefined ? {} : { retry }),
  })
  const { code } = await createPairingCode(ctx, 'build-01')
  const machine = await redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' })
  const enqueue = async () => (await enqueueRun(ctx, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work' })).id
  // Claims the next run for build-01 with an offer of `timeoutS` seconds.
  const claim = async (timeoutS = 120) =>
    (
      await withTenant(t.db, tenant.tenantId, (trx) =>
        claimRun(trx, machine.machineId, { freeBytes: PLENTY, reserveBytes: 0n, offerTimeoutS: timeoutS }),
      )
    )?.runId ?? null
  const event = (e: RunEvent) => applyRunEvent(ctx, machine.machineId, e, new Date())
  const runsOfJobOf = (runId: string) =>
    t.admin
      .selectFrom('runs')
      .select(['id', 'attempt', 'cause', 'state', 'failure_class', 'failure_summary', 'withdrawn_at'])
      .where('job_id', '=', t.admin.selectFrom('runs').select('job_id').where('id', '=', runId))
      .orderBy('attempt')
      .execute()
  return { tenant, ctx, machine, enqueue, claim, event, runsOfJobOf }
}

test('expired_offers and rearm_offers are security definer, executable by the app role only', async () => {
  for (const fn of ['expired_offers()', 'rearm_offers(int)']) {
    const { rows } = await sql<{ pub: boolean; app: boolean; definer: boolean; config: string[] }>`
      select has_function_privilege('public', ${fn}, 'execute') as pub,
        has_function_privilege(${TEST_APP_ROLE}, ${fn}, 'execute') as app,
        p.prosecdef as definer, p.proconfig as config
      from pg_proc p where p.oid = ${fn}::regprocedure`.execute(t.admin)
    assert.deepEqual(
      rows,
      [{ pub: false, app: true, definer: true, config: ['search_path=pg_catalog, public, pg_temp'] }],
      fn,
    )
  }
})

// P1-T51: queued runs have no machine until placed (0010), and nothing stopped a run from being offered without one.
// expired_offers then returned a null machine, the name lookup in expireOffers found nothing, and the offer stayed
// forever. 0017 makes that state impossible instead.
test('a run cannot be offered, admitted or running without a machine', async () => {
  const s = await setup()
  const run = await s.enqueue()
  for (const state of ['offered', 'admitted', 'running'] as const) {
    await assert.rejects(
      t.admin.updateTable('runs').set({ state }).where('id', '=', run).execute(),
      (err: { code?: string }) => err.code === '23514',
      state,
    )
  }
})

test('an unanswered offer expires after the timeout: run stopped/infra, a requeue run of the same job queued', async () => {
  const s = await setup()
  const run = await s.enqueue()
  assert.equal(await s.claim(1), run)
  // Within its timeout the offer stands.
  await expireOffers(t.db, new Sessions(), 1, log)
  assert.equal((await s.runsOfJobOf(run))[0].state, 'offered')

  await sleep(1100)
  const began = Date.now()
  const waiting = waitForRun(s.ctx, run, 30)
  await expireOffers(t.db, new Sessions(), 1, log)
  const [expired, requeued, ...more] = await s.runsOfJobOf(run)

  assert.deepEqual(more, [])
  assert.deepEqual([expired.state, expired.failure_class], ['stopped', 'infra'])
  assert.equal(expired.failure_summary, `offer not answered within 1 s by build-01; requeued as run ${requeued.id}`)
  assert.ok(expired.withdrawn_at, 'listed in the next HelloAck, so the executor drops it')
  assert.deepEqual([requeued.attempt, requeued.cause, requeued.state], [2, 'requeue', 'queued'])
  const job = await t.admin
    .selectFrom('jobs')
    .select('state')
    .where('id', '=', t.admin.selectFrom('runs').select('job_id').where('id', '=', run))
    .executeTakeFirstOrThrow()
  assert.equal(job.state, 'open')
  // A waiter on the expired run hears of it at once, not at its deadline.
  assert.equal((await waiting).state, 'stopped')
  assert.ok(Date.now() - began < 10_000, `took ${Date.now() - began} ms`)
  // The requeue is claimable like any queued run.
  assert.equal(await s.claim(), requeued.id)
})

test('a Delayed answer keeps the offer past the timeout', async () => {
  const s = await setup()
  const run = await s.enqueue()
  assert.equal(await s.claim(1), run)
  await s.event({ kind: 'Delayed', run, reason: 'memory', position: 1, need: 1024, available: 512 })
  await sleep(1100)
  await expireOffers(t.db, new Sessions(), 1, log)

  const runs = await s.runsOfJobOf(run)
  assert.deepEqual(
    runs.map((r) => r.state),
    ['offered'],
  )
  const row = await t.admin
    .selectFrom('runs')
    .select('offer_accepted_at')
    .where('id', '=', run)
    .executeTakeFirstOrThrow()
  assert.ok(row.offer_accepted_at)
})

test('requeue does not count toward max_attempts', async () => {
  const s = await setup({ max_attempts: 2, backoff_s: 0, on: ['infra'] })
  const run = await s.enqueue()
  assert.equal(await s.claim(1), run)
  await sleep(1100)
  await expireOffers(t.db, new Sessions(), 1, log)
  const [, requeued] = await s.runsOfJobOf(run)
  assert.equal(await s.claim(), requeued.id)
  const failInfra = async (id: string) => {
    await s.event({ kind: 'Admitted', run: id })
    await s.event({ kind: 'RunStarted', run: id, pid: 42, start_time: '1', boot_id: 'boot-1' })
    await s.event({
      kind: 'RunFinished',
      run: id,
      reason: 'infra',
      exit_code: null,
      peak: 1024,
      p95: 1024,
      p50: 1024,
      cpu_seconds: 1,
      swept: 0,
      visible_windows: 0,
      tail: [],
      summary: null,
    })
  }
  await failInfra(requeued.id)
  // The expired first attempt and this requeue count as one attempt of two: the policy retries.
  const [, , retry, ...none] = await s.runsOfJobOf(run)
  assert.deepEqual(none, [])
  assert.deepEqual([retry.attempt, retry.cause, retry.state], [3, 'retry', 'queued'])
  assert.equal(await s.claim(), retry.id)
  await failInfra(retry.id)

  const runs = await s.runsOfJobOf(run)
  assert.deepEqual(
    runs.map((r) => [r.attempt, r.cause, r.state]),
    [
      [1, 'first', 'stopped'],
      [2, 'requeue', 'failed'],
      [3, 'retry', 'failed'],
    ],
  )
})

type Message = { type: string; run?: string; withdrawn?: string[]; [field: string]: unknown }

test('an expired offer on a live session closes it with 4408', async () => {
  const sessions = new Sessions()
  // Offers of 1 s from this scheduler, which the test ticks by hand.
  const scheduler = new Scheduler({ db: t.db, sessions, offerTimeoutS: 1, pollMs: 600_000, telemetry: null, log })
  const app = buildServer({ db: t.db, logger: false, sessions, scheduler })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const host = `127.0.0.1:${(app.server.address() as AddressInfo).port}`
  try {
    const s = await setup()
    const connect = async () => {
      // Node's WebSocket (undici) takes `{ headers }`; the DOM lib's type only knows protocols.
      const ws = new WebSocket(`ws://${host}/api/executor/connect`, {
        headers: { authorization: `Bearer ${s.machine.token}` },
      } as unknown as string[])
      const inbox: Message[] = []
      let wake: (() => void) | undefined
      ws.addEventListener('message', (event) => {
        inbox.push(JSON.parse(String(event.data)))
        wake?.()
      })
      const closed = new Promise<number>((resolve) => ws.addEventListener('close', (event) => resolve(event.code)))
      await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))
      const next = async (): Promise<Message> => {
        while (inbox.length === 0) await new Promise<void>((resolve) => (wake = resolve))
        return inbox.shift() as Message
      }
      ws.send(JSON.stringify({ type: 'Hello', protocol: 1, version: '0.1.0', features: [...FEATURES], boot_id: 'b' }))
      const helloAck = await next()
      ws.send(
        JSON.stringify({
          type: 'MachineReport',
          total_memory: 32 * GIB,
          available_memory: 16 * GIB,
          commit_total: 8 * GIB,
          commit_limit: 64 * GIB,
          cpu_percent: 3,
          memory_pressure: 'normal',
          running: 0,
          executor_private_bytes: 18_000_000,
        }),
      )
      return { helloAck, next, closed, close: () => ws.close() }
    }

    const first = await connect()
    const run = await s.enqueue()
    // The report wakes the scheduler, or this tick places it.
    await scheduler.tick()
    assert.deepEqual([(await first.next()).type], ['Offer'])
    await sleep(1100)
    await scheduler.tick()
    assert.equal(await first.closed, 4408)
    const [expired, requeued] = await s.runsOfJobOf(run)
    assert.deepEqual([expired.state, requeued.state], ['stopped', 'queued'])

    // The executor reconnects as for any drop: it learns the run was withdrawn and gets the requeue.
    const second = await connect()
    assert.deepEqual(second.helloAck.withdrawn, [run])
    // Its report wakes the scheduler.
    const offer = await second.next()
    assert.deepEqual([offer.type, offer.run], ['Offer', requeued.id])
    second.close()
  } finally {
    await scheduler.stop()
    await app.close()
  }
})

// On a live session a stop only sent Stop: an executor that never got the Offer, or is wedged, said nothing, and the
// expiry then requeued the job the person had stopped.
test('stop of an unaccepted offer on a live session ends it at once, and the expiry does not requeue it', async () => {
  const s = await setup()
  const sent: string[] = []
  const sessions = new Sessions()
  const socket = { send: (text: string) => sent.push(text), close: () => {} } as unknown as Parameters<
    Sessions['open']
  >[1]['socket']
  sessions.open(s.machine.machineId, { tenantId: s.tenant.tenantId, socket, features: [...FEATURES] })
  const run = await s.enqueue()
  assert.equal(await s.claim(1), run)

  const stopped = await stopRun(s.ctx, sessions, run)
  assert.deepEqual([stopped.state, stopped.outcome.failureClass], ['stopped', 'cancelled'])
  assert.deepEqual(
    sent.map((text) => JSON.parse(text)),
    [{ type: 'Stop', run, reason: 'cancel' }],
  )
  await sleep(1500)
  // Other tests of this file may leave expired offers of their own; this run must not be among the withdrawn.
  assert.ok(!(await expireOffers(t.db, sessions, 1, log)).includes(run))

  const runs = await s.runsOfJobOf(run)
  assert.deepEqual(
    runs.map((r) => [r.attempt, r.state, r.failure_class, r.withdrawn_at !== null]),
    [[1, 'stopped', 'cancelled', true]],
  )
  // A late answer of the executor is refused like any to an ended run.
  await assert.rejects(s.event({ kind: 'Admitted', run }), (err: Error & { code?: string }) => err.code === 'DR351')
})
