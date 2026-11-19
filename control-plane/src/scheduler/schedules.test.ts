import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { runCli } from '../cli/commands.ts'
import { DevRoundsError } from '../errors/error.ts'
import { Sessions } from '../executor/gateway.ts'
import { putJobType } from '../job-types/service.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import { revokeMachine } from '../machines/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { type IsolatedTestDb, isolatedTestDb, TEST_APP_ROLE } from '../test-support/db.ts'
import { Scheduler } from './scheduler.ts'
import { fireDueSchedules, listSchedules, nextDue, putSchedule } from './schedules.ts'

// due_schedules reads every tenant: in the shared test database the scheduler of another test file would fire these
// schedules first, so this file has a database of its own.
let t: IsolatedTestDb

before(async () => {
  t = await isolatedTestDb('schedules')
})

const projectKey = 'devrounds'
const log = { warn: () => {}, error: () => {} }
const HOUR = 3_600_000

// A tenant with project `devrounds` and job type `check`.
async function setup() {
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await putJobType(ctx, projectKey, { key: 'check', command: { program: 'pnpm', args: ['check'] } })
  const put = (key: string, i: Partial<Parameters<typeof putSchedule>[2]> = {}) =>
    putSchedule(ctx, projectKey, { key, jobType: 'check', cwd: 'C:\\work', everyS: 3600, ...i })
  // Moves the schedule's clock, as time passing would.
  const dueAt = (key: string, at: Date) =>
    t.admin
      .updateTable('schedules')
      .set({ next_due_at: at })
      .where('key', '=', key)
      .where('tenant_id', '=', tenant.tenantId)
      .execute()
  const row = (key: string) =>
    t.admin
      .selectFrom('schedules')
      .selectAll()
      .where('key', '=', key)
      .where('tenant_id', '=', tenant.tenantId)
      .executeTakeFirstOrThrow()
  const jobsOf = (key: string) =>
    t.admin
      .selectFrom('jobs as j')
      .innerJoin('schedules as s', 's.id', 'j.schedule_id')
      .select(['j.id', 'j.state', 'j.created_by', 'j.cwd'])
      .where('s.key', '=', key)
      .where('s.tenant_id', '=', tenant.tenantId)
      .execute()
  return { tenant, ctx, put, dueAt, row, jobsOf }
}

const invalid = (path: string) => (err: unknown) =>
  err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === path

test('due_schedules is security definer, executable by the app role only', async () => {
  const fn = 'due_schedules(timestamptz)'
  const { rows } = await sql<{ pub: boolean; app: boolean; definer: boolean; config: string[] }>`
    select has_function_privilege('public', ${fn}, 'execute') as pub,
      has_function_privilege(${TEST_APP_ROLE}, ${fn}, 'execute') as app,
      p.prosecdef as definer, p.proconfig as config
    from pg_proc p where p.oid = ${fn}::regprocedure`.execute(t.admin)
  assert.deepEqual(rows, [
    { pub: false, app: true, definer: true, config: ['search_path=pg_catalog, public, pg_temp'] },
  ])
})

test('a due schedule enqueues one job and moves next_due_at', async () => {
  const s = await setup()
  await s.put('nightly')
  const now = new Date()
  await s.dueAt('nightly', new Date(now.getTime() - 1000))

  assert.equal(await fireDueSchedules(t.db, now, log), 1)

  const [job, ...more] = await s.jobsOf('nightly')
  assert.deepEqual(more, [])
  assert.deepEqual([job.state, job.created_by, job.cwd], ['open', s.tenant.human.id, 'C:\\work'])
  const runs = await t.admin.selectFrom('runs').select(['state', 'attempt']).where('job_id', '=', job.id).execute()
  assert.deepEqual(runs, [{ state: 'queued', attempt: 1 }])
  const schedule = await s.row('nightly')
  assert.equal(schedule.last_job_id, job.id)
  assert.equal(schedule.next_due_at.getTime(), now.getTime() + HOUR)
  // Not due again until then.
  assert.equal(await fireDueSchedules(t.db, now, log), 0)
})

test('daily 06:00 in America/Sao_Paulo is due at 09:00Z', async () => {
  const at = (iso: string) =>
    t.admin
      .transaction()
      .execute((trx) => nextDue(trx, { every_s: null, daily_at: '06:00' }, new Date(iso), 'America/Sao_Paulo'))
  assert.equal((await at('2026-11-19T00:00:00Z')).toISOString(), '2026-11-19T09:00:00.000Z')
  // At and after the time of day it is already tomorrow's.
  assert.equal((await at('2026-11-19T09:00:00Z')).toISOString(), '2026-11-20T09:00:00.000Z')
  assert.equal((await at('2026-11-19T15:00:00Z')).toISOString(), '2026-11-20T09:00:00.000Z')

  const s = await setup()
  const view = await s.put('morning', { everyS: undefined, dailyAt: '06:00' })
  assert.equal(view.dailyAt, '06:00')
  assert.equal(new Date(view.nextDueAt).getUTCHours(), 9)
})

