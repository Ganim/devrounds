import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { runCli } from '../cli/commands.ts'
import type { DevRoundsError } from '../errors/error.ts'
import { putJobType } from '../job-types/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { type TestDb, testDb } from '../test-support/db.ts'
import { type LogCtx, pruneLogSegments, readRunLog, type SegmentInput, segmentFile, storeSegment } from './log-store.ts'
import { createRun } from './record.ts'
import { runView } from './view.ts'

const projectKey = 'devrounds'
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DAY = 24 * 60 * 60 * 1000

let t: TestDb
let scratch: string
let app: ReturnType<typeof buildServer>
let host: string

before(async () => {
  t = await testDb()
  await mkdir(join(REPO_ROOT, '.superpowers', 'tmp'), { recursive: true })
  scratch = await mkdtemp(join(REPO_ROOT, '.superpowers', 'tmp', 'log-store-'))
  app = buildServer({ db: t.db, logger: false, logsRoot: join(scratch, 'logs') })
  await app.listen({ port: 0, host: '127.0.0.1' })
  host = `127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

after(async () => {
  await app.close()
  await rm(scratch, { recursive: true, force: true })
})

// A tenant with one run of job type `check` on machine `build-01`.
async function setup() {
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  const machineId = await withTenant(t.db, tenant.tenantId, async (trx) => {
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
  await putJobType(ctx, projectKey, {
    key: 'check',
    command: { program: 'pnpm', args: ['check'] },
    env: ['PATH'],
    timeout_s: 600,
  })
  const run = await createRun(ctx, { projectKey, jobTypeKey: 'check', machineName: 'build-01', cwd: 'C:\\work' })
  const logCtx: LogCtx = { db: t.db, tenantId: tenant.tenantId, logsRoot: join(scratch, 'logs') }
  return { tenant, ctx, logCtx, machineId, runId: run.id }
}

// Lines `from`..`to` as the executor ships them: zstd JSON lines of devrounds-logs' LogLine.
function segment(from: number, to: number, text = (seq: number) => `line ${seq}`): SegmentInput {
  const lines = []
  for (let seq = from; seq <= to; seq++) {
    lines.push(JSON.stringify({ run: 'r', seq, timestamp_ms: 1_700_000_000_000 + seq, text: text(seq), level: null }))
  }
  const compressed = zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`))
  return { first_seq: from, last_seq: to, records: to - from + 1, zstd_base64: compressed.toString('base64') }
}

async function segmentRows(runId: string) {
  return t.admin
    .selectFrom('log_segments')
    .select(['id', 'first_seq', 'path'])
    .where('run_id', '=', runId)
    .orderBy('first_seq')
    .execute()
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const fileOf = (ctx: LogCtx, runId: string, firstSeq: string | number) =>
  segmentFile(ctx.logsRoot, ctx.tenantId, runId, Number(firstSeq))

type Warning = { data: Record<string, unknown>; message: string }
function warnings() {
  const seen: Warning[] = []
  return { seen, log: { warn: (data: Record<string, unknown>, message: string) => seen.push({ data, message }) } }
}

test('segment files are found under the logs root they are read from, not a stored absolute path', async () => {
  const { logCtx, runId, machineId } = await setup()
  await storeSegment(logCtx, runId, segment(1, 3), { machineId })
  await storeSegment(logCtx, runId, segment(4, 6), { machineId })
  for (const row of await segmentRows(runId)) assert.equal(isAbsolute(row.path), false, row.path)

  // The logs root moved (a new disk, a renamed home): the rows still find their files.
  const moved: LogCtx = { ...logCtx, logsRoot: join(scratch, `moved-${runId}`) }
  await mkdir(join(moved.logsRoot, 'runs'), { recursive: true })
  await rename(join(logCtx.logsRoot, 'runs', logCtx.tenantId), join(moved.logsRoot, 'runs', logCtx.tenantId))
  const read = await readRunLog(moved, runId, { maxBytes: 16384 })
  assert.deepEqual(
    read.lines.map((line) => line.seq),
    [1, 2, 3, 4, 5, 6],
  )

  await t.admin
    .updateTable('log_segments')
    .set({ created_at: new Date(0) })
    .where('run_id', '=', runId)
    .execute()
  await pruneLogSegments(t.db, moved.logsRoot, new Date(), 14)
  assert.equal(await exists(fileOf(moved, runId, 1)), false)
  assert.equal(await exists(fileOf(moved, runId, 4)), false)
})

test('a missing segment file is skipped with a warning naming it', async () => {
  const { logCtx, runId, machineId } = await setup()
  await storeSegment(logCtx, runId, segment(1, 3), { machineId })
  await storeSegment(logCtx, runId, segment(4, 6), { machineId })
  await rm(fileOf(logCtx, runId, 1))

  const { seen, log } = warnings()
  const read = await readRunLog(logCtx, runId, { maxBytes: 16384, log })
  assert.deepEqual(
    read.lines.map((line) => line.seq),
    [4, 5, 6],
  )
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].data, { run: runId, firstSeq: 1, lastSeq: 3 })
})

