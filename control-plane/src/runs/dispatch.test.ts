import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { runCli } from '../cli/commands.ts'
import { DevRoundsError } from '../errors/error.ts'
import { Sessions } from '../executor/gateway.ts'
import { FEATURES } from '../executor/protocol.ts'
import { putJobType } from '../job-types/service.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { type TestDb, testDb } from '../test-support/db.ts'
import { dispatchRun, runEvents, stopRun } from './dispatch.ts'
import { runView } from './view.ts'

const projectKey = 'devrounds'
const MIB = 1024 * 1024
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

let t: TestDb
let sessions: Sessions
let app: ReturnType<typeof buildServer>
let host: string
let scratch: string

before(async () => {
  t = await testDb()
  sessions = new Sessions()
  app = buildServer({ db: t.db, logger: false, sessions })
  await app.listen({ port: 0, host: '127.0.0.1' })
  host = `127.0.0.1:${(app.server.address() as AddressInfo).port}`
  await mkdir(join(REPO_ROOT, '.superpowers', 'tmp'), { recursive: true })
  scratch = await mkdtemp(join(REPO_ROOT, '.superpowers', 'tmp', 'dispatch-'))
})

after(async () => {
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
  const dispatch = () =>
    dispatchRun(ctx, sessions, { projectKey, jobTypeKey: 'check', machineName: 'build-01', cwd: 'C:\\work' })
  return { tenant, ctx, machine, token, dispatch }
}

type Message = { type: string; [field: string]: unknown }

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
  assert.equal((await next()).type, 'HelloAck')
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

// Admitted and started, with one finished step.
async function running(exec: Awaited<ReturnType<typeof executor>>, run: string) {
  await exec.event({ kind: 'Admitted', run })
  await exec.event({ kind: 'RunStarted', run, pid: 4321, start_time: '134077128011234567', boot_id: 'boot-1' })
  await exec.event({ kind: 'StepStarted', run, step: 0, name: 'build' })
  await exec.event({ kind: 'StepFinished', run, step: 0, outcome: 'finished' })
}

test('dispatch to a machine without a live session answers DR350 and writes no run', async () => {
  const { tenant, dispatch } = await setup()
  await assert.rejects(dispatch(), (err) => code('DR350')(err) && (err as DevRoundsError).data.machine === 'build-01')
  const runs = await t.admin.selectFrom('runs').select('id').where('tenant_id', '=', tenant.tenantId).execute()
  const jobs = await t.admin.selectFrom('jobs').select('id').where('tenant_id', '=', tenant.tenantId).execute()
  assert.deepEqual([runs, jobs], [[], []])
})

test('dispatch sends one Offer with memory_need 536870912 without history', async () => {
  const { machine, token } = await setup()
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
  assert.equal(view.state, 'offered')
  // The same key replays the stored answer and offers nothing again.
  const replay = (await (await post()).json()) as { id: string }
  assert.equal(replay.id, view.id)

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
    trace_parent: null,
  })
  // The next frame is the Ack of this event, so no second Offer came before it.
  await exec.event({ kind: 'Admitted', run: view.id })
  exec.close()
})

test('executor events drive the run to finished with timeline and resources', async () => {
  const { ctx, machine, dispatch } = await setup()
  const exec = await executor(machine.token)
  const offered = await dispatch()
  assert.equal((await exec.next()).type, 'Offer')
  await running(exec, offered.id)
  await exec.event(finished(offered.id))

  const view = await runView(ctx, offered.id)
  assert.equal(view.state, 'finished')
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

  // The session dropping between the check and the send.
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