test('a fire is skipped while the previous job is open', async () => {
  const s = await setup()
  await s.put('nightly')
  const now = new Date()
  await s.dueAt('nightly', new Date(now.getTime() - 1000))
  assert.equal(await fireDueSchedules(t.db, now, log), 1)

  const later = new Date(now.getTime() + 2 * HOUR)
  assert.equal(await fireDueSchedules(t.db, later, log), 0)
  assert.equal((await s.jobsOf('nightly')).length, 1)
  // The skipped fire still moved the clock, so it does not retry on every tick.
  assert.equal((await s.row('nightly')).next_due_at.getTime(), later.getTime() + HOUR)

  const { last_job_id } = await s.row('nightly')
  await t.admin
    .updateTable('jobs')
    .set({ state: 'finished' })
    .where('id', '=', last_job_id as string)
    .execute()
  assert.equal(await fireDueSchedules(t.db, new Date(later.getTime() + 2 * HOUR), log), 1)
  assert.equal((await s.jobsOf('nightly')).length, 2)
})

test('a schedule missed twice while serve was down fires once', async () => {
  const s = await setup()
  await s.put('daily', { everyS: 86_400 })
  const now = new Date()
  await s.dueAt('daily', new Date(now.getTime() - 2 * 86_400_000 - 1000))

  assert.equal(await fireDueSchedules(t.db, now, log), 1)
  assert.equal(await fireDueSchedules(t.db, now, log), 0)
  assert.equal((await s.jobsOf('daily')).length, 1)
  assert.equal((await s.row('daily')).next_due_at.getTime(), now.getTime() + 86_400_000)
})

test('two ticks at once fire a due schedule once', async () => {
  const s = await setup()
  await s.put('nightly')
  const now = new Date()
  await s.dueAt('nightly', new Date(now.getTime() - 1000))

  const fired = await Promise.all([fireDueSchedules(t.db, now, log), fireDueSchedules(t.db, now, log)])

  assert.equal(fired[0] + fired[1], 1)
  assert.equal((await s.jobsOf('nightly')).length, 1)
})

test('a disabled schedule never fires', async () => {
  const s = await setup()
  await s.put('nightly', { enabled: false })
  await s.dueAt('nightly', new Date(Date.now() - 1000))
  assert.equal(await fireDueSchedules(t.db, new Date(), log), 0)
  assert.deepEqual(await s.jobsOf('nightly'), [])
})

test('every below 60 s answers DR101 at /everyS', async () => {
  const s = await setup()
  await assert.rejects(s.put('fast', { everyS: 59 }), invalid('/everyS'))
})

test('--daily 25:00 answers DR101', async () => {
  const s = await setup()
  await assert.rejects(s.put('late', { everyS: undefined, dailyAt: '25:00' }), invalid('/dailyAt'))
})

test('exactly one of everyS and dailyAt is required', async () => {
  const s = await setup()
  await assert.rejects(s.put('both', { dailyAt: '06:00' }), invalid('/everyS'))
  await assert.rejects(s.put('none', { everyS: undefined }), invalid('/everyS'))
})

test('putSchedule changes a schedule in place; listSchedules shows it with its last job', async () => {
  const s = await setup()
  const first = await s.put('nightly')
  assert.equal(first.lastJob, null)
  await s.dueAt('nightly', new Date(Date.now() - 1000))
  await fireDueSchedules(t.db, new Date(), log)

  const changed = await s.put('nightly', { everyS: 7200, enabled: false })
  const [listed, ...more] = await listSchedules(s.ctx, projectKey)
  assert.deepEqual(more, [])
  assert.deepEqual(listed, changed)
  assert.deepEqual([listed.every, listed.enabled, listed.lastJob?.state], [7200, false, 'open'])
  await assert.rejects(
    putSchedule(s.ctx, projectKey, { key: 'x', jobType: 'nope', cwd: 'C:\\work', everyS: 60 }),
    (err: unknown) => err instanceof DevRoundsError && err.code === 'DR201' && err.data.kind === 'job type',
  )
})