test('a segment that decompresses past the read bound is DR503 naming the cursor past it', async () => {
  const { logCtx, runId, machineId } = await setup()
  // A few KiB on the wire, 17 MiB once decompressed.
  const bomb = segment(1, 1, () => 'a'.repeat(17 * 1024 * 1024))
  assert.ok(bomb.zstd_base64.length < 64 * 1024, `${bomb.zstd_base64.length}`)
  await storeSegment(logCtx, runId, bomb, { machineId })
  await storeSegment(logCtx, runId, segment(2, 3), { machineId })

  await assert.rejects(readRunLog(logCtx, runId, { maxBytes: 16384 }), (err: DevRoundsError) => {
    assert.equal(err.code, 'DR503')
    assert.equal(err.data.next, 2)
    return true
  })
  // Reading on from the cursor it names skips only that segment.
  const read = await readRunLog(logCtx, runId, { cursor: 2n, maxBytes: 16384 })
  assert.deepEqual(
    read.lines.map((line) => line.seq),
    [2, 3],
  )
})

test('a stored segment reads back by cursor', async () => {
  const { logCtx, runId, machineId } = await setup()
  await storeSegment(logCtx, runId, segment(1, 3), { machineId })
  await storeSegment(logCtx, runId, segment(4, 6), { machineId })

  const all = await readRunLog(logCtx, runId, { maxBytes: 16384 })
  assert.deepEqual(
    all.lines.map((line) => [line.seq, line.text]),
    [1, 2, 3, 4, 5, 6].map((seq) => [seq, `line ${seq}`]),
  )
  assert.equal(all.nextCursor, null)

  // A cursor inside a segment starts at that line.
  const rest = await readRunLog(logCtx, runId, { cursor: 3n, maxBytes: 16384 })
  assert.deepEqual(
    rest.lines.map((line) => line.seq),
    [3, 4, 5, 6],
  )

  // A small budget cuts at a whole line and names the first line it left out.
  const first = await readRunLog(logCtx, runId, { maxBytes: 14 })
  assert.deepEqual(
    first.lines.map((line) => line.seq),
    [1, 2],
  )
  assert.equal(first.nextCursor, 3n)

  const view = await runView(logCtx, runId)
  assert.equal(view.outcome.logCursor, 6)
  for (const row of await segmentRows(runId)) {
    assert.ok(await exists(fileOf(logCtx, runId, row.first_seq)), row.first_seq)
  }
})

test('a duplicate segment is ignored', async () => {
  const { logCtx, runId, machineId } = await setup()
  await storeSegment(logCtx, runId, segment(1, 3), { machineId })
  // Resent after a lost Ack; even different bytes must not replace what was stored.
  await storeSegment(
    logCtx,
    runId,
    segment(1, 3, (seq) => `other ${seq}`),
    { machineId },
  )

  assert.equal((await segmentRows(runId)).length, 1)
  const read = await readRunLog(logCtx, runId, { maxBytes: 16384 })
  assert.deepEqual(
    read.lines.map((line) => line.text),
    ['line 1', 'line 2', 'line 3'],
  )
})

