import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { runCli } from '../cli/commands.ts'
import { DevRoundsError } from '../errors/error.ts'
import { putJobType } from '../job-types/service.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../machines/pairing.ts'
import { revokeMachine } from '../machines/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { putQueue } from '../queues/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { TEST_DATABASE_URL, testDb } from '../test-support/db.ts'
import type { BatchInput } from './batch-file.ts'
import { batchView, enqueueRun, submitBatch } from './enqueue.ts'

const projectKey = 'devrounds'

const notFound = (kind: string) => (err: unknown) =>
  err instanceof DevRoundsError && err.code === 'DR201' && err.data.kind === kind

// A tenant with project `devrounds`, job types `check` and `lint`, and machine `build-01` paired.
async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  for (const key of ['check', 'lint']) {
    await putJobType(ctx, projectKey, { key, command: { program: 'pnpm', args: [key] } })
  }
  const { code } = await createPairingCode(ctx, 'build-01')
  await redeemPairingCode(t.db, new PairingLimiter(), code, { os: 'windows', version: '0.1.0' })
  return { t, tenant, ctx }
}

const DIAMOND: BatchInput = {
  jobs: [
    { ref: 'a', job_type: 'check', cwd: 'C:\\work' },
    { ref: 'b', job_type: 'lint', cwd: 'C:\\work', depends_on: ['a'] },
    { ref: 'c', job_type: 'check', cwd: 'C:\\work', depends_on: ['a'] },
    { ref: 'd', job_type: 'lint', cwd: 'C:\\work', depends_on: ['b', 'c'], machine: 'build-01' },
  ],
}

test('a batch creates one queued run per job, attempt 1, cause first, in the default queue, and the dependency edges', async () => {
  const { t, ctx } = await setup()
  const batch = await submitBatch(ctx, projectKey, DIAMOND)
  assert.deepEqual(
    batch.jobs.map((j) => [j.ref, j.jobType, j.state]),
    [
      ['a', 'check', 'open'],
      ['b', 'lint', 'open'],
      ['c', 'check', 'open'],
      ['d', 'lint', 'open'],
    ],
  )
  assert.deepEqual(await batchView(ctx, projectKey, batch.id), batch)

  const runs = await t.admin
    .selectFrom('runs as r')
    .innerJoin('jobs as j', 'j.id', 'r.job_id')
    .innerJoin('queues as q', 'q.id', 'j.queue_id')
    .leftJoin('machines as m', 'm.id', 'j.machine_id')
    .select(['j.ref', 'r.id', 'r.state', 'r.attempt', 'r.cause', 'r.machine_id', 'q.key as queue', 'm.name as pin'])
    .where('j.batch_id', '=', batch.id)
    .orderBy('j.ref')
    .execute()
  assert.deepEqual(
    runs.map((r) => [r.ref, r.state, r.attempt, r.cause, r.machine_id, r.queue, r.pin]),
    [
      ['a', 'queued', 1, 'first', null, 'default', null],
      ['b', 'queued', 1, 'first', null, 'default', null],
      ['c', 'queued', 1, 'first', null, 'default', null],
      ['d', 'queued', 1, 'first', null, 'default', 'build-01'],
    ],
  )
  assert.deepEqual(
    runs.map((r) => r.id),
    batch.jobs.map((j) => j.runId),
  )

  const edges = await t.admin
    .selectFrom('job_dependencies as e')
    .innerJoin('jobs as j', 'j.id', 'e.job_id')
    .innerJoin('jobs as d', 'd.id', 'e.depends_on_job_id')
    .select(['j.ref as job', 'd.ref as dependsOn'])
    .where('j.batch_id', '=', batch.id)
    .orderBy(['j.ref', 'd.ref'])
    .execute()
  assert.deepEqual(
    edges.map((e) => `${e.job}→${e.dependsOn}`),
    ['b→a', 'c→a', 'd→b', 'd→c'],
  )
})

test('a batch with a cycle inserts nothing', async () => {
  const { t, tenant, ctx } = await setup()
  const cyclic: BatchInput = {
    jobs: [
      { ref: 'a', job_type: 'check', cwd: 'C:\\work', depends_on: ['b'] },
      { ref: 'b', job_type: 'check', cwd: 'C:\\work', depends_on: ['a'] },
    ],
  }
  await assert.rejects(
    submitBatch(ctx, projectKey, cyclic),
    (err: unknown) => err instanceof DevRoundsError && err.code === 'DR152' && err.data.cycle === 'a → b → a',
  )
  for (const table of ['job_batches', 'jobs', 'runs', 'job_dependencies', 'queues'] as const) {
    const rows = await t.admin.selectFrom(table).select('tenant_id').where('tenant_id', '=', tenant.tenantId).execute()
    assert.equal(rows.length, 0, table)
  }
})

test('a job type not listed by the queue answers DR153', async () => {
  const { ctx } = await setup()
  await putQueue(ctx, projectKey, { key: 'fast', jobTypes: ['lint'] })
  await assert.rejects(
    submitBatch(ctx, projectKey, { jobs: [{ ref: 'a', job_type: 'check', cwd: 'C:\\work', queue: 'fast' }] }),
    (err: unknown) =>
      err instanceof DevRoundsError &&
      err.code === 'DR153' &&
      err.data.jobType === 'check' &&
      err.data.queue === 'fast',
  )
  // The listed job type is accepted on that queue.
  const view = await enqueueRun(ctx, { projectKey, jobTypeKey: 'lint', cwd: 'C:\\work', queueKey: 'fast' })
  assert.equal(view.queue, 'fast')
})

