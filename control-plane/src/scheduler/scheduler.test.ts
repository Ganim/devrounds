import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { runCli } from '../cli/commands.ts'
import { Sessions } from '../executor/gateway.ts'
import { type ControlPlaneMessage, FEATURES } from '../executor/protocol.ts'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun } from '../jobs/enqueue.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { putQueue } from '../queues/service.ts'
import { runView } from '../runs/view.ts'
import { TEST_DATABASE_URL, type TestDb, testDb } from '../test-support/db.ts'
import { Scheduler } from './scheduler.ts'

const projectKey = 'devrounds'
const MIB = 1024 * 1024
const GIB = 1024 * MIB
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
// Nothing listens on port 1: LISTEN can never connect.
const UNREACHABLE = 'postgres://nobody:nothing@127.0.0.1:1/nothing'

let t: TestDb
let scratch: string
const cleanups: (() => Promise<void>)[] = []

before(async () => {
  t = await testDb()
  await mkdir(join(REPO_ROOT, '.superpowers', 'tmp'), { recursive: true })
  scratch = await mkdtemp(join(REPO_ROOT, '.superpowers', 'tmp', 'scheduler-'))
})

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

// Loses the Offer of each run in `lose`: the session's socket is cut right before the send, as when the executor
// drops between the claim's commit and the Offer.
class LosingSessions extends Sessions {
  lose = new Set<string>()

  override send(machineId: string, message: ControlPlaneMessage): boolean {
    if (message.type === 'Offer' && this.lose.delete(message.run)) this.get(machineId)?.socket.terminate()
    return super.send(machineId, message)
  }
}

type Options = { pollMs?: number; listenUrl?: string; now?: () => number; sessions?: Sessions }

// A control plane with its own sessions and scheduler. Without `listenUrl` the scheduler is not started: only the
// gateway's pokes and the test's ticks wake it.
async function controlPlane(o: Options = {}) {
  const sessions = o.sessions ?? new Sessions()
  const warnings: string[] = []
  const log = {
    warn: (_data: object, message: string) => warnings.push(message),
    error: (_data: object, message: string) => warnings.push(message),
  }
  const scheduler = new Scheduler({
    db: t.db,
    sessions,
    offerTimeoutS: 120,
    pollMs: o.pollMs ?? 60_000,
    telemetry: null,
    log,
    now: o.now,
  })
  const app = buildServer({ db: t.db, logger: false, sessions, scheduler, logsRoot: join(scratch, 'logs') })
  await app.listen({ port: 0, host: '127.0.0.1' })
  cleanups.push(async () => {
    await scheduler.stop()
    await app.close()
  })
  if (o.listenUrl !== undefined) await scheduler.start(o.listenUrl)
  const host = `127.0.0.1:${(app.server.address() as AddressInfo).port}`
  return { sessions, scheduler, host, warnings }
}

// A tenant with project `devrounds`, job type `check` and the machines `names` paired (not connected).
async function setup(names = ['build-01']) {
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await putJobType(ctx, projectKey, { key: 'check', command: { program: 'pnpm', args: ['check'] } })
  const machines = []
  for (const name of names) {
    const { code } = await createPairingCode(ctx, name)
    machines.push(await redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' }))
  }
  const enqueue = async (machineName?: string) =>
    (await enqueueRun(ctx, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work', machineName })).id
  return { tenant, ctx, machines, enqueue }
}

type Message = { type: string; run?: string; memory_need?: number; [field: string]: unknown }

// The executor's side of a session, past HelloAck, with a MachineReport of `available` of 32 GiB free unless
// `available` is null (no report).
async function executor(
  cp: { host: string; sessions: Sessions },
  machine: { token: string; machineId: string },
  available: number | null = 16 * GIB,
) {
  // Node's WebSocket (undici) takes `{ headers }`; the DOM lib's type only knows protocols.
  const ws = new WebSocket(`ws://${cp.host}/api/executor/connect`, {
    headers: { authorization: `Bearer ${machine.token}` },
  } as unknown as string[])
  const inbox: Message[] = []
  const seen: Message[] = []
  let wake: (() => void) | undefined
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as Message
    inbox.push(message)
    seen.push(message)
    wake?.()
  })
  const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()))
  await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))
  // A frame that never comes fails the test after 5 s instead of hanging it.
  const next = async (): Promise<Message> => {
    const deadline = Date.now() + 5000
    while (inbox.length === 0) {
      const left = deadline - Date.now()
      assert.ok(left > 0, 'no frame within 5 s')
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, left)
      })
    }
    return inbox.shift() as Message
  }
  ws.send(JSON.stringify({ type: 'Hello', protocol: 1, version: '0.1.0', features: [...FEATURES], boot_id: 'boot-1' }))
  const ack = await next()
  assert.equal(ack.type, 'HelloAck')
  let seq = Number(ack.last_seq)
  const report = async (bytes: number) => {
    ws.send(
      JSON.stringify({
        type: 'MachineReport',
        total_memory: 32 * GIB,
        available_memory: bytes,
        commit_total: 8 * GIB,
        commit_limit: 64 * GIB,
        cpu_percent: 3,
        memory_pressure: 'normal',
        running: 0,
        executor_private_bytes: 18_000_000,
      }),
    )
    await until(() => cp.sessions.get(machine.machineId)?.report?.availableMemory === BigInt(bytes))
  }
  if (available !== null) await report(available)
  return {
    next,
    seen,
    closed,
    report,
    // Sends one event with the next seq and waits for its Ack: the gateway has applied it, and every frame sent
    // before the Ack is in the inbox.
    async event(event: Record<string, unknown>) {
      seq += 1
      ws.send(JSON.stringify({ type: 'Event', seq, at: new Date().toISOString(), event }))
      // Frames before the Ack (an Offer) stay in the inbox for the caller, in order.
      const before: Message[] = []
      let message = await next()
      while (message.type !== 'Ack') {
        before.push(message)
        message = await next()
      }
      inbox.unshift(...before)
      assert.equal(message.seq, seq)
    },
    close: () => ws.close(),
  }
}

