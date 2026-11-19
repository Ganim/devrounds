import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { putJobType } from './job-types/service.ts'
import { enqueueRun } from './jobs/enqueue.ts'
import type { Ctx } from './planning/resolve.ts'
import { createProject } from './planning/service.ts'
import { claimRun } from './scheduler/claim.ts'
import { withTenant } from './tenancy/scope.ts'
import { isolatedTestDb, TEST_DATABASE_URL, testDb } from './test-support/db.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
// Startup loads ~1100 modules; on a busy Windows disk under antivirus that has taken over a minute.
const START_BUDGET_MS = 120_000

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as { port: number }
  probe.close()
  await once(probe, 'close')
  return port
}

// Spawned the way service/supervise.ts does it, IPC channel included: that channel alone keeps a child alive.
function serve(
  port: number,
  logsRoot: string,
  env: Record<string, string> = {},
): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, [MAIN, 'serve'], {
    env: {
      ...process.env,
      DEVROUNDS_DATABASE_URL: TEST_DATABASE_URL,
      ...env,
      DEVROUNDS_PORT: String(port),
      DEVROUNDS_LOGS_ROOT: logsRoot,
      DEVROUNDS_OTLP_ENDPOINT: '',
      // serve prunes expired segments of every tenant at start; with the default 14 days it would delete, in
      // parallel, the segments log-store.test.ts plants at the epoch and expects its own prune to count.
      DEVROUNDS_LOG_RETENTION_DAYS: '36500',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  let stderr = ''
  child.stdout?.resume()
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  return { child, stderr: () => stderr }
}

async function healthy(port: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return true
    } catch {
      // Not listening yet.
    }
    await sleep(200)
  }
  return false
}

test('serve listens, and a second serve on the same port exits instead of hanging', {
  timeout: 2 * START_BUDGET_MS + 10_000,
}, async (t) => {
  await testDb()
  const scratch = join(fileURLToPath(new URL('../../', import.meta.url)), '.superpowers', 'tmp')
  await mkdir(scratch, { recursive: true })
  const logsRoot = await mkdtemp(join(scratch, 'devrounds-serve-'))
  const port = await freePort()
  const first = serve(port, logsRoot)
  t.after(async () => {
    first.child.kill()
    await rm(logsRoot, { recursive: true, force: true })
  })
  assert.ok(await healthy(port, Date.now() + START_BUDGET_MS), first.stderr())

  const second = serve(port, logsRoot)
  t.after(() => second.child.kill())
  const exited = once(second.child, 'exit')
  const deadline = Date.now() + START_BUDGET_MS
  while (!second.stderr().includes('DR504') && second.child.exitCode === null && Date.now() < deadline) {
    await sleep(200)
  }
  // Says plainly that the port is taken, and by whom where that is cheap to find (Windows).
  const holder = process.platform === 'win32' ? `process ${first.child.pid}` : 'another process'
  assert.match(second.stderr(), new RegExp(`DR504: Port ${port} on 127\\.0\\.0\\.1 is already in use by ${holder}\\.`))
  // Once the failure is reported nothing may keep it alive, or the supervisor never gets to restart it.
  const result = await Promise.race([exited, sleep(10_000, 'still running')])
  assert.notEqual(result, 'still running', `a serve that cannot listen must exit:\n${second.stderr()}`)
  assert.notEqual((result as [number | null])[0], 0)
})

// A crash leaves offers whose timeout ran out while no control plane was up to hear the answer; expiring them at the
// first tick would requeue work the executors may already be running.
test('serve start re-arms pending offers instead of expiring them', {
  timeout: START_BUDGET_MS + 60_000,
}, async (t) => {
  // Its own database: serve expires and re-arms offers of every tenant.
  const db = await isolatedTestDb('rearm')
  const tenant = await db.newTenant()
  const ctx: Ctx = { db: db.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: 'devrounds', name: 'DevRounds' })
  await putJobType(ctx, 'devrounds', { key: 'check', command: { program: 'pnpm', args: ['check'] } })
  const machineId = await withTenant(db.db, tenant.tenantId, async (trx) => {
    const row = await trx
      .insertInto('machines')
      .values({
        tenant_id: tenant.tenantId,
        name: 'build-01',
        token_hash: randomBytes(32),
        os: 'windows',
        executor_version: '0.1.0',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
  // An offered run whose offer ran out `ago` (a Postgres interval).
  const offered = async (ago: string) => {
    const run = (await enqueueRun(ctx, { projectKey: 'devrounds', jobTypeKey: 'check', cwd: 'C:\\work' })).id
    const claimed = await withTenant(db.db, tenant.tenantId, (trx) =>
      claimRun(trx, machineId, { freeBytes: 1n << 36n, reserveBytes: 0n, offerTimeoutS: 120 }),
    )
    assert.equal(claimed?.runId, run)
    await db.admin
      .updateTable('runs')
      .set({ offer_expires_at: sql<Date>`now() - ${ago}::interval` })
      .where('id', '=', run)
      .execute()
    return run
  }
  const row = (run: string) =>
    db.admin
      .selectFrom('runs')
      .select(['state', sql<boolean>`offer_expires_at > now() + interval '500 seconds'`.as('rearmed')])
      .where('id', '=', run)
      .executeTakeFirstOrThrow()
  const leftByCrash = await offered('1 hour')

  const scratch = join(fileURLToPath(new URL('../../', import.meta.url)), '.superpowers', 'tmp')
  await mkdir(scratch, { recursive: true })
  const logsRoot = await mkdtemp(join(scratch, 'devrounds-rearm-'))
  const port = await freePort()
  const server = serve(port, logsRoot, {
    DEVROUNDS_DATABASE_URL: db.url,
    DEVROUNDS_OFFER_TIMEOUT_S: '600',
    DEVROUNDS_SCHEDULER_POLL_S: '0.2',
  })
  t.after(async () => {
    server.child.kill()
    await rm(logsRoot, { recursive: true, force: true })
  })
  assert.ok(await healthy(port, Date.now() + START_BUDGET_MS), server.stderr())

  // The ticks do expire an offer that runs out while serve is up.
  const late = await offered('1 second')
  const deadline = Date.now() + 30_000
  while ((await row(late)).state === 'offered' && Date.now() < deadline) await sleep(100)
  assert.equal((await row(late)).state, 'stopped', server.stderr())
  assert.deepEqual(await row(leftByCrash), { state: 'offered', rearmed: true })
})
