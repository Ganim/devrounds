import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import type { WebSocket } from 'ws'
import { Sessions } from '../executor/gateway.ts'
import { FEATURES } from '../executor/protocol.ts'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun } from '../jobs/enqueue.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { type TestDb, testDb } from '../test-support/db.ts'
import { claimRun } from './claim.ts'
import { placeable, unplacedReasons } from './placeable.ts'

const projectKey = 'devrounds'
const MIB = 1024 * 1024
const GIB = 1024 * MIB

let t: TestDb

before(async () => {
  t = await testDb()
})

// A tenant with job types `check` (no need_mb: 512 MiB), `mid` (8000 MiB) and `heavy` (20000 MiB) and the machines
// `names` paired.
async function setup(names: string[]) {
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await putJobType(ctx, projectKey, { key: 'check', command: { program: 'pnpm' } })
  await putJobType(ctx, projectKey, { key: 'mid', command: { program: 'pnpm' }, need_mb: 8000 })
  await putJobType(ctx, projectKey, { key: 'heavy', command: { program: 'pnpm' }, need_mb: 20000 })
  const machines = []
  for (const name of names) {
    const { code } = await createPairingCode(ctx, name)
    machines.push(await redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' }))
  }
  const enqueue = async (jobTypeKey: string, machineName?: string) =>
    (await enqueueRun(ctx, { projectKey, jobTypeKey, cwd: 'C:\\work', machineName })).id
  return { tenant, ctx, machines, enqueue }
}

// A session as the gateway keeps it after Hello and a MachineReport of `available` of 32 GiB (reserve 2 GiB). No
// scheduler sees these sessions, so nothing is placed behind the test's back.
function connect(
  sessions: Sessions,
  tenantId: string,
  machineId: string,
  o: { available?: number; idleAvailable?: number; at?: number; features?: readonly string[] } = {},
) {
  sessions.open(machineId, {
    tenantId,
    socket: { close() {} } as unknown as WebSocket,
    features: [...(o.features ?? FEATURES)],
    report: {
      at: o.at ?? Date.now(),
      availableMemory: BigInt(o.available ?? 16 * GIB),
      totalMemory: BigInt(32 * GIB),
      idleAvailable: o.idleAvailable === undefined ? undefined : BigInt(o.idleAvailable),
    },
  })
}

test('no machine connected, or only one of another tenant, answers no_machine; a pin answers machine_offline', async () => {
  const sessions = new Sessions()
  const stranger = await setup([])
  const other = await setup(['elsewhere'])
  connect(sessions, other.tenant.tenantId, other.machines[0].machineId)
  const mine = await setup(['build-01'])
  const loose = await mine.enqueue('check')
  const pinned = await mine.enqueue('check', 'build-01')
  assert.deepEqual(
    await unplacedReasons(mine.ctx, sessions, [loose, pinned]),
    new Map([
      [loose, { reason: 'no_machine' }],
      [pinned, { reason: 'machine_offline', machine: 'build-01' }],
    ]),
  )
  // Another tenant's run id answers nothing: RLS hides it.
  assert.deepEqual(await unplacedReasons(stranger.ctx, sessions, [loose]), new Map())
})

test('a run that fits a live machine has no reason; a pin to the other machine is offline', async () => {
  const sessions = new Sessions()
  const { tenant, ctx, machines, enqueue } = await setup(['build-01', 'build-02'])
  connect(sessions, tenant.tenantId, machines[0].machineId)
  const fits = await enqueue('check')
  const pinned = await enqueue('check', 'build-02')
  assert.deepEqual(
    await unplacedReasons(ctx, sessions, [fits, pinned]),
    new Map([[pinned, { reason: 'machine_offline', machine: 'build-02' }]]),
  )
})

test('a machine the scheduler would not offer to (stale report, no job-env) counts as not connected', async () => {
  const sessions = new Sessions()
  const { tenant, ctx, machines, enqueue } = await setup(['build-01', 'build-02'])
  connect(sessions, tenant.tenantId, machines[0].machineId, { at: Date.now() - 31_000 })
  connect(sessions, tenant.tenantId, machines[1].machineId, { features: FEATURES.filter((f) => f !== 'job-env') })
  const run = await enqueue('check')
  assert.deepEqual(await unplacedReasons(ctx, sessions, [run]), new Map([[run, { reason: 'no_machine' }]]))
})

test('a need above free memory names the roomiest machine, its need and free after reserve and offered runs', async () => {
  const sessions = new Sessions()
  const { tenant, ctx, machines, enqueue } = await setup(['build-01', 'build-02'])
  connect(sessions, tenant.tenantId, machines[0].machineId, { available: 16 * GIB })
  connect(sessions, tenant.tenantId, machines[1].machineId, { available: 4 * GIB })
  const heavy = await enqueue('heavy')
  assert.deepEqual(
    await unplacedReasons(ctx, sessions, [heavy]),
    new Map([[heavy, { reason: 'memory', machine: 'build-01', needBytes: 20000 * MIB, freeBytes: 14 * GIB }]]),
  )

  // An offered run's need is taken from the room, as claim_run takes it: the second `mid` no longer fits build-01.
  const first = await enqueue('mid', 'build-01')
  const second = await enqueue('mid', 'build-01')
  const claimed = await withTenant(t.db, tenant.tenantId, (trx) =>
    claimRun(trx, machines[0].machineId, {
      freeBytes: BigInt(16 * GIB),
      reserveBytes: BigInt(2 * GIB),
      offerTimeoutS: 60,
    }),
  )
  assert.equal(claimed?.runId, first)
  const again = await withTenant(t.db, tenant.tenantId, (trx) =>
    claimRun(trx, machines[0].machineId, {
      freeBytes: BigInt(16 * GIB),
      reserveBytes: BigInt(2 * GIB),
      offerTimeoutS: 60,
    }),
  )
  assert.equal(again?.runId, undefined)
  assert.deepEqual(
    await unplacedReasons(ctx, sessions, [first, second]),
    new Map([
      [second, { reason: 'memory', machine: 'build-01', needBytes: 8000 * MIB, freeBytes: 14 * GIB - 8000 * MIB }],
    ]),
  )
})

test('a running run counts its need minus what the machine used since it was idle, in placement and in claim', async () => {
  const sessions = new Sessions()
  const { tenant, ctx, machines, enqueue } = await setup(['build-01', 'build-02'])
  const [busy, spare] = machines.map((m) => m.machineId)
  // build-01 runs a `mid` (8000 MiB) that has used 1 GiB so far: idle it had 27 GiB free, now 26 GiB.
  const running = await enqueue('mid', 'build-01')
  const offered = await withTenant(t.db, tenant.tenantId, (trx) =>
    claimRun(trx, busy, { freeBytes: BigInt(27 * GIB), reserveBytes: 0n, offerTimeoutS: 60 }),
  )
  assert.equal(offered?.runId, running)
  await t.admin
    .updateTable('runs')
    .set({ state: 'running', started_at: new Date() })
    .where('id', '=', running)
    .execute()
  connect(sessions, tenant.tenantId, busy, { available: 26 * GIB, idleAvailable: 27 * GIB })
  connect(sessions, tenant.tenantId, spare, { available: 24 * GIB })

  // build-01 has 26 - 2 - (8000 MiB - 1 GiB) left, under `heavy`'s 20000 MiB; build-02 has 22 GiB and comes first.
  const busyRoom = 24 * GIB - (8000 * MIB - GIB)
  const order = await withTenant(t.db, tenant.tenantId, (trx) => placeable(trx, sessions, tenant.tenantId, Date.now()))
  assert.deepEqual(
    order.map((m) => [m.machineId, m.room]),
    [
      [spare, BigInt(22 * GIB)],
      [busy, BigInt(busyRoom)],
    ],
  )
  const heavy = await enqueue('heavy', 'build-01')
  const claimed = await withTenant(t.db, tenant.tenantId, (trx) =>
    claimRun(trx, busy, {
      freeBytes: order[1].available,
      reserveBytes: order[1].reserve,
      runningUsedBytes: order[1].runningUsed,
      offerTimeoutS: 60,
    }),
  )
  assert.equal(claimed, null)
  assert.deepEqual(
    await unplacedReasons(ctx, sessions, [heavy]),
    new Map([[heavy, { reason: 'memory', machine: 'build-01', needBytes: 20000 * MIB, freeBytes: busyRoom }]]),
  )
})
