import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { runCli } from '../cli/commands.ts'
import { DevRoundsError } from '../errors/error.ts'
import { Sessions } from '../executor/gateway.ts'
import { FEATURES } from '../executor/protocol.ts'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun, submitBatch } from '../jobs/enqueue.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { Scheduler } from '../scheduler/scheduler.ts'
import type { Telemetry } from '../telemetry/otel.ts'
import { TEST_DATABASE_URL, type TestDb, testDb } from '../test-support/db.ts'
import { runEvents, stopRun, waitForRun } from './dispatch.ts'
import { runView } from './view.ts'

const projectKey = 'devrounds'
const MIB = 1024 * 1024
const GIB = 1024 * MIB
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

let t: TestDb
let sessions: Sessions
let scheduler: Scheduler
let app: ReturnType<typeof buildServer>
let host: string
let scratch: string

// Stands in for the OpenTelemetry exporter (telemetry/otel.ts): a run's trace id is its uuid, the dispatch span id
// the uuid's first 16 hex digits.
const finishedRuns: { id: string; state: string; traceParent: string | null }[] = []
const telemetry: Telemetry = {
  runDispatched: (run) => {
    const hex = run.id.replaceAll('-', '')
    return `00-${hex}-${hex.slice(0, 16)}-01`
  },
  runFinished: (view, traceParent) => {
    finishedRuns.push({ id: view.id, state: view.state, traceParent })
  },
  shutdown: async () => {},
}
const traceParentOf = (run: string) => telemetry.runDispatched({ id: run, jobType: 'check' })

before(async () => {
  t = await testDb()
  sessions = new Sessions()
  await mkdir(join(REPO_ROOT, '.superpowers', 'tmp'), { recursive: true })
  scratch = await mkdtemp(join(REPO_ROOT, '.superpowers', 'tmp', 'dispatch-'))
  // Woken by each enqueue's NOTIFY and by the gateway; the poll never comes within a test.
  scheduler = new Scheduler({ db: t.db, sessions, offerTimeoutS: 120, pollMs: 600_000, telemetry, log: console })
  app = buildServer({ db: t.db, logger: false, sessions, scheduler, logsRoot: join(scratch, 'logs'), telemetry })
  await app.listen({ port: 0, host: '127.0.0.1' })
  host = `127.0.0.1:${(app.server.address() as AddressInfo).port}`
  await scheduler.start(TEST_DATABASE_URL)
})

after(async () => {
  await scheduler.stop()
  await app.close()
  await rm(scratch, { recursive: true, force: true })
})

const code = (expected: string) => (err: unknown) => err instanceof DevRoundsError && err.code === expected

// A tenant with project `devrounds`, job type `check` and machine `build-01` paired (not connected).
async function setup() {
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await putJobType(ctx, projectKey, {
    key: 'check',
    command: { program: 'pnpm', args: ['check'] },
    env: ['PATH'],
    timeout_s: 600,
  })
  const { code: pairing } = await createPairingCode(ctx, 'build-01')
  const machine = await redeemPairingCode(t.db, new PairingLimiter(), pairing, { os: 'windows', version: '0.1.0' })
  const token = await createToken(t.admin, tenant.tenantId, 'human', 'human')
  // Pinned to build-01; the scheduler offers it once the executor is connected and has reported.
  const dispatch = () => enqueueRun(ctx, { projectKey, jobTypeKey: 'check', machineName: 'build-01', cwd: 'C:\\work' })
  return { tenant, ctx, machine, token, dispatch }
}

type Message = { type: string; [field: string]: unknown }

const REPORT = {
  type: 'MachineReport',
  total_memory: 32 * GIB,
  available_memory: 16 * GIB,
  commit_total: 8 * GIB,
  commit_limit: 64 * GIB,
  cpu_percent: 3,
  memory_pressure: 'normal',
  running: 0,
  executor_private_bytes: 18_000_000,
}