async function until(condition: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await sleep(10)
  assert.ok(condition(), `condition not met within ${ms} ms`)
}

const offersOf = (seen: Message[], run: string) => seen.filter((m) => m.type === 'Offer' && m.run === run)

test('an enqueued run is offered within 1 s through NOTIFY', async () => {
  const cp = await controlPlane({ listenUrl: TEST_DATABASE_URL })
  const { machines, enqueue } = await setup()
  const exec = await executor(cp, machines[0])
  // Idle first, so the run below can only be placed by the wake its enqueue sends (the poll is 60 s away).
  await cp.scheduler.tick()
  const began = Date.now()
  const run = await enqueue()
  const offer = await exec.next()
  assert.deepEqual([offer.type, offer.run], ['Offer', run])
  assert.ok(Date.now() - began < 1000, `offered after ${Date.now() - began} ms`)
  exec.close()
})

test('with LISTEN unreachable the poll still offers within one interval', async () => {
  const pollMs = 200
  const cp = await controlPlane({ listenUrl: UNREACHABLE, pollMs })
  const { machines, enqueue } = await setup()
  const exec = await executor(cp, machines[0])
  await cp.scheduler.tick()
  const began = Date.now()
  const run = await enqueue()
  const offer = await exec.next()
  assert.deepEqual([offer.type, offer.run], ['Offer', run])
  // One interval plus the tick itself and the socket; a 60 s LISTEN backoff or a missed wake would be far over.
  assert.ok(Date.now() - began < 5 * pollMs, `offered after ${Date.now() - began} ms`)
  assert.ok(
    cp.warnings.some((w) => /listen/i.test(w)),
    cp.warnings.join('\n'),
  )
  exec.close()
})

test('a machine without a report in the last 30 s gets no offer', async () => {
  // The scheduler's clock runs 31 s ahead of the gateway's report stamps.
  const cp = await controlPlane({ now: () => Date.now() + 31_000 })
  const { ctx, machines, enqueue } = await setup()
  const exec = await executor(cp, machines[0])
  const run = await enqueue()
  await cp.scheduler.tick()
  // The Ack of an unknown event is the next frame: no Offer came before it.
  await exec.event({ kind: 'Probe' })
  assert.deepEqual(offersOf(exec.seen, run), [])
  assert.equal((await runView(ctx, run)).state, 'queued')
  exec.close()

  // A machine that never reported is not placeable either.
  const fresh = await controlPlane()
  const silent = await executor(fresh, machines[0], null)
  await fresh.scheduler.tick()
  await silent.event({ kind: 'Probe' })
  assert.deepEqual(offersOf(silent.seen, run), [])
  silent.close()
})

test('placement prefers the machine with more free memory', async () => {
  const cp = await controlPlane()
  const { ctx, machines, enqueue } = await setup(['build-01', 'build-02'])
  const small = await executor(cp, machines[0], 4 * GIB)
  const large = await executor(cp, machines[1], 20 * GIB)
  const run = await enqueue()
  await cp.scheduler.tick()
  const offer = await large.next()
  assert.deepEqual([offer.type, offer.run], ['Offer', run])
  assert.equal((await runView(ctx, run)).machine, 'build-02')
  await small.event({ kind: 'Probe' })
  assert.deepEqual(offersOf(small.seen, run), [])
  small.close()
  large.close()
})