test('an unknown queue answers DR201 kind queue', async () => {
  const { ctx } = await setup()
  await assert.rejects(
    enqueueRun(ctx, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work', queueKey: 'nightly' }),
    notFound('queue'),
  )
})

test('a pinned machine that is revoked answers DR201 kind machine', async () => {
  const { ctx } = await setup()
  await revokeMachine(ctx, 'build-01')
  await assert.rejects(
    submitBatch(ctx, projectKey, { jobs: [{ ref: 'a', job_type: 'check', cwd: 'C:\\work', machine: 'build-01' }] }),
    notFound('machine'),
  )
})

test('a batch of another tenant is not found (DR201)', async () => {
  const { ctx } = await setup()
  const other = await setup()
  const batch = await submitBatch(ctx, projectKey, DIAMOND)
  await assert.rejects(batchView(other.ctx, projectKey, batch.id), notFound('batch'))
  await assert.rejects(batchView(ctx, projectKey, 'not-a-uuid'), notFound('batch'))
})

test('enqueue notifies devrounds_scheduler with the tenant id after commit', async () => {
  const { t, tenant, ctx } = await setup()
  const listener = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await listener.connect()
  try {
    const payloads: string[] = []
    listener.on('notification', (n) => {
      if (n.channel === 'devrounds_scheduler' && n.payload === tenant.tenantId) payloads.push(n.payload)
    })
    await listener.query('listen devrounds_scheduler')
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let enqueued: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      enqueued = resolve
    })
    // The transaction stays open after the enqueue until the test releases it.
    const committed = withTenant(t.db, tenant.tenantId, async (trx) => {
      const view = await enqueueRun({ ...ctx, trx }, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work' })
      assert.equal(view.state, 'queued')
      assert.equal(view.machine, null)
      assert.equal(view.cause, 'first')
      enqueued()
      await held
    })
    await ready
    await sleep(200)
    assert.deepEqual(payloads, [], 'nothing is delivered before the commit')
    release()
    await committed
    const deadline = Date.now() + 5000
    while (payloads.length === 0 && Date.now() < deadline) await sleep(20)
    assert.deepEqual(payloads, [tenant.tenantId])
  } finally {
    await listener.end()
  }
})

test('queue set, batch submit and batch show through the CLI and the API', async () => {
  const { t, tenant } = await setup()
  const app = buildServer({ db: t.db, logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const scratchRoot = join(fileURLToPath(new URL('../../../', import.meta.url)), '.superpowers', 'tmp')
  await mkdir(scratchRoot, { recursive: true })
  const scratch = await mkdtemp(join(scratchRoot, 'batch-'))
  try {
    const env = {
      DEVROUNDS_URL: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
      DEVROUNDS_TOKEN: await createToken(t.admin, tenant.tenantId, 'human', 'human'),
      DEVROUNDS_PROJECT: projectKey,
    }
    const cli = (...argv: string[]) => runCli(argv, { env, configPath: join(scratch, 'config.json') })

    const set = await cli(
      'queue',
      'set',
      'fast',
      '--priority',
      '-1',
      '--concurrency',
      '2',
      '--job-types',
      'check, lint',
    )
    assert.equal(set.exitCode, 0, set.stderr)
    assert.match(set.stdout, /^fast {2}priority -1 · concurrency 2 · job types check, lint · depth 0 /)
    const cleared = await cli('queue', 'set', 'fast', '--concurrency', 'none', '--job-types', 'none')
    assert.match(cleared.stdout, /^fast {2}priority -1 · concurrency none · job types any · /)

    const file = join(scratch, 'batch.yaml')
    await writeFile(
      file,
      'jobs:\n  - { ref: a, job_type: check, cwd: C:/w, queue: fast }\n  - { ref: b, job_type: lint, cwd: C:/w, depends_on: [a] }\n',
    )
    const submitted = await cli('batch', 'submit', file)
    assert.equal(submitted.exitCode, 0, submitted.stderr)
    const lines = submitted.stdout.trimEnd().split('\n')
    assert.match(lines[0], /^a {2}open · check · run [0-9a-f-]{36}$/)
    assert.match(lines[1], /^b {2}open · lint · run [0-9a-f-]{36}$/)
    const id = /^next: devrounds batch show ([0-9a-f-]{36})$/.exec(lines[2])?.[1] as string
    assert.ok(id, submitted.stdout)

    // A failed job prints before the rest, and the next step reads its run.
    await t.admin
      .updateTable('jobs')
      .set({ state: 'failed' })
      .where('batch_id', '=', id)
      .where('ref', '=', 'b')
      .execute()
    const shown = await cli('batch', 'show', id)
    const shownLines = shown.stdout.trimEnd().split('\n')
    assert.match(shownLines[0], /^b {2}failed · lint · run /)
    assert.equal(shownLines[1], `batch ${id} · 2 jobs`)
    assert.match(shownLines[2], /^a {2}open · check/)
    assert.match(shownLines[3], /^next: devrounds run show [0-9a-f-]{36}$/)

    const list = await cli('queue', 'list')
    assert.match(list.stdout, /^fast {2}priority -1 · .* · depth 1 · in flight 0 · /m)
    assert.match(list.stdout, /^default {2}priority 0 · .* · depth 1 · in flight 0 · /m)

    const bad = await cli('batch', 'submit', file.replace('batch.yaml', 'missing.yaml'))
    assert.equal(bad.exitCode, 2, bad.stderr)
  } finally {
    await app.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