// The executor's side of a session, over Node's global WebSocket, past HelloAck.
async function executor(token: string) {
  // Node's WebSocket (undici) takes `{ headers }`; the DOM lib's type only knows protocols.
  const ws = new WebSocket(`ws://${host}/api/executor/connect`, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[])
  const inbox: Message[] = []
  let wake: (() => void) | undefined
  ws.addEventListener('message', (event) => {
    inbox.push(JSON.parse(String(event.data)))
    wake?.()
  })
  await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))
  const next = async (): Promise<Message> => {
    while (inbox.length === 0) await new Promise<void>((resolve) => (wake = resolve))
    return inbox.shift() as Message
  }
  ws.send(JSON.stringify({ type: 'Hello', protocol: 1, version: '0.1.0', features: [...FEATURES], boot_id: 'boot-1' }))
  const ack = await next()
  assert.equal(ack.type, 'HelloAck')
  // Placeable from its first report on.
  ws.send(JSON.stringify(REPORT))
  await until(() => sessions.get(String(ack.machine_id))?.report !== undefined)
  let seq = 0
  return {
    next,
    // Sends one event with the next seq and waits for its Ack: the gateway has applied it.
    async event(event: Record<string, unknown>) {
      seq += 1
      ws.send(JSON.stringify({ type: 'Event', seq, at: new Date().toISOString(), event }))
      assert.deepEqual(await next(), { type: 'Ack', seq })
    },
    close: () => ws.close(),
  }
}

const finished = (run: string) => ({
  kind: 'RunFinished',
  run,
  reason: 'exited',
  exit_code: 0,
  peak: 300 * MIB,
  p95: 250 * MIB,
  p50: 100 * MIB,
  cpu_seconds: 4.5,
  swept: 1,
  visible_windows: 0,
  tail: ['ok'],
  summary: null,
})

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(condition(), 'condition not met within 2 s')
}

// Admitted and started, with one finished step.
async function running(exec: Awaited<ReturnType<typeof executor>>, run: string) {
  await exec.event({ kind: 'Admitted', run })
  await exec.event({ kind: 'RunStarted', run, pid: 4321, start_time: '134077128011234567', boot_id: 'boot-1' })
  await exec.event({ kind: 'StepStarted', run, step: 0, name: 'build' })
  await exec.event({ kind: 'StepFinished', run, step: 0, outcome: 'finished' })
}