test('the scheduler tick fires due schedules', async () => {
  const s = await setup()
  await s.put('nightly')
  await s.dueAt('nightly', new Date(Date.now() - 1000))
  const scheduler = new Scheduler({
    db: t.db,
    sessions: new Sessions(),
    offerTimeoutS: 120,
    pollMs: 600_000,
    telemetry: null,
    log,
  })
  await scheduler.tick()
  assert.equal((await s.jobsOf('nightly')).length, 1)
})

test('schedule set and list over the API show the next fire in the tenant time zone', async () => {
  const s = await setup()
  const app = buildServer({ db: t.db, logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const scratchRoot = join(fileURLToPath(new URL('../../../', import.meta.url)), '.superpowers', 'tmp')
  await mkdir(scratchRoot, { recursive: true })
  const scratch = await mkdtemp(join(scratchRoot, 'schedule-'))
  try {
    const env = {
      DEVROUNDS_URL: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
      DEVROUNDS_TOKEN: await createToken(t.admin, s.tenant.tenantId, 'human', 'human'),
      DEVROUNDS_PROJECT: projectKey,
    }
    const cli = (...argv: string[]) => runCli(argv, { env, configPath: join(scratch, 'config.json') })

    const set = await cli('schedule', 'set', 'morning', '--job-type', 'check', '--cwd', 'C:/w', '--daily', '06:00')
    assert.equal(set.exitCode, 0, set.stderr)
    assert.match(
      set.stdout,
      /^morning {2}check · daily 06:00 · next due \d{4}-\d\d-\d\d 06:00 America\/Sao_Paulo · last job none/,
    )
    const off = await cli(
      'schedule',
      'set',
      'weekly',
      '--job-type',
      'check',
      '--cwd',
      'C:/w',
      '--every',
      '604800',
      '--disable',
    )
    assert.match(off.stdout, /^weekly {2}check · every 604800 s · disabled/)
    const listed = await cli('schedule', 'list')
    assert.equal(listed.stdout.trimEnd().split('\n').length, 3, listed.stdout)
    const bad = await cli('schedule', 'set', 'late', '--job-type', 'check', '--cwd', 'C:/w', '--daily', '25:00')
    assert.equal(bad.exitCode, 2, bad.stdout)
    assert.match(bad.stderr + bad.stdout, /DR101.*\/dailyAt/)
  } finally {
    await app.close()
    await rm(scratch, { recursive: true, force: true })
  }
})

test('a daily schedule missed twice while serve was down fires once', async () => {
  const s = await setup()
  await s.put('morning', { everyS: undefined, dailyAt: '06:00' })
  const now = new Date()
  await s.dueAt('morning', new Date(now.getTime() - 2 * 86_400_000 - 1000))

  assert.equal(await fireDueSchedules(t.db, now, log), 1)
  assert.equal(await fireDueSchedules(t.db, now, log), 0)
  assert.equal((await s.jobsOf('morning')).length, 1)
  const next = (await s.row('morning')).next_due_at
  assert.ok(next > now && next.getTime() - now.getTime() <= 86_400_000 + HOUR, next.toISOString())
})

test('saving the same schedule again keeps next_due_at; changing its timing restarts it', async () => {
  const s = await setup()
  await s.put('nightly', { everyS: 86_400 })
  const before = (await s.row('nightly')).next_due_at
  await s.put('nightly', { everyS: 86_400 })
  assert.equal((await s.row('nightly')).next_due_at.getTime(), before.getTime())

  await s.put('morning', { everyS: undefined, dailyAt: '06:00' })
  const daily = (await s.row('morning')).next_due_at
  await s.put('morning', { everyS: undefined, dailyAt: '06:00' })
  assert.equal((await s.row('morning')).next_due_at.getTime(), daily.getTime())

  await s.put('nightly', { everyS: 3600 })
  assert.notEqual((await s.row('nightly')).next_due_at.getTime(), before.getTime())
})

test('a schedule pinned to a revoked machine makes no job and moves its clock', async () => {
  const s = await setup()
  const { code } = await createPairingCode(s.ctx, 'build-01')
  await redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' })
  await s.put('pinned', { machine: 'build-01' })
  await revokeMachine(s.ctx, 'build-01')
  const now = new Date()
  await s.dueAt('pinned', new Date(now.getTime() - 1000))
  const warnings: object[] = []

  assert.equal(await fireDueSchedules(t.db, now, { warn: (data) => warnings.push(data), error: () => {} }), 0)

  assert.deepEqual(await s.jobsOf('pinned'), [])
  assert.equal((await s.row('pinned')).next_due_at.getTime(), now.getTime() + HOUR)
  assert.equal(warnings.length, 1)
  assert.match(JSON.stringify(warnings[0]), /machine/)
})
