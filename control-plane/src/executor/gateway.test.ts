import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { sql } from 'kysely'
import WsClient from 'ws'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { createDb } from '../db/connection.ts'
import { DevRoundsError } from '../errors/error.ts'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun } from '../jobs/enqueue.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import { createProject } from '../planning/service.ts'
import { runEvents, stopRun } from '../runs/dispatch.ts'
import { createRun, markOffered } from '../runs/record.ts'
import { runView } from '../runs/view.ts'
import { Scheduler } from '../scheduler/scheduler.ts'
import { type TestDb, testDb } from '../test-support/db.ts'
import { Sessions } from './gateway.ts'
import { FEATURES } from './protocol.ts'

let t: TestDb
let app: ReturnType<typeof buildServer>
let base: string

before(async () => {
  t = await testDb()
  app = buildServer({ db: t.db, logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

after(() => app.close())

const HELLO = { type: 'Hello', protocol: 1, version: '0.1.0', features: [...FEATURES], boot_id: 'boot-1' }
const REPORT = {
  type: 'MachineReport',
  total_memory: 34359738368,
  available_memory: 17179869184,
  commit_total: 21474836480,
  commit_limit: 68719476736,
  // Past 100 on purpose: a reading that rounds over must not reject the report.
  cpu_percent: 100.0000001,
  memory_pressure: 'normal',
  running: 0,
  executor_private_bytes: 18000000,
}

// A tenant with machine `build-01` paired; returns its token and a human member token.
async function paired(name = 'build-01') {
  const tenant = await t.newTenant()
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  const { code } = await createPairingCode(ctx, name)
  const machine = await redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' })
  const human = await createToken(t.admin, tenant.tenantId, 'human', 'human')
  return { tenant, machine, human }
}

type Closed = { code: number; reason: string }

// The executor's side of a session, over Node's global WebSocket.
function dial(token?: string, host = base) {
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` }
  // Node's WebSocket (undici) takes `{ headers }`; the DOM lib's type, which wins here, only knows protocols.
  const ws = new WebSocket(`ws://${host}/api/executor/connect`, { headers } as unknown as string[])
  const inbox: unknown[] = []
  let wake: (() => void) | undefined
  ws.addEventListener('message', (event) => {
    inbox.push(JSON.parse(String(event.data)))
    wake?.()
  })
  const closed = new Promise<Closed>((resolve) =>
    ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
  )
  const opened = new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))
  return {
    closed,
    async send(message: unknown) {
      await opened
      ws.send(JSON.stringify(message))
    },
    async next(): Promise<unknown> {
      while (inbox.length === 0) await new Promise<void>((resolve) => (wake = resolve))
      return inbox.shift()
    },
    close: () => ws.close(),
  }
}

async function helloAcked(token: string) {
  const session = dial(token)
  await session.send(HELLO)
  const ack = (await session.next()) as { type: string }
  assert.equal(ack.type, 'HelloAck')
  return session
}

test('connect without a valid machine token closes with 4401 and DR452', async () => {
  for (const token of [undefined, `drm_${'A'.repeat(43)}`, 'drt_member-token']) {
    const session = dial(token)
    await session.send(HELLO)
    const closed = await session.closed
    assert.equal(closed.code, 4401, String(token))
    assert.equal(closed.reason, 'DR452 {}')
  }
})

test('a failing token lookup closes 1011 with a bare DR501, not 4401', async () => {
  // Nothing listens on port 1: every query fails with a connection error the client must not see.
  const down = createDb('postgres://nobody:nothing@127.0.0.1:1/nothing')
  const broken = buildServer({ db: down, logger: false })
  try {
    await broken.listen({ port: 0, host: '127.0.0.1' })
    const port = (broken.server.address() as AddressInfo).port
    const session = dial(`drm_${'A'.repeat(43)}`, `127.0.0.1:${port}`)
    await session.send(HELLO)
    assert.deepEqual(await session.closed, { code: 1011, reason: 'DR501 {}' })
  } finally {
    await broken.close()
    await down.destroy()
  }
})

test('Hello gets HelloAck with last_seq and a MachineReport is kept', async () => {
  const { machine } = await paired()
  const session = dial(machine.token)
  await session.send(HELLO)
  assert.deepEqual(await session.next(), {
    type: 'HelloAck',
    protocol: 1,
    features: [...FEATURES],
    machine_id: machine.machineId,
    last_seq: 0,
    withdrawn: [],
  })
  await session.send(REPORT)
  let row: { last_report: unknown; last_seen_at: Date | null } | undefined
  for (let i = 0; i < 100 && !row?.last_report; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    row = await t.admin
      .selectFrom('machines')
      .select(['last_report', 'last_seen_at'])
      .where('id', '=', machine.machineId)
      .executeTakeFirstOrThrow()
  }
  assert.deepEqual(row?.last_report, REPORT)
  assert.ok(row?.last_seen_at)
  session.close()
})

test('revoking a machine closes its live session', async () => {
  const { machine, human } = await paired()
  const session = await helloAcked(machine.token)
  const res = await app.inject({
    method: 'POST',
    url: '/api/machines/build-01/revoke',
    headers: { authorization: `Bearer ${human}`, 'idempotency-key': 'revoke-1' },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(await session.closed, { code: 4401, reason: 'DR452 {}' })

  // The token is dead for new sessions too.
  const again = dial(machine.token)
  await again.send(HELLO)
  assert.equal((await again.closed).code, 4401)
})

test('a second session for the same machine replaces the first (close 4409)', async () => {
  const { machine, human } = await paired()
  const first = await helloAcked(machine.token)
  const second = await helloAcked(machine.token)
  assert.equal((await first.closed).code, 4409)

  const list = await app.inject({ method: 'GET', url: '/api/machines', headers: { authorization: `Bearer ${human}` } })
  assert.deepEqual(
    list.json().map((m: { name: string; connected: boolean }) => [m.name, m.connected]),
    [['build-01', true]],
  )
  second.close()
})

// One run offered to each named paired machine, ready for its executor's events.
async function offeredRuns(tenant: Awaited<ReturnType<typeof paired>>['tenant'], ...machineNames: string[]) {
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  await createProject(ctx, { key: 'devrounds', name: 'DevRounds' })
  await putJobType(ctx, 'devrounds', {
    key: 'check',
    command: { program: 'pnpm', args: ['check'] },
    env: ['PATH'],
    timeout_s: 600,
    orphan_policy: 'kill',
    classify: [],
  })
  const runs: string[] = []
  for (const machineName of machineNames) {
    const run = await createRun(ctx, { projectKey: 'devrounds', jobTypeKey: 'check', machineName, cwd: 'C:\\w' })
    await markOffered(ctx, run.id, traceParentOf(run.id))
    runs.push(run.id)
  }
  return runs
}

// As if dispatched with telemetry on: the trace id is the run's uuid, the dispatch span id its first 16 hex digits.
function traceParentOf(run: string): string {
  const hex = run.replaceAll('-', '')
  return `00-${hex}-${hex.slice(0, 16)}-01`
}

const delayedEvent = (seq: number, run: string) => ({
  type: 'Event',
  seq,
  at: AT,
  event: { kind: 'Delayed', run, reason: 'memory', position: 1, need: 1024, available: 512 },
})

function delayCount(run: string) {
  return t.admin
    .selectFrom('run_delays')
    .select('id')
    .where('run_id', '=', run)
    .execute()
    .then((rows) => rows.length)
}

const AT = '2026-11-18T12:00:00Z'
// Names no run, so it changes nothing and needs no run.
const orphans = (seq: number) => ({ type: 'Event', seq, at: AT, event: { kind: 'Orphans', runs: [] } })
const ack = (seq: number) => ({ type: 'Ack', seq })

function lastSeq(machineId: string) {
  return t.admin
    .selectFrom('machines')
    .select('last_seq')
    .where('id', '=', machineId)
    .executeTakeFirstOrThrow()
    .then((row) => Number(row.last_seq))
}

test('an event with seq <= last_seq is acked and not applied twice', async () => {
  const { tenant, machine } = await paired()
  const [run] = await offeredRuns(tenant, 'build-01')
  const delayed = (seq: number) => delayedEvent(seq, run)
  const session = await helloAcked(machine.token)
  assert.equal(((await session.next()) as { type: string }).type, 'Offer')
  await session.send(delayed(1))
  assert.deepEqual(await session.next(), ack(1))
  // The executor resends after a reconnect it thinks lost the ack.
  await session.send(delayed(1))
  assert.deepEqual(await session.next(), ack(1))
  session.close()

  const again = dial(machine.token)
  await again.send(HELLO)
  assert.equal(((await again.next()) as { last_seq: number }).last_seq, 1)
  // Delayed leaves the run offered, so each session gets its Offer again.
  assert.equal(((await again.next()) as { type: string }).type, 'Offer')
  await again.send(delayed(1))
  assert.deepEqual(await again.next(), ack(1))
  again.close()

  // Each apply of Delayed adds a run_delays row.
  assert.equal(await delayCount(run), 1)
  assert.equal(await lastSeq(machine.machineId), 1)
})

test('a gap gets exactly one Resync', async () => {
  const { machine } = await paired()
  const session = await helloAcked(machine.token)
  await session.send(orphans(1))
  assert.deepEqual(await session.next(), ack(1))
  await session.send(orphans(3))
  assert.deepEqual(await session.next(), { type: 'Resync', from_seq: 2 })
  // Still missing 2: no second Resync, and the ack stays at the last applied seq.
  await session.send(orphans(4))
  assert.deepEqual(await session.next(), ack(1))
  for (const seq of [2, 3, 4]) {
    await session.send(orphans(seq))
    assert.deepEqual(await session.next(), ack(seq))
  }
  session.close()
  assert.equal(await lastSeq(machine.machineId), 4)
})

// Ack is cumulative: acking the ahead-of-gap seq would tell the executor to drop the missing events.
test('with a gap open, an ahead-of-gap event does not advance the ack', async () => {
  const { machine } = await paired()
  const session = await helloAcked(machine.token)
  await session.send(orphans(2))
  assert.deepEqual(await session.next(), { type: 'Resync', from_seq: 1 })
  await session.send(orphans(3))
  assert.deepEqual(await session.next(), ack(0))
  session.close()
  assert.equal(await lastSeq(machine.machineId), 0)
})

test('an event answering DR351 is acked and its seq counts as applied', async () => {
  const { tenant, machine } = await paired()
  const [run] = await offeredRuns(tenant, 'build-01')
  const admitted = (seq: number) => ({ type: 'Event', seq, at: AT, event: { kind: 'Admitted', run } })
  const session = await helloAcked(machine.token)
  assert.equal(((await session.next()) as { type: string }).type, 'Offer')
  await session.send(admitted(1))
  assert.deepEqual(await session.next(), ack(1))
  // admitted → admitted is illegal; a session that stopped here would get the same event forever.
  await session.send(admitted(2))
  assert.deepEqual(await session.next(), ack(2))
  session.close()
  assert.equal(await lastSeq(machine.machineId), 2)
})

test('an event for a run of another machine (DR201) is logged and acked, and the next event is applied', async () => {
  const { tenant, machine } = await paired()
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  const { code } = await createPairingCode(ctx, 'build-02')
  await redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' })
  const [own, other] = await offeredRuns(tenant, 'build-01', 'build-02')
  const lines: string[] = []
  const logged = buildServer({ db: t.db, logger: { level: 'warn', stream: { write: (line) => lines.push(line) } } })
  try {
    await logged.listen({ port: 0, host: '127.0.0.1' })
    const session = dial(machine.token, `127.0.0.1:${(logged.server.address() as AddressInfo).port}`)
    await session.send(HELLO)
    assert.equal(((await session.next()) as { type: string }).type, 'HelloAck')
    assert.deepEqual(((await session.next()) as { run: string }).run, own)
    await session.send(delayedEvent(1, other))
    assert.deepEqual(await session.next(), ack(1))
    await session.send(delayedEvent(2, own))
    assert.deepEqual(await session.next(), ack(2))
    session.close()
    await session.closed
  } finally {
    await logged.close()
  }
  const rejected = lines.map((line) => JSON.parse(line)).filter((entry) => entry.msg?.startsWith('executor event'))
  assert.deepEqual(
    rejected.map(({ code, machineId, seq, run }) => ({ code, machineId, seq, run })),
    [{ code: 'DR201', machineId: machine.machineId, seq: 1, run: other }],
  )
  assert.equal(await delayCount(other), 0)
  assert.equal(await delayCount(own), 1)
  assert.equal(await lastSeq(machine.machineId), 2)
})

// A DR5xx is a fault of this side (DR501 wraps a database error): replaying can succeed, so it must not be skipped.
test('an event whose apply fails with a DR5xx closes 1011 instead of being acked', async () => {
  const { tenant, machine } = await paired()
  const [run] = await offeredRuns(tenant, 'build-01')
  const session = await helloAcked(machine.token)
  assert.equal(((await session.next()) as { type: string }).type, 'Offer')
  const failing = (changed: string) => {
    if (changed === run) throw new DevRoundsError('DR501', { cause: 'injected' })
  }
  runEvents.on('changed', failing)
  try {
    await session.send(delayedEvent(1, run))
    const first = await Promise.race([session.next(), session.closed])
    assert.deepEqual(first, { code: 1011, reason: 'DR501 {}' })
  } finally {
    runEvents.off('changed', failing)
  }
})

test('a malformed event keeps its place in the sequence', async () => {
  const { machine } = await paired()
  const session = await helloAcked(machine.token)
  await session.send({ type: 'Event', seq: 1, at: 'yesterday', event: { kind: 'Orphans', runs: [] } })
  assert.deepEqual(await session.next(), ack(1))
  await session.send(orphans(2))
  assert.deepEqual(await session.next(), ack(2))
  session.close()
  assert.equal(await lastSeq(machine.machineId), 2)
})

test('last_seq survives a control plane restart', async () => {
  const { machine } = await paired()
  const session = await helloAcked(machine.token)
  for (const seq of [1, 2, 3]) {
    await session.send(orphans(seq))
    assert.deepEqual(await session.next(), ack(seq))
  }
  session.close()

  const restarted = buildServer({ db: t.db, logger: false })
  try {
    await restarted.listen({ port: 0, host: '127.0.0.1' })
    const port = (restarted.server.address() as AddressInfo).port
    const again = dial(machine.token, `127.0.0.1:${port}`)
    await again.send(HELLO)
    assert.equal(((await again.next()) as { last_seq: number }).last_seq, 3)
    again.close()
  } finally {
    await restarted.close()
  }
})

// Pairing a home again makes a new machine at last_seq 0 while the executor's seqs go on from its store; a control
// plane restored from a backup is behind the same way. Without Hello.acked_through the first event is a gap whose
// Resync resends the same seq, which then reads as a duplicate forever.
test('a Hello acked through a seq past last_seq raises last_seq to it, and the next event applies', async () => {
  const { tenant, machine } = await paired()
  const [run] = await offeredRuns(tenant, 'build-01')
  const lines: string[] = []
  const logged = buildServer({ db: t.db, logger: { level: 'warn', stream: { write: (line) => lines.push(line) } } })
  try {
    await logged.listen({ port: 0, host: '127.0.0.1' })
    const session = dial(machine.token, `127.0.0.1:${(logged.server.address() as AddressInfo).port}`)
    await session.send({ ...HELLO, acked_through: 41 })
    assert.equal(((await session.next()) as { last_seq: number }).last_seq, 41)
    assert.equal(((await session.next()) as { type: string }).type, 'Offer')
    await session.send({ type: 'Event', seq: 42, at: AT, event: { kind: 'Admitted', run } })
    assert.deepEqual(await session.next(), ack(42))
    session.close()
    await session.closed
  } finally {
    await logged.close()
  }
  assert.equal(await lastSeq(machine.machineId), 42)
  const state = await t.admin.selectFrom('runs').select('state').where('id', '=', run).executeTakeFirstOrThrow()
  assert.equal(state.state, 'admitted')
  const raised = lines.map((line) => JSON.parse(line)).filter((entry) => entry.msg?.startsWith('executor acked'))
  assert.deepEqual(
    raised.map(({ machineId, lastSeq, ackedThrough, lost }) => ({ machineId, lastSeq, ackedThrough, lost })),
    [{ machineId: machine.machineId, lastSeq: 0, ackedThrough: 41, lost: 41 }],
  )

  // At or below last_seq it changes nothing: the executor resends what was not applied.
  const again = dial(machine.token)
  await again.send({ ...HELLO, acked_through: 40 })
  assert.equal(((await again.next()) as { last_seq: number }).last_seq, 42)
  again.close()
})

test('Hello with protocol 2 answers DR151 and closes 4400', async () => {
  const { machine } = await paired()
  const session = dial(machine.token)
  await session.send({ ...HELLO, protocol: 2 })
  assert.deepEqual(await session.closed, { code: 4400, reason: 'DR151 {"got":2,"supported":1}' })
})

// A session that dropped between the dispatch commit and the send lost the Offer; the run would stay offered.
test('after HelloAck, the Offer of every run of this machine still offered is sent again', async () => {
  const { tenant, machine } = await paired()
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  await createPairingCode(ctx, 'build-02').then(({ code }) =>
    redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' }),
  )
  const [offered, admitted] = await offeredRuns(tenant, 'build-01', 'build-01', 'build-02')
  const session = await helloAcked(machine.token)
  // Both offers of this machine go out after the HelloAck; the admitted one is the executor's already.
  const first = (await session.next()) as { type: string; run: string }
  const second = (await session.next()) as { type: string; run: string }
  assert.deepEqual([first.type, second.type], ['Offer', 'Offer'])
  assert.deepEqual([first.run, second.run].sort(), [offered, admitted].sort())
  await session.send({ type: 'Event', seq: 1, at: AT, event: { kind: 'Admitted', run: admitted } })
  assert.deepEqual(await session.next(), ack(1))
  session.close()
  await session.closed

  const again = await helloAcked(machine.token)
  assert.deepEqual(await again.next(), {
    type: 'Offer',
    run: offered,
    job: { job_type: 'check', program: 'pnpm', args: ['check'], cwd: 'C:\\w', env_allow: ['PATH'], timeout_s: 600 },
    memory_need: 536870912,
    // The same traceparent as the first Offer, rebuilt from runs.trace_id and trace_span_id.
    trace_parent: traceParentOf(offered),
  })
  // Nothing else: an event answers its Ack next, with no Offer of the other runs in between.
  await again.send(orphans(2))
  assert.deepEqual(await again.next(), ack(2))
  again.close()
})

test('an Orphans event with the kill policy answers Stop before its Ack', async () => {
  const { tenant, machine } = await paired()
  const [run] = await offeredRuns(tenant, 'build-01')
  const session = await helloAcked(machine.token)
  assert.equal(((await session.next()) as { type: string }).type, 'Offer')
  const events = [
    { kind: 'Admitted', run },
    { kind: 'RunStarted', run, pid: 42, start_time: '1', boot_id: 'boot-1' },
    { kind: 'Orphans', runs: [{ run, alive: true }] },
  ]
  for (const [index, event] of events.entries()) {
    await session.send({ type: 'Event', seq: index + 1, at: AT, event })
    if (index === 2) assert.deepEqual(await session.next(), { type: 'Stop', run, reason: 'orphan_policy' })
    assert.deepEqual(await session.next(), ack(index + 1))
  }
  session.close()
})

// The Orphans event committed but the socket closed before the Stop went out: the next session acks it through
// last_seq, so the Stop must come again after HelloAck or the kill policy is lost.
test('after HelloAck, the Stop of every run of this machine orphaned to be killed is sent again', async () => {
  const { tenant, machine } = await paired()
  const [run] = await offeredRuns(tenant, 'build-01')
  const session = await helloAcked(machine.token)
  assert.equal(((await session.next()) as { type: string }).type, 'Offer')
  const events = [
    { kind: 'Admitted', run },
    { kind: 'RunStarted', run, pid: 42, start_time: '1', boot_id: 'boot-1' },
    { kind: 'Orphans', runs: [{ run, alive: true }] },
  ]
  for (const [index, event] of events.entries()) {
    await session.send({ type: 'Event', seq: index + 1, at: AT, event })
  }
  // Whether or not this session's Stop reached the executor, the control plane cannot know it did.
  const replies = [await session.next(), await session.next(), await session.next(), await session.next()]
  assert.deepEqual(replies.at(-1), ack(3))
  session.close()
  await session.closed

  const again = dial(machine.token)
  await again.send(HELLO)
  assert.equal(((await again.next()) as { last_seq: number }).last_seq, 3)
  assert.deepEqual(await again.next(), { type: 'Stop', run, reason: 'orphan_policy' })
  again.close()
})

// Ends `run` as an expiry or a stop on an offline machine does, `age` ago.
function withdraw(run: string, age: string) {
  return t.admin
    .updateTable('runs')
    .set({
      state: 'stopped',
      failure_class: 'cancelled',
      finished_at: sql<Date>`now() - ${age}::interval`,
      withdrawn_at: sql<Date>`now() - ${age}::interval`,
    })
    .where('id', '=', run)
    .execute()
}

test('HelloAck lists withdrawn runs of the last 7 days only to an executor with the withdraw feature', async () => {
  const { tenant, machine } = await paired()
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  await createPairingCode(ctx, 'build-02').then(({ code }) =>
    redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' }),
  )
  const [recent, old, offered, other] = await offeredRuns(tenant, 'build-01', 'build-01', 'build-01', 'build-02')
  await withdraw(recent, '6 days')
  await withdraw(old, '8 days')
  await withdraw(other, '1 hour')

  const session = dial(machine.token)
  await session.send(HELLO)
  const helloAck = (await session.next()) as { withdrawn: string[] }
  assert.deepEqual(helloAck.withdrawn, [recent])
  assert.deepEqual(await session.next(), {
    type: 'Offer',
    run: offered,
    job: { job_type: 'check', program: 'pnpm', args: ['check'], cwd: 'C:\\w', env_allow: ['PATH'], timeout_s: 600 },
    memory_need: 536870912,
    trace_parent: traceParentOf(offered),
  })
  session.close()
  await session.closed

  // An executor from before the feature would not know what to do with the list.
  const older = dial(machine.token)
  await older.send({ ...HELLO, features: FEATURES.filter((feature) => feature !== 'withdraw') })
  const olderAck = (await older.next()) as { features: string[]; withdrawn: string[] }
  assert.ok(!olderAck.features.includes('withdraw'))
  assert.deepEqual(olderAck.withdrawn, [])
  older.close()
})

test('a late Admitted for a withdrawn run is skipped and changes nothing', async () => {
  const { tenant, machine } = await paired()
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  const [run] = await offeredRuns(tenant, 'build-01')
  // No live session: the stop withdraws the offer at once.
  await stopRun(ctx, new Sessions(), run)
  const row = () => t.admin.selectFrom('runs').selectAll().where('id', '=', run).executeTakeFirstOrThrow()
  const before = await row()
  assert.equal(before.state, 'stopped')
  assert.ok(before.withdrawn_at)

  const session = dial(machine.token)
  await session.send(HELLO)
  assert.deepEqual(((await session.next()) as { withdrawn: string[] }).withdrawn, [run])
  // The executor admitted it before it read the HelloAck.
  await session.send({ type: 'Event', seq: 1, at: AT, event: { kind: 'Admitted', run } })
  assert.deepEqual(await session.next(), ack(1))
  session.close()

  assert.deepEqual(await row(), before)
  assert.equal(await lastSeq(machine.machineId), 1)
})

test('a session that stops answering pings ends within 45 s and gets no offers', async () => {
  // 45 s is 3 intervals of 15 s; the same count of a shorter interval keeps the test fast.
  const pingMs = 200
  const sessions = new Sessions()
  const scheduler = new Scheduler({
    db: t.db,
    sessions,
    offerTimeoutS: 120,
    pollMs: 600_000,
    telemetry: null,
    log: { warn: () => {}, error: () => {} },
  })
  const server = buildServer({ db: t.db, logger: false, sessions, scheduler, pingMs })
  await server.listen({ port: 0, host: '127.0.0.1' })
  const host = `127.0.0.1:${(server.server.address() as AddressInfo).port}`
  try {
    const { tenant, machine } = await paired()
    const ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' as const } }
    await createProject(ctx, { key: 'devrounds', name: 'DevRounds' })
    await putJobType(ctx, 'devrounds', { key: 'check', command: { program: 'pnpm', args: ['check'] } })

    // Node's WebSocket answers every ping: its session outlives several intervals.
    const answering = dial(machine.token, host)
    await answering.send(HELLO)
    assert.equal(((await answering.next()) as { type: string }).type, 'HelloAck')
    await sleep(pingMs * 5)
    assert.ok(sessions.get(machine.machineId), 'a session that answers pings stays')
    answering.close()
    await answering.closed

    const silent = new WsClient(`ws://${host}/api/executor/connect`, {
      headers: { authorization: `Bearer ${machine.token}` },
      autoPong: false,
    })
    const ended = new Promise<number>((resolve) => silent.on('close', (code) => resolve(code)))
    const firstFrame = new Promise<{ type: string }>((resolve) =>
      silent.once('message', (data) => resolve(JSON.parse(String(data)))),
    )
    await once(silent, 'open')
    silent.send(JSON.stringify(HELLO))
    assert.equal((await firstFrame).type, 'HelloAck')
    const began = Date.now()
    // terminate() drops the socket without a close frame.
    assert.equal(await ended, 1006)
    const took = Date.now() - began
    assert.ok(took >= pingMs, `ended after ${took} ms, before a ping could be missed`)
    // Three intervals, plus room for a loaded machine.
    assert.ok(took < 3 * pingMs + 1000, `ended after ${took} ms`)
    assert.equal(sessions.get(machine.machineId), undefined)

    const queued = await enqueueRun(ctx, {
      projectKey: 'devrounds',
      jobTypeKey: 'check',
      cwd: 'C:\\w',
      machineName: 'build-01',
    })
    await scheduler.tick()
    assert.equal((await runView(ctx, queued.id)).state, 'queued')
  } finally {
    await scheduler.stop()
    await server.close()
  }
})
