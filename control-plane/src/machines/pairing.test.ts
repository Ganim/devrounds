import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { DevRoundsError } from '../errors/error.ts'
import { type TestDb, type TestTenant, testDb } from '../test-support/db.ts'
import { CODE_TTL_MS, createPairingCode, PairingLimiter, redeemPairingCode, resolveMachineToken } from './pairing.ts'

const EXECUTOR = { os: 'windows', version: '0.1.0' }
const SOURCE = '127.0.0.1'
const MINUTE = 60_000

let t: TestDb
let app: ReturnType<typeof buildServer>

before(async () => {
  t = await testDb()
  app = buildServer({ db: t.db, logger: false })
  await app.ready()
})

after(() => app.close())

const human = (tenant: TestTenant) => ({ db: t.db, tenantId: tenant.tenantId, actor: tenant.human })
const code = (expected: string) => (err: unknown) => err instanceof DevRoundsError && err.code === expected

test('a pairing code works once and expires after 10 minutes', async () => {
  const tenant = await t.newTenant()
  const limiter = new PairingLimiter()
  const first = await createPairingCode(human(tenant), 'build-01')
  assert.match(first.code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  const row = await t.admin
    .selectFrom('pairing_codes')
    .select(['created_at', 'expires_at'])
    .where('code_hash', '=', createHash('sha256').update(first.code).digest())
    .executeTakeFirstOrThrow()
  assert.equal(row.expires_at.getTime() - row.created_at.getTime(), CODE_TTL_MS)
  assert.equal(CODE_TTL_MS, 10 * MINUTE)

  // Lowercase is the same code: people retype what they read.
  const paired = await redeemPairingCode(t.db, limiter, first.code.toLowerCase(), EXECUTOR, SOURCE)
  assert.equal(paired.machineName, 'build-01')
  assert.deepEqual(await resolveMachineToken(t.db, paired.token), {
    tenantId: tenant.tenantId,
    machineId: paired.machineId,
  })
  await assert.rejects(redeemPairingCode(t.db, limiter, first.code, EXECUTOR, SOURCE), code('DR450'))

  const late = await createPairingCode(human(tenant), 'build-02')
  await t.admin
    .updateTable('pairing_codes')
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where('code_hash', '=', createHash('sha256').update(late.code).digest())
    .execute()
  await assert.rejects(redeemPairingCode(t.db, limiter, late.code, EXECUTOR, SOURCE), code('DR450'))
  const machines = await t.admin
    .selectFrom('machines')
    .select('name')
    .where('tenant_id', '=', tenant.tenantId)
    .execute()
  assert.deepEqual(machines, [{ name: 'build-01' }])
})

test('the machine token is stored only as its SHA-256', async () => {
  const tenant = await t.newTenant()
  const { code: pairing } = await createPairingCode(human(tenant), 'build-01')
  const { token, machineId } = await redeemPairingCode(t.db, new PairingLimiter(), pairing, EXECUTOR, SOURCE)
  assert.match(token, /^drm_[A-Za-z0-9_-]{43}$/)

  const machine = await t.admin.selectFrom('machines').selectAll().where('id', '=', machineId).executeTakeFirstOrThrow()
  assert.deepEqual(machine.token_hash, createHash('sha256').update(token).digest())
  const codeRow = await t.admin
    .selectFrom('pairing_codes')
    .selectAll()
    .where('tenant_id', '=', tenant.tenantId)
    .executeTakeFirstOrThrow()
  assert.deepEqual(codeRow.code_hash, createHash('sha256').update(pairing).digest())
  // Neither secret appears anywhere in either row, in any encoding Postgres would print.
  const dump = JSON.stringify([machine, codeRow])
  for (const secret of [token, token.slice(4), pairing]) assert.ok(!dump.includes(secret), secret)
})

test('five failed redemptions lock pairing for that source for 10 minutes (DR451)', async () => {
  const tenant = await t.newTenant()
  let now = Date.parse('2026-11-18T12:00:00Z')
  const limiter = new PairingLimiter(() => now)
  const { code: valid } = await createPairingCode(human(tenant), 'build-01')

  for (const guess of ['00000000', 'ZZZZZZZZ', 'not-a-code', '', 'AAAAAAAA']) {
    await assert.rejects(redeemPairingCode(t.db, limiter, guess, EXECUTOR, SOURCE), code('DR450'))
  }
  // Locked: even the valid code is refused, and stays unused.
  await assert.rejects(
    redeemPairingCode(t.db, limiter, valid, EXECUTOR, SOURCE),
    (err) => err instanceof DevRoundsError && err.code === 'DR451' && err.data.minutes === 10,
  )
  now += 10 * MINUTE - 1
  await assert.rejects(redeemPairingCode(t.db, limiter, valid, EXECUTOR, SOURCE), code('DR451'))
  now += 1
  const paired = await redeemPairingCode(t.db, limiter, valid, EXECUTOR, SOURCE)
  assert.equal(paired.machineName, 'build-01')
})

test('concurrent wrong codes cannot get past the pairing lock', async () => {
  const tenant = await t.newTenant()
  const limiter = new PairingLimiter()
  const { code: valid } = await createPairingCode(human(tenant), 'build-01')
  // Well-formed guesses, so each one that gets a slot reaches the database.
  const guesses = Array.from({ length: 10 }, (_, i) => `${i}0000000`)
  const results = await Promise.allSettled(
    guesses.map((guess) => redeemPairingCode(t.db, limiter, guess, EXECUTOR, SOURCE)),
  )
  const codes = results.map((result) =>
    result.status === 'rejected' && result.reason instanceof DevRoundsError ? result.reason.code : 'paired',
  )
  assert.equal(codes.filter((c) => c === 'DR450').length, 5, codes.join(' '))
  assert.equal(codes.filter((c) => c === 'DR451').length, 5, codes.join(' '))
  // The five failures set the lock: even the valid code is refused now.
  await assert.rejects(redeemPairingCode(t.db, limiter, valid, EXECUTOR, SOURCE), code('DR451'))
})

test('failures from one socket address never lock pairing for another, whatever X-Forwarded-For says', async () => {
  const tenant = await t.newTenant()
  const limiter = new PairingLimiter()
  const server = buildServer({ db: t.db, logger: false, pairingLimiter: limiter })
  await server.ready()
  try {
    const pair = (pairing: string, remoteAddress: string, forwardedFor: string) =>
      server.inject({
        method: 'POST',
        url: '/api/executor/pair',
        remoteAddress,
        headers: { 'x-forwarded-for': forwardedFor },
        payload: { code: pairing, ...EXECUTOR },
      })
    const { code: valid } = await createPairingCode(human(tenant), 'build-01')
    // A fresh forwarded address per guess: the key is the socket, so the attacker's guesses still add up.
    for (let i = 0; i < 5; i++) {
      assert.equal((await pair('00000000', '203.0.113.7', `198.51.100.${i}`)).json().code, 'DR450')
    }
    assert.equal((await pair(valid, '203.0.113.7', '198.51.100.99')).json().code, 'DR451')
    const other = await pair(valid, '192.0.2.10', '203.0.113.7')
    assert.equal(other.statusCode, 200, other.body)
    assert.equal(other.json().machineName, 'build-01')
  } finally {
    await server.close()
  }
})

test('the global ceiling refuses every source, and expired sources leave the limiter', () => {
  let now = Date.parse('2026-11-18T12:00:00Z')
  const limiter = new PairingLimiter(() => now)
  // Ten sources, each up to its own lock: 50 failures, the global ceiling.
  for (let s = 0; s < 10; s++) {
    for (let i = 0; i < 5; i++) limiter.reserve(`10.0.0.${s}`)(true)
  }
  assert.throws(() => limiter.reserve('10.0.1.1'), code('DR451'))
  assert.equal(limiter.trackedSources, 10)

  now += 10 * MINUTE
  limiter.reserve('10.0.1.1')(false)
  assert.equal(limiter.trackedSources, 0)
})

test('an agent token cannot create a pairing code (DR453)', async () => {
  const tenant = await t.newTenant()
  const agent = await createToken(t.admin, tenant.tenantId, 'agent', 'agent')
  const res = await app.inject({
    method: 'POST',
    url: '/api/machines/pairing-codes',
    headers: { authorization: `Bearer ${agent}` },
    payload: { name: 'build-01' },
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'DR453')
  assert.deepEqual(res.json().data, { action: 'create a pairing code' })
  const codes = await t.admin
    .selectFrom('pairing_codes')
    .select('id')
    .where('tenant_id', '=', tenant.tenantId)
    .execute()
  assert.deepEqual(codes, [])
})

test('a machine of another tenant is not found (DR201)', async () => {
  const mine = await t.newTenant()
  const other = await t.newTenant()
  const { code: pairing } = await createPairingCode(human(other), 'theirs')
  await redeemPairingCode(t.db, new PairingLimiter(), pairing, EXECUTOR, SOURCE)
  const token = await createToken(t.admin, mine.tenantId, 'human', 'human')

  const res = await app.inject({
    method: 'POST',
    url: '/api/machines/theirs/revoke',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json().data, { kind: 'machine', key: 'theirs' })
  const list = await app.inject({ method: 'GET', url: '/api/machines', headers: { authorization: `Bearer ${token}` } })
  assert.deepEqual(list.json(), [])
  const theirs = await t.admin
    .selectFrom('machines')
    .select('revoked_at')
    .where('tenant_id', '=', other.tenantId)
    .execute()
  assert.deepEqual(theirs, [{ revoked_at: null }])
})