test('segments older than the retention are pruned with their files', async () => {
  const { logCtx, runId, machineId } = await setup()
  await storeSegment(logCtx, runId, segment(1, 3), { machineId })
  await storeSegment(logCtx, runId, segment(4, 6), { machineId })
  const [old, fresh] = await segmentRows(runId)
  const now = new Date()
  await t.admin
    .updateTable('log_segments')
    .set({ created_at: new Date(now.getTime() - 15 * DAY) })
    .where('id', '=', old.id)
    .execute()

  const pruned = await pruneLogSegments(t.db, logCtx.logsRoot, now, 14)

  assert.ok(pruned >= 1, `pruned ${pruned}`)
  assert.deepEqual(
    (await segmentRows(runId)).map((row) => row.id),
    [fresh.id],
  )
  assert.equal(await exists(fileOf(logCtx, runId, old.first_seq)), false)
  assert.equal(await exists(fileOf(logCtx, runId, fresh.first_seq)), true)
  const read = await readRunLog(logCtx, runId, { maxBytes: 16384 })
  assert.deepEqual(
    read.lines.map((line) => line.seq),
    [4, 5, 6],
  )
})

test('lines read before an unreadable segment are returned first, and its DR503 comes on the next page', async () => {
  const { logCtx, runId, machineId } = await setup()
  await storeSegment(logCtx, runId, segment(1, 3), { machineId })
  const bomb = segment(4, 6, () => 'a'.repeat(17 * 1024 * 1024))
  await storeSegment(logCtx, runId, bomb, { machineId })
  await storeSegment(logCtx, runId, segment(7, 8), { machineId })

  const first = await readRunLog(logCtx, runId, { maxBytes: 16384 })
  assert.deepEqual(
    first.lines.map((line) => line.seq),
    [1, 2, 3],
  )
  assert.equal(first.nextCursor, 4n)
  await assert.rejects(readRunLog(logCtx, runId, { cursor: 4n, maxBytes: 16384 }), (err: DevRoundsError) => {
    assert.equal(err.code, 'DR503')
    assert.equal(err.data.next, 7)
    return true
  })
})

test('run logs pages at 16384 bytes with an exact --cursor continuation', async () => {
  const { tenant, logCtx, runId, machineId } = await setup()
  // About 120 KB over three segments: several pages, cut inside segments.
  const text = (seq: number) => `line ${seq} ${'x'.repeat(90)}`
  for (const [from, to] of [
    [1, 400],
    [401, 800],
    [801, 1200],
  ]) {
    await storeSegment(logCtx, runId, segment(from, to, text), { machineId })
  }
  const token = await createToken(t.admin, tenant.tenantId, 'human', 'human')
  const env = { DEVROUNDS_URL: `http://${host}`, DEVROUNDS_TOKEN: token, DEVROUNDS_PROJECT: projectKey }
  const deps = { env, configPath: join(scratch, 'config.json') }

  const seen: string[] = []
  let args = ['run', 'logs', runId]
  let pages = 0
  for (;;) {
    const out = await runCli(args, deps)
    assert.equal(out.exitCode, 0, out.stderr)
    pages += 1
    const lines = out.stdout.trimEnd().split('\n')
    assert.equal(lines.at(-1), `next: devrounds run show ${runId}`)
    const more = lines.at(-2)?.match(/^truncated; more: devrounds run logs (\S+) --cursor (\d+)$/)
    const body = lines.slice(0, more ? -2 : -1)
    const bytes = body.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    assert.ok(bytes <= 16384, `page ${pages} has ${bytes} bytes`)
    // The cursor continues exactly after the last line printed.
    if (more) assert.equal(Number(more[2]), seen.length + body.length + 1)
    seen.push(...body)
    if (!more) break
    args = ['run', 'logs', more[1], '--cursor', more[2]]
  }

  assert.ok(pages >= 7, `${pages} pages`)
  assert.deepEqual(
    seen,
    Array.from({ length: 1200 }, (_, i) => text(i + 1)),
  )
})