test('POST /runs queues the run and the scheduler sends one Offer with memory_need 536870912 without history', async () => {
  const { tenant, machine, token } = await setup()
  const exec = await executor(machine.token)
  const body = JSON.stringify({ jobType: 'check', machine: 'build-01', cwd: 'C:\\work' })
  const post = () =>
    fetch(`http://${host}/api/projects/${projectKey}/runs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'dispatch-1',
      },
      body,
    })
  const first = await post()
  assert.equal(first.status, 200, await first.clone().text())
  const view = (await first.json()) as { id: string; state: string }
  // Queued at the commit; the Offer comes from the scheduler its NOTIFY wakes.
  assert.equal(view.state, 'queued')
  // The same key replays the stored answer and queues, so offers, nothing again.
  const replay = (await (await post()).json()) as { id: string }
  assert.equal(replay.id, view.id)
  const runs = await t.admin.selectFrom('runs').select('id').where('tenant_id', '=', tenant.tenantId).execute()
  assert.deepEqual(runs, [{ id: view.id }])

  assert.deepEqual(await exec.next(), {
    type: 'Offer',
    run: view.id,
    job: {
      job_type: 'check',
      program: 'pnpm',
      args: ['check'],
      cwd: 'C:\\work',
      env_allow: ['PATH'],
      timeout_s: 600,
    },
    memory_need: 536870912,
    trace_parent: traceParentOf(view.id),
  })
  // The next frame is the Ack of this event, so no second Offer came before it.
  await exec.event({ kind: 'Admitted', run: view.id })
  exec.close()
})

test('executor events drive the run to finished with timeline and resources', async () => {
  const { ctx, machine, dispatch } = await setup()
  const exec = await executor(machine.token)
  const offered = await dispatch()
  // The Offer continues the dispatch span's trace, and the run keeps its trace id for run.record.
  const traceParent = traceParentOf(offered.id)
  assert.equal((await exec.next()).trace_parent, traceParent)
  const traced = await t.admin.selectFrom('runs').select('trace_id').where('id', '=', offered.id).executeTakeFirst()
  assert.equal(traced?.trace_id, offered.id.replaceAll('-', ''))
  await running(exec, offered.id)
  const lines = [1, 2].map((seq) => JSON.stringify({ run: offered.id, seq, timestamp_ms: 0, text: 'ok', level: null }))
  const zstd_base64 = zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`)).toString('base64')
  await exec.event({ kind: 'LogSegment', run: offered.id, first_seq: 1, last_seq: 2, records: 2, zstd_base64 })
  await exec.event(finished(offered.id))

  const view = await runView(ctx, offered.id)
  assert.equal(view.state, 'finished')
  assert.equal(view.outcome.logCursor, 2)
  const { queuedAt, offeredAt, admittedAt, startedAt, finishedAt } = view.timeline
  assert.ok(queuedAt && offeredAt && admittedAt && startedAt && finishedAt, JSON.stringify(view.timeline))
  assert.ok(view.durations.totalMs !== null && view.durations.totalMs >= 0)
  assert.equal(view.outcome.exitCode, 0)
  assert.equal(view.outcome.failureClass, null)
  assert.deepEqual(view.resources, {
    peak: 300 * MIB,
    p95: 250 * MIB,
    p50: 100 * MIB,
    cpuSeconds: 4.5,
    swept: 1,
    visibleWindows: 0,
  })
  assert.deepEqual(
    view.steps.map((s) => [s.step, s.name, s.outcome]),
    [[0, 'build', 'finished']],
  )
  // Once, after the commit, with the run as finished.
  assert.deepEqual(
    finishedRuns.filter((r) => r.id === offered.id),
    [{ id: offered.id, state: 'finished', traceParent }],
  )
  exec.close()
})

test('stop of a finished run answers DR351', async () => {
  const { ctx, machine, dispatch } = await setup()
  const exec = await executor(machine.token)
  const offered = await dispatch()
  assert.equal((await exec.next()).type, 'Offer')
  await running(exec, offered.id)
  // A live run gets a Stop on its machine's session.
  await stopRun(ctx, sessions, offered.id)
  assert.deepEqual(await exec.next(), { type: 'Stop', run: offered.id, reason: 'cancel' })
  await exec.event(finished(offered.id))

  await assert.rejects(stopRun(ctx, sessions, offered.id), code('DR351'))
  exec.close()
})

test('run routes stay within their project, stop answers DR350 when the Stop cannot go out', async () => {
  const { ctx, machine, token, dispatch } = await setup()
  await createProject(ctx, { key: 'other', name: 'Other' })
  const exec = await executor(machine.token)
  const offered = await dispatch()
  assert.equal((await exec.next()).type, 'Offer')
  const call = (project: string, path: string, init: RequestInit = {}) =>
    fetch(`http://${host}/api/projects/${project}/runs/${offered.id}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}` },
    })

  // A run of `devrounds` does not exist under `other`.
  for (const res of [await call('other', ''), await call('other', '/stop', { method: 'POST' })]) {
    assert.equal(((await res.json()) as { code: string }).code, 'DR201')
  }

  // Accepted, so the stop goes through the executor (an unanswered offer would end at once): the session dropping
  // between the check and the send.
  await exec.event({ kind: 'Admitted', run: offered.id })
  const send = sessions.send
  sessions.send = () => false
  try {
    const res = await call(projectKey, '/stop', { method: 'POST' })
    const body = (await res.json()) as { code: string; data: { machine: string } }
    assert.deepEqual([res.status, body.code, body.data.machine], [409, 'DR350', 'build-01'])
  } finally {
    sessions.send = send
  }
  exec.close()
})

