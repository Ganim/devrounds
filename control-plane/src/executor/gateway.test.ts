import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import { type TestDb, testDb } from '../test-support/db.ts'
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
function dial(token?: string) {
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` }
  // Node's WebSocket (undici) takes `{ headers }`; the DOM lib's type, which wins here, only knows protocols.
  const ws = new WebSocket(`ws://${base}/api/executor/connect`, { headers } as unknown as string[])
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

test('Hello with protocol 2 answers DR151 and closes 4400', async () => {
  const { machine } = await paired()
  const session = dial(machine.token)
  await session.send({ ...HELLO, protocol: 2 })
  assert.deepEqual(await session.closed, { code: 4400, reason: 'DR151 {"got":2,"supported":1}' })
})