test('run start with no machine connected queues the run and offers it once one connects', async () => {
  const cp = await controlPlane()
  const { tenant, machines } = await setup()
  const env = {
    DEVROUNDS_URL: `http://${cp.host}`,
    DEVROUNDS_TOKEN: await createToken(t.admin, tenant.tenantId, 'human', 'human'),
    DEVROUNDS_PROJECT: projectKey,
  }
  const cli = (...argv: string[]) => runCli(argv, { env, configPath: join(scratch, 'config.json') })
  const out = await cli('run', 'start', 'check', '--cwd', 'C:\\work')
  assert.equal(out.exitCode, 0, out.stderr)
  const [line, next] = out.stdout.trimEnd().split('\n')
  const run = /^run ([0-9a-f-]{36}) queued · check$/.exec(line)?.[1] as string
  assert.ok(run, out.stdout)
  assert.equal(next, `next: devrounds run show ${run} --wait`)
  const pinned = await cli('run', 'start', 'check', '--cwd', 'C:\\work', '--machine', 'build-01')
  assert.equal(pinned.exitCode, 0, pinned.stderr)
  const pinnedRun = /^run ([0-9a-f-]{36}) queued · check on build-01$/m.exec(pinned.stdout)?.[1] as string
  assert.ok(pinnedRun, pinned.stdout)

  // HelloAck and the first MachineReport wake the scheduler; no tick from the test.
  const exec = await executor(cp, machines[0])
  const offered = [(await exec.next()).run, (await exec.next()).run]
  assert.deepEqual(offered.sort(), [run, pinnedRun].sort())
  exec.close()
})

test('the Offer carries memory_need from the claim', async () => {
  const cp = await controlPlane()
  const { tenant, machines, enqueue } = await setup()
  const jobType = await t.admin
    .selectFrom('job_types')
    .select(['id', 'project_id'])
    .where('tenant_id', '=', tenant.tenantId)
    .executeTakeFirstOrThrow()
  // A learned need the runs alone would not give (no run of `check` reported a peak, so they say 512 MiB).
  await t.admin
    .insertInto('learned_needs')
    .values({
      tenant_id: tenant.tenantId,
      project_id: jobType.project_id,
      job_type_id: jobType.id,
      machine_id: machines[0].machineId,
      need_bytes: String(700 * MIB),
      samples: 3,
    })
    .execute()
  const exec = await executor(cp, machines[0])
  const run = await enqueue()
  await cp.scheduler.tick()
  const offer = await exec.next()
  assert.deepEqual([offer.type, offer.run, offer.memory_need], ['Offer', run, 700 * MIB])
  const row = await t.admin.selectFrom('runs').select('memory_need').where('id', '=', run).executeTakeFirstOrThrow()
  assert.equal(row.memory_need, String(700 * MIB))
  exec.close()
})

test('a claim whose Offer send failed is re-sent after the next HelloAck and admitted once', async () => {
  const sessions = new LosingSessions()
  const cp = await controlPlane({ sessions })
  const { ctx, machines, enqueue } = await setup()
  const first = await executor(cp, machines[0])
  const run = await enqueue()
  sessions.lose.add(run)
  await cp.scheduler.tick()
  await first.closed
  assert.deepEqual(offersOf(first.seen, run), [])
  assert.equal((await runView(ctx, run)).state, 'offered')

  const second = await executor(cp, machines[0])
  await until(() => offersOf(second.seen, run).length === 1)
  await second.event({ kind: 'Admitted', run })
  // Another pass finds the run offered, not queued, so it claims and sends nothing more.
  await cp.scheduler.tick()
  await second.event({ kind: 'Probe' })
  assert.equal(offersOf(second.seen, run).length, 1)
  const view = await runView(ctx, run)
  assert.equal(view.state, 'admitted')
  assert.ok(view.timeline.admittedAt)
  second.close()
})

test('a MachineReport that frees memory wakes the scheduler', async () => {
  const cp = await controlPlane()
  const { machines, enqueue } = await setup()
  // 1 GiB free of 32 GiB: the 2 GiB reserve leaves nothing for a 512 MiB need.
  const exec = await executor(cp, machines[0], GIB)
  const run = await enqueue()
  await cp.scheduler.tick()
  await exec.event({ kind: 'Probe' })
  assert.deepEqual(offersOf(exec.seen, run), [])
  await exec.report(16 * GIB)
  const offer = await exec.next()
  assert.deepEqual([offer.type, offer.run], ['Offer', run])
  exec.close()
})

test('a run that ends wakes the scheduler through NOTIFY for the run its queue held back', async () => {
  const cp = await controlPlane({ listenUrl: TEST_DATABASE_URL })
  const { ctx, machines } = await setup()
  await putQueue(ctx, projectKey, { key: 'one', concurrency: 1 })
  const enqueue = async () =>
    (await enqueueRun(ctx, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work', queueKey: 'one' })).id
  const exec = await executor(cp, machines[0])
  const [first, second] = [await enqueue(), await enqueue()]
  assert.equal((await exec.next()).run, first)
  await exec.event({ kind: 'Admitted', run: first })
  await exec.event({ kind: 'RunStarted', run: first, pid: 1, start_time: '1', boot_id: 'boot-1' })
  // The queue's one slot is taken: another pass offers nothing.
  await cp.scheduler.tick()
  assert.deepEqual(offersOf(exec.seen, second), [])
  await exec.event({
    kind: 'RunFinished',
    run: first,
    reason: 'exited',
    exit_code: 0,
    peak: 300 * MIB,
    p95: 300 * MIB,
    p50: 300 * MIB,
    cpu_seconds: 1,
    swept: 0,
    visible_windows: 0,
    tail: [],
    summary: null,
  })
  const offer = await exec.next()
  assert.deepEqual([offer.type, offer.run], ['Offer', second])
  exec.close()
})