// A revoked machine's executor never reports again, so its runs that have not ended would stay open forever.
test('revoking a machine fails its running runs, withdraws its offers, and leaves ended ones', async () => {
  const { ctx, machine, token, dispatch } = await setup()
  const exec = await executor(machine.token)
  const [offered, started, done] = [await dispatch(), await dispatch(), await dispatch()]
  for (let i = 0; i < 3; i++) assert.equal((await exec.next()).type, 'Offer')
  await running(exec, started.id)
  await running(exec, done.id)
  await exec.event(finished(done.id))
  const res = await fetch(`http://${host}/api/machines/build-01/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.status, 200, await res.text())
  // The offer never started, so it is stopped and withdrawn; the running run fails. Class infra for both.
  for (const [id, state] of [
    [offered.id, 'stopped'],
    [started.id, 'failed'],
  ]) {
    const view = await runView(ctx, id)
    assert.deepEqual([view.state, view.outcome.failureClass], [state, 'infra'], id)
    assert.match(view.outcome.failureSummary ?? '', /machine build-01 was revoked/)
    assert.ok(view.timeline.finishedAt, id)
  }
  assert.equal((await runView(ctx, done.id)).state, 'finished')
  exec.close()
})

// No claim takes a run pinned to a revoked machine, so it would wait queued for good.
test('revoking a machine ends the queued runs pinned to it without a retry, and leaves the others queued', async () => {
  const { ctx, token, dispatch } = await setup()
  await putJobType(ctx, projectKey, {
    key: 'flaky',
    command: { program: 'pnpm', args: ['check'] },
    retry: { max_attempts: 3, backoff_s: 0, on: ['infra'] },
  })
  // No executor is connected: every run stays queued.
  const pinned = await dispatch()
  const retried = await enqueueRun(ctx, { projectKey, jobTypeKey: 'flaky', machineName: 'build-01', cwd: 'C:\\work' })
  const free = await enqueueRun(ctx, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work' })
  const res = await fetch(`http://${host}/api/machines/build-01/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.status, 200, await res.text())

  for (const run of [pinned.id, retried.id]) {
    const view = await runView(ctx, run)
    assert.deepEqual([view.state, view.outcome.failureClass], ['stopped', 'infra'], run)
    assert.match(view.outcome.failureSummary ?? '', /machine build-01 was revoked/)
  }
  // A retry would be pinned to the same machine, so the job fails once even though its policy retries infra.
  const runs = await t.admin
    .selectFrom('runs')
    .select(['attempt', 'state'])
    .where('job_id', '=', t.admin.selectFrom('runs').select('job_id').where('id', '=', retried.id))
    .orderBy('attempt')
    .execute()
  assert.deepEqual(
    runs.map((run) => [run.attempt, run.state]),
    [[1, 'stopped']],
  )
  assert.equal((await runView(ctx, free.id)).state, 'queued')
})

// A run skipped as a side effect of another run's end wakes its waiters too, or they only return at the deadline.
test('a dependent skipped by a failed run answers its waiter at once', async () => {
  const { ctx, machine } = await setup()
  const exec = await executor(machine.token)
  const batch = await submitBatch(ctx, projectKey, {
    jobs: [
      { ref: 'a', job_type: 'check', cwd: 'C:\\work', machine: 'build-01' },
      { ref: 'b', job_type: 'check', cwd: 'C:\\work', depends_on: ['a'] },
    ],
  })
  const runOf = (ref: string) => batch.jobs.find((job) => job.ref === ref)?.runId as string
  assert.equal((await exec.next()).run, runOf('a'))
  const began = Date.now()
  const waiting = waitForRun(ctx, runOf('b'), 30)
  await running(exec, runOf('a'))
  await exec.event({ ...finished(runOf('a')), exit_code: 1 })
  const view = await waiting

  assert.equal(view.state, 'skipped')
  assert.ok(Date.now() - began < 10_000, `took ${Date.now() - began} ms`)
  exec.close()
})

test('stop of an offered run on an offline machine ends it at once and withdraws it', async () => {
  const { ctx, machine, dispatch } = await setup()
  const exec = await executor(machine.token)
  const [offered, admitted] = [await dispatch(), await dispatch()]
  for (let i = 0; i < 2; i++) assert.equal((await exec.next()).type, 'Offer')
  await exec.event({ kind: 'Admitted', run: admitted.id })
  exec.close()
  await until(() => !sessions.get(machine.machineId))

  const stopped = await stopRun(ctx, sessions, offered.id)
  assert.deepEqual([stopped.state, stopped.outcome.failureClass], ['stopped', 'cancelled'])
  assert.ok(stopped.timeline.finishedAt)
  const row = await t.admin
    .selectFrom('runs')
    .select('withdrawn_at')
    .where('id', '=', offered.id)
    .executeTakeFirstOrThrow()
  assert.ok(row.withdrawn_at, 'listed in the next HelloAck, so the executor drops it')
  // An admitted run may be running on that machine; only its executor can stop it.
  await assert.rejects(stopRun(ctx, sessions, admitted.id), code('DR350'))
  assert.equal((await runView(ctx, admitted.id)).state, 'admitted')

  // Revoked before revoking ended the machine's runs (or racing it): stop is the way out. The admitted run never
  // started, so the person's stop ends its job; it is not requeued as a revoke alone would.
  await t.admin.updateTable('machines').set({ revoked_at: new Date() }).where('id', '=', machine.machineId).execute()
  const ended = await stopRun(ctx, sessions, admitted.id)
  assert.deepEqual([ended.state, ended.outcome.failureClass], ['stopped', 'cancelled'])
  assert.match(ended.outcome.failureSummary ?? '', /revoked machine/)
})

test('a client that leaves GET /runs/:id?wait ends the wait and its listener', async () => {
  const { machine, token, dispatch } = await setup()
  const exec = await executor(machine.token)
  const offered = await dispatch()
  assert.equal((await exec.next()).type, 'Offer')
  // `once(runEvents, 'newListener')` would resolve on the 'error' listener `once` itself adds; wait for 'changed'.
  const listener = (kind: 'newListener' | 'removeListener') =>
    new Promise<void>((resolve) => {
      const seen = (event: string | symbol) => {
        if (event !== 'changed') return
        runEvents.off(kind, seen)
        resolve()
      }
      runEvents.on(kind, seen)
    })
  const subscribed = listener('newListener')
  const leave = new AbortController()
  const waiting = fetch(`http://${host}/api/projects/${projectKey}/runs/${offered.id}?wait=60`, {
    headers: { authorization: `Bearer ${token}` },
    signal: leave.signal,
  }).catch(() => undefined)
  await subscribed
  const unsubscribed = listener('removeListener')
  leave.abort()
  await Promise.all([waiting, unsubscribed])
  assert.equal(runEvents.listenerCount('changed'), 0)
  exec.close()
})

test('run show --wait returns as soon as the run is terminal', async () => {
  const { machine, token, dispatch } = await setup()
  const exec = await executor(machine.token)
  const offered = await dispatch()
  assert.equal((await exec.next()).type, 'Offer')
  await running(exec, offered.id)

  const env = { DEVROUNDS_URL: `http://${host}`, DEVROUNDS_TOKEN: token, DEVROUNDS_PROJECT: projectKey }
  // The route subscribes to run changes before it reads the run, so the event below cannot slip past the wait.
  const waiting = once(runEvents, 'newListener')
  const began = Date.now()
  const shown = runCli(['run', 'show', offered.id, '--wait'], { env, configPath: join(scratch, 'config.json') })
  await waiting
  await exec.event(finished(offered.id))
  const out = await shown

  assert.equal(out.exitCode, 0, out.stderr)
  // Each wait lasts up to 25 s; the answer came with the event, not at the end of a wait.
  assert.ok(Date.now() - began < 10_000, `took ${Date.now() - began} ms`)
  const lines = out.stdout.trimEnd().split('\n')
  assert.match(lines[0], new RegExp(`^run ${offered.id} finished`))
  assert.ok(
    lines.some((line) => line.startsWith('steps:')),
    out.stdout,
  )
  assert.equal(lines.at(-1), 'next: devrounds plan show')
  exec.close()
})
