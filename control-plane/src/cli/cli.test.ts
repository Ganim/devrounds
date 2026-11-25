import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { pruneIdempotencyKeys } from '../api/idempotency.ts'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { decide, propose } from '../conventions/service.ts'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun } from '../jobs/enqueue.ts'
import { addTask, createProject } from '../planning/service.ts'
import { testDb } from '../test-support/db.ts'
import { removeDir } from '../test-support/remove-dir.ts'
import { moreCommandFor, runCli } from './commands.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
const SCRATCH = join(fileURLToPath(new URL('../../../', import.meta.url)), '.superpowers', 'tmp')

async function scratch(prefix: string): Promise<string> {
  await mkdir(SCRATCH, { recursive: true })
  return mkdtemp(join(SCRATCH, prefix))
}

let app: ReturnType<typeof buildServer>
let url: string

before(async () => {
  app = buildServer({ db: (await testDb()).db, logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

after(() => app.close())

// Runs the real bin in its own process, the way an agent calls it.
function cli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code) : 0, out: `${stdout}${stderr}` })
    })
  })
}

test('exit code 3 for a project of another tenant', async () => {
  const t = await testDb()
  const mine = await t.newTenant()
  await createProject({ db: t.db, tenantId: mine.tenantId, actor: mine.human }, { key: 'alpha', name: 'Alpha' })
  const other = await t.newTenant()
  await createProject({ db: t.db, tenantId: other.tenantId, actor: other.human }, { key: 'beta', name: 'Beta' })
  const token = await createToken(t.admin, mine.tenantId, 'human', 'human')

  const env = { DEVROUNDS_URL: url, DEVROUNDS_TOKEN: token }
  const own = await cli(['plan', 'show'], { ...env, DEVROUNDS_PROJECT: 'alpha' })
  assert.equal(own.code, 0, own.out)

  const res = await cli(['plan', 'show'], { ...env, DEVROUNDS_PROJECT: 'beta' })
  assert.equal(res.code, 3, res.out)
  assert.match(res.out, /^DR201 No project beta found\.\nhint: /)
  // The configured project is wrong, so the way out is a new login; the token is never echoed.
  assert.ok(res.out.endsWith('\nnext: devrounds login --url <url> --token <token> --project <key>\n'), res.out)
  assert.ok(!res.out.includes(token))
})

test("--project beta reads beta's plan with a config for alpha", async () => {
  const t = await testDb()
  const mine = await t.newTenant()
  await createProject({ db: t.db, tenantId: mine.tenantId, actor: mine.human }, { key: 'alpha', name: 'Alpha' })
  await createProject({ db: t.db, tenantId: mine.tenantId, actor: mine.human }, { key: 'beta', name: 'Beta' })
  const token = await createToken(t.admin, mine.tenantId, 'human', 'human')

  const env = { DEVROUNDS_URL: url, DEVROUNDS_TOKEN: token, DEVROUNDS_PROJECT: 'alpha' }
  const res = await cli(['plan', 'show', '--project', 'beta'], env)
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /beta/)
  assert.doesNotMatch(res.out, /alpha/)
})

test("--project of another tenant's key exits 3 with the login next step", async () => {
  const t = await testDb()
  const mine = await t.newTenant()
  await createProject({ db: t.db, tenantId: mine.tenantId, actor: mine.human }, { key: 'alpha', name: 'Alpha' })
  const other = await t.newTenant()
  await createProject({ db: t.db, tenantId: other.tenantId, actor: other.human }, { key: 'gamma', name: 'Gamma' })
  const token = await createToken(t.admin, mine.tenantId, 'human', 'human')

  const res = await cli(['plan', 'show', '--project', 'gamma'], {
    DEVROUNDS_URL: url,
    DEVROUNDS_TOKEN: token,
    DEVROUNDS_PROJECT: 'alpha',
  })
  assert.equal(res.code, 3, res.out)
  assert.match(res.out, /^DR201 No project gamma found\./)
  assert.ok(res.out.endsWith('\nnext: devrounds login --url <url> --token <token> --project <key>\n'), res.out)
})

test('exit code 4 when the control plane is unreachable', async () => {
  // A port that was just free: nothing listens there any more.
  const probe = buildServer({ db: (await testDb()).db, logger: false })
  await probe.listen({ port: 0, host: '127.0.0.1' })
  const closed = `http://127.0.0.1:${(probe.server.address() as AddressInfo).port}`
  await probe.close()

  const res = await cli(['plan', 'show'], { DEVROUNDS_URL: closed, DEVROUNDS_TOKEN: 'x', DEVROUNDS_PROJECT: 'alpha' })
  assert.equal(res.code, 4, res.out)
  assert.ok(res.out.startsWith(`control plane unreachable at ${closed}`), res.out)
})

// A stand-in control plane for answers the real one would need thousands of rows (or a hang) to produce.
async function fakeServer(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    env: { DEVROUNDS_URL: base, DEVROUNDS_TOKEN: 'drt_x', DEVROUNDS_PROJECT: 'alpha' },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const json = (res: ServerResponse, body: unknown) =>
  res.setHeader('content-type', 'application/json').end(JSON.stringify(body))
const NO_CONFIG = join(SCRATCH, 'devrounds-no-such-dir', 'config.json')

test('events cut by the budget: next continues after the last event shown, more pages the same command', async (t) => {
  const events = Array.from({ length: 100 }, (_, i) => ({
    id: String(i + 6),
    kind: 'transition',
    actor: 'human',
    actorKind: 'human',
    taskKey: 'P0-T01',
    phaseKey: null,
    reason: 'r'.repeat(300),
    data: {},
    at: '2026-11-17T12:00:00.000Z',
  }))
  const fake = await fakeServer((_req, res) => json(res, events))
  t.after(fake.close)

  const { exitCode, stdout } = await runCli(['events', '--after', '5'], { env: fake.env, configPath: NO_CONFIG })
  assert.equal(exitCode, 0)
  const lines = stdout.trimEnd().split('\n')
  const lastShown = lines.at(-3)?.split(' ')[0]
  const shown = lines.length - 2
  assert.ok(shown > 0 && shown < 100)
  assert.equal(lines.at(-2), `truncated; more: devrounds events --after 5 --cursor ${shown}`)
  assert.equal(lines.at(-1), `next: devrounds events --after ${lastShown}`)
  assert.equal(lastShown, events[shown - 1].id)
})

test('run list cut by the budget asks again for the runs that fit and continues at the cursor of that answer', async (t) => {
  // 100 runs whose lines pass 16 KiB; the stand-in answers `limit` runs and a cursor naming the last one.
  const runs = Array.from({ length: 100 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    state: i === 3 ? 'failed' : 'queued',
    attempt: 1,
    cause: 'first',
    jobType: 'j'.repeat(200),
    queue: 'default',
    machine: null,
    queuedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: null,
    failureClass: i === 3 ? 'check_red' : null,
    totalMs: null,
  }))
  const asked: string[] = []
  const fake = await fakeServer((req, res) => {
    const query = new URL(req.url ?? '', 'http://x').searchParams
    asked.push(query.toString())
    const limit = Number(query.get('limit'))
    json(res, { runs: runs.slice(0, limit), nextCursor: `c${limit}` })
  })
  t.after(fake.close)

  const { exitCode, stdout } = await runCli(['run', 'list', '--state', 'queued'], {
    env: fake.env,
    configPath: NO_CONFIG,
  })
  assert.equal(exitCode, 0)
  const lines = stdout.trimEnd().split('\n')
  const shown = lines.length - 2
  assert.ok(shown > 1 && shown < 100, String(shown))
  assert.deepEqual(asked, ['state=queued&limit=100', `state=queued&limit=${shown}`])
  assert.match(lines[0], /^00000000-0000-4000-8000-000000000003 failed: check_red · /)
  assert.match(lines[1], /^00000000-0000-4000-8000-000000000000 queued · /)
  assert.equal(lines.at(-2), `truncated; more: devrounds run list --state queued --cursor c${shown}`)
  assert.equal(lines.at(-1), `next: devrounds run show ${runs[3].id}`)
})

test('plan import never offers more: long lists are capped samples, and --cursor is rejected', async (t) => {
  // Longest allowed keys in all three lists: the worst case for the body size.
  const keys = (prefix: string) => Array.from({ length: 3000 }, (_, i) => `${prefix}${i}`.padEnd(200, 'x'))
  const result = { created: keys('c'), updated: keys('u'), unchanged: 0, onlyInDb: keys('o') }
  let posts = 0
  const fake = await fakeServer((_req, res) => {
    posts++
    json(res, result)
  })
  t.after(fake.close)
  const dir = await scratch('devrounds-import-')
  t.after(() => removeDir(dir))
  const file = join(dir, 'plan.yaml')
  await writeFile(file, 'project: {key: alpha, name: Alpha}\n')

  const res = await runCli(['plan', 'import', file], { env: fake.env, configPath: NO_CONFIG })
  assert.equal(res.exitCode, 0, res.stderr)
  assert.ok(!res.stdout.includes('truncated; more:'), 'a mutation must not offer a re-run')
  assert.ok(Buffer.byteLength(res.stdout) < 16384)
  assert.ok(res.stdout.includes(`only in DevRounds (missing from the file) (3000):\n  ${result.onlyInDb[0]}\n`))
  assert.ok(res.stdout.includes('  … and 2980 more (devrounds plan show)\n'))

  const paged = await runCli(['plan', 'import', file, '--cursor', '5'], { env: fake.env, configPath: NO_CONFIG })
  assert.equal(paged.exitCode, 2)
  assert.match(paged.stderr, /^DR101 /)
  assert.equal(posts, 1, 'the rejected --cursor run must not import again')
})

test('more and next quote arguments that are not plain words', () => {
  assert.equal(
    moreCommandFor(['plan', 'show', '--phase', 'a b;c', '--cursor', '3'])(9),
    `devrounds plan show --phase 'a b;c' --cursor 9`,
  )
})

test('a mutation that times out is exit 4 with an unknown outcome and next: devrounds events', async (t) => {
  const fake = await fakeServer(() => {
    // Never answers.
  })
  t.after(fake.close)
  const res = await runCli(['task', 'start', 'P0-T01'], { env: fake.env, configPath: NO_CONFIG, timeoutMs: 200 })
  assert.equal(res.exitCode, 4)
  assert.match(
    res.stderr,
    /^control plane at http:\/\/127\.0\.0\.1:\d+ did not answer \(no answer in 200 ms\); outcome unknown\n/,
  )
  assert.ok(res.stderr.endsWith('\nnext: devrounds events\n'), res.stderr)
})

test('task start points to criterion check while the task has open criteria', async () => {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  await createProject(ctx, { key: 'alpha', name: 'Alpha' })
  await addTask(ctx, { projectKey: 'alpha', key: 'P0-T01', title: 'A', criteria: ['tests pass'] })
  await addTask(ctx, { projectKey: 'alpha', key: 'P0-T02', title: 'B' })
  const token = await createToken(t.admin, tenant.tenantId, 'human', 'human')
  const env = { DEVROUNDS_URL: url, DEVROUNDS_TOKEN: token, DEVROUNDS_PROJECT: 'alpha' }

  const open = await runCli(['task', 'start', 'P0-T01'], { env, configPath: NO_CONFIG })
  const none = await runCli(['task', 'start', 'P0-T02'], { env, configPath: NO_CONFIG })

  assert.equal(open.stdout.trimEnd().split('\n').at(-1), 'next: devrounds criterion check P0-T01 --evidence <evidence>')
  assert.equal(none.stdout.trimEnd().split('\n').at(-1), 'next: devrounds task done P0-T02')
})

test('missing config points to devrounds login', async () => {
  const res = await runCli(['plan', 'show'], { env: {}, configPath: NO_CONFIG })
  assert.equal(res.exitCode, 2)
  assert.ok(res.stderr.endsWith('\nnext: devrounds login --url <url> --token <token> --project <key>\n'), res.stderr)
})

test('login writes the config through a restricted temp file and leaves nothing else behind', async (t) => {
  const fake = await fakeServer((_req, res) =>
    json(res, { project: { key: 'alpha', name: 'Alpha' }, phases: [], unphased: [] }),
  )
  t.after(fake.close)
  const dir = await scratch('devrounds-login-')
  t.after(() => removeDir(dir))
  const configPath = join(dir, '.devrounds', 'config.json')
  const args = ['login', '--url', fake.env.DEVROUNDS_URL, '--token', 'drt_secret', '--project', 'alpha']

  for (let i = 0; i < 2; i++) {
    const res = await runCli(args, { env: {}, configPath })
    assert.equal(res.exitCode, 0, res.stderr)
  }
  assert.deepEqual(await readdir(join(dir, '.devrounds')), ['config.json'])
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).token, 'drt_secret')
})

test('machine pair-code prints the code and the executor pair command as next', async () => {
  const t = await testDb()
  const tenant = await t.newTenant()
  const token = await createToken(t.admin, tenant.tenantId, 'human', 'human')
  const env = { DEVROUNDS_URL: url, DEVROUNDS_TOKEN: token, DEVROUNDS_PROJECT: 'alpha' }

  const res = await runCli(['machine', 'pair-code', '--name', 'build-01'], { env, configPath: NO_CONFIG })
  assert.equal(res.exitCode, 0, res.stderr)
  const [first, expires, next] = res.stdout.trimEnd().split('\n')
  const code = /^pairing code for machine build-01: ([0-9A-Z]{8})$/.exec(first)?.[1]
  assert.ok(code, first)
  assert.match(expires, /^expires at \d{4}-\d{2}-\d{2}T/)
  assert.equal(next, `next: devrounds-executor pair --url ${url} --code ${code}`)
})

test('-h is a plain value after an option that takes one', async (t) => {
  const bodies: unknown[] = []
  const fake = await fakeServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      json(res, { eventId: '1' })
    })
  })
  t.after(fake.close)

  const res = await runCli(['task', 'add', 'P0-T09', '--title', '-h'], { env: fake.env, configPath: NO_CONFIG })
  assert.equal(res.exitCode, 0, res.stderr)
  assert.ok(!res.stdout.startsWith('usage:'), res.stdout)
  assert.equal((bodies[0] as { title: string }).title, '-h')

  const flag = await runCli(['task', 'add', '-h'], { env: fake.env, configPath: NO_CONFIG })
  assert.equal(flag.exitCode, 0)
  assert.ok(flag.stdout.startsWith('usage:'), flag.stdout)
  assert.equal(bodies.length, 1, 'help must not call the control plane')
})

test('<command> --help prints that command usage from the same text as the full list', async () => {
  const all = (await runCli(['--help'], { env: {}, configPath: NO_CONFIG })).stdout
  for (const argv of [
    ['task', 'start'],
    ['criterion', 'check'],
    ['plan', 'show'],
    ['phase', 'dep', 'add'],
  ]) {
    for (const flag of ['--help', '-h']) {
      const res = await runCli([...argv, flag], { env: {}, configPath: NO_CONFIG })
      assert.equal(res.exitCode, 0, res.stderr)
      const lines = res.stdout.trimEnd().split('\n')
      assert.ok(lines[0].startsWith(`usage: devrounds ${argv.join(' ')} `), res.stdout)
      assert.ok(lines.length < 6, res.stdout)
      // One source: the line shown for the command is the line the full list carries.
      assert.ok(all.includes(lines[0].replace('usage: ', '  ')), res.stdout)
    }
  }
  // A word path that is not a command (only a prefix) keeps the full list.
  const prefix = await runCli(['task', '--help'], { env: {}, configPath: NO_CONFIG })
  assert.equal(prefix.stdout, all)
})

test('a closed stdout ends the CLI quietly, without a stack', async (t) => {
  const events = Array.from({ length: 2000 }, (_, i) => ({
    id: String(i + 1),
    kind: 'transition',
    actor: 'human',
    taskKey: 'P0-T01',
    phaseKey: null,
    reason: 'r'.repeat(300),
    at: '2026-11-17T12:00:00.000Z',
  }))
  const fake = await fakeServer((_req, res) => json(res, events))
  t.after(fake.close)

  const child = spawn(process.execPath, [MAIN, 'events'], {
    env: { ...process.env, ...fake.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  // `devrounds events | head -1`: the reader goes away before the CLI has anything to write.
  child.stdout.destroy()
  await new Promise((resolve) => child.on('close', resolve))
  assert.ok(!/EPIPE|\n\s+at /.test(stderr), stderr)
})

test('an error body without text or hint never prints undefined', async (t) => {
  const fake = await fakeServer((_req, res) => {
    res.statusCode = 409
    json(res, { code: 'DR999' })
  })
  t.after(fake.close)
  const res = await runCli(['task', 'start', 'P0-T01'], { env: fake.env, configPath: NO_CONFIG })
  assert.ok(res.stderr.startsWith('DR999 '), res.stderr)
  assert.ok(!res.stderr.includes('undefined'), res.stderr)
})

test('a mutation answer without an event id never prints undefined', async (t) => {
  const fake = await fakeServer((_req, res) => json(res, {}))
  t.after(fake.close)
  const res = await runCli(['task', 'start', 'P0-T01'], { env: fake.env, configPath: NO_CONFIG })
  assert.equal(res.exitCode, 0, res.stderr)
  assert.ok(!res.stdout.includes('undefined'), res.stdout)
})

test('fields the server leaves out print as "-" in every formatter, never as undefined', async (t) => {
  const run = {
    id: 'r1',
    state: 'finished',
    outcome: {},
    timeline: {},
    durations: {},
    resources: {},
    steps: [{ step: 1, name: 'build' }],
    delays: [{ position: 1 }],
  }
  const fake = await fakeServer((req, res) => {
    if (req.url?.includes('/runs/')) return json(res, run)
    if (req.url?.includes('/machines')) return json(res, [{ name: 'm1', connected: true }])
    if (req.url?.includes('/events')) return json(res, [{ id: '1', kind: 'transition' }])
    if (req.url?.includes('/balance')) return json(res, [{ periodStart: '2026-11-17' }])
    if (req.url?.includes('/indicators')) return json(res, [{ period: '2026-11-17', failureClasses: { infra: 1 } }])
    json(res, { project: { key: 'alpha' }, phases: [], unphased: [] })
  })
  t.after(fake.close)
  const dir = await scratch('devrounds-missing-')
  t.after(() => removeDir(dir))

  const commands = [
    ['run', 'show', 'r1'],
    ['machine', 'list'],
    ['events'],
    ['balance'],
    ['indicators'],
    ['login', '--url', fake.env.DEVROUNDS_URL, '--token', 'drt_x', '--project', 'alpha'],
  ]
  for (const argv of commands) {
    const res = await runCli(argv, { env: fake.env, configPath: join(dir, 'config.json') })
    assert.equal(res.exitCode, 0, `${argv.join(' ')}: ${res.stderr}`)
    assert.ok(!res.stdout.includes('undefined'), `${argv.join(' ')}: ${res.stdout}`)
  }
})

test('a config file that is not a JSON object answers DR502', async (t) => {
  const dir = await scratch('devrounds-config-')
  t.after(() => removeDir(dir))
  const configPath = join(dir, 'config.json')
  for (const content of ['null', '[]', '"text"', '5']) {
    await writeFile(configPath, content)
    const res = await runCli(['plan', 'show'], { env: {}, configPath })
    assert.equal(res.exitCode, 6, `${content}: ${res.stderr}`)
    assert.match(res.stderr, /^DR502 .*JSON object/, content)
    assert.ok(res.stderr.endsWith('\nnext: devrounds login --url <url> --token <token> --project <key>\n'), content)
  }
})

test('a mutation that times out is sent once more with the same Idempotency-Key and its answer is printed', async (t) => {
  const seen: { key: unknown; method?: string; url?: string; body: string }[] = []
  const fake = await fakeServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ key: req.headers['idempotency-key'], method: req.method, url: req.url, body })
    // The first request is held past the client timeout; the second one is answered.
    if (seen.length === 1) return
    json(res, { task: { key: 'P0-T01', state: 'in_progress' } })
  })
  t.after(fake.close)
  const res = await runCli(['task', 'start', 'P0-T01'], { env: fake.env, configPath: NO_CONFIG, timeoutMs: 200 })
  assert.equal(res.exitCode, 0, res.stderr)
  assert.equal(seen.length, 2)
  assert.equal(typeof seen[0]?.key, 'string')
  assert.equal(seen[0]?.key, seen[1]?.key)
  assert.equal(seen[0]?.method, seen[1]?.method)
  assert.equal(seen[0]?.url, seen[1]?.url)
  assert.equal(seen[0]?.body, seen[1]?.body)
})

test('a refused connection is not retried', async () => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const env = { DEVROUNDS_URL: `http://127.0.0.1:${port}`, DEVROUNDS_TOKEN: 'drt_x', DEVROUNDS_PROJECT: 'alpha' }
  const res = await runCli(['task', 'start', 'P0-T01'], { env, configPath: NO_CONFIG, timeoutMs: 200 })
  assert.equal(res.exitCode, 4)
  assert.match(res.stderr, /unreachable at/)
  assert.ok(!res.stderr.includes('outcome unknown'), res.stderr)
  assert.ok(res.stderr.endsWith('\nnext: start the control plane (node control-plane/src/main.ts serve)\n'), res.stderr)
})

test('two timeouts report outcome unknown with next: devrounds events', async (t) => {
  let requests = 0
  const fake = await fakeServer(() => {
    requests++
  })
  t.after(fake.close)
  const res = await runCli(['task', 'start', 'P0-T01'], { env: fake.env, configPath: NO_CONFIG, timeoutMs: 200 })
  assert.equal(res.exitCode, 4)
  assert.equal(requests, 2)
  assert.match(res.stderr, /outcome unknown\n/)
  assert.ok(res.stderr.endsWith('\nnext: devrounds events\n'), res.stderr)
})

test('machine pair-code is not retried', async (t) => {
  let requests = 0
  const fake = await fakeServer(() => {
    requests++
  })
  t.after(fake.close)
  const res = await runCli(['machine', 'pair-code', '--name', 'laptop'], {
    env: fake.env,
    configPath: NO_CONFIG,
    timeoutMs: 200,
  })
  assert.equal(res.exitCode, 4)
  assert.equal(requests, 1)
})

test('idempotency keys older than 24 h are pruned', async () => {
  const t = await testDb()
  const tenant = await t.newTenant()
  for (const [key, age] of [
    ['old', '25 hours'],
    ['fresh', '23 hours'],
  ] as const) {
    await t.admin
      .insertInto('idempotency_keys')
      .values({
        tenant_id: tenant.tenantId,
        key,
        response: '{}',
        created_at: sql<Date>`now() - ${sql.lit(age)}::interval`,
      })
      .execute()
  }
  const pruned = await pruneIdempotencyKeys(t.db, new Date(Date.now() - 24 * 60 * 60 * 1000))
  assert.ok(pruned >= 1)
  const left = await t.admin
    .selectFrom('idempotency_keys')
    .select('key')
    .where('tenant_id', '=', tenant.tenantId)
    .execute()
  assert.deepEqual(
    left.map((r) => r.key),
    ['fresh'],
  )
})

// A gate as `GET /gates/:id` answers it (gates/service.ts GateView, dates as ISO strings).
const gateJson = (over: Record<string, unknown> = {}) => ({
  id: 'gate-1',
  key: 'pre-pr',
  state: 'running',
  machine: 'build-01',
  cwd: 'C:\\src\\app',
  headSha: null,
  dirty: null,
  batch: 'batch-1',
  createdAt: '2026-11-23T10:00:00.000Z',
  finishedAt: null,
  wallMs: null,
  checks: [] as Record<string, unknown>[],
  ...over,
})

const check = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  jobType: 'check',
  state: 'open',
  runId: `run-${ref}`,
  runState: 'queued',
  attempt: 1,
  cachedFrom: null,
  failureClass: null,
  failureSummary: null,
  durationMs: null,
  ...over,
})

const GATE_FILE = 'key: pre-pr\nchecks:\n  - ref: lint\n    job_type: lint\n'

const refusal = (res: ServerResponse) =>
  res
    .writeHead(409, { 'content-type': 'application/json' })
    .end(JSON.stringify({ code: 'DR308', text: 'held', hint: 'wait', data: { gate: 'holder-1' } }))

test('gate run --wait-lock waits for the holder to end and then submits', async (t) => {
  const dir = await scratch('gate-')
  t.after(() => removeDir(dir))
  const file = join(dir, 'gate.yaml')
  await writeFile(file, GATE_FILE)
  const posts: { key: string | string[] | undefined; body: unknown }[] = []
  const gets: string[] = []
  const fake = await fakeServer((req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        posts.push({ key: req.headers['idempotency-key'], body: JSON.parse(Buffer.concat(chunks).toString()) })
        if (posts.length === 1) refusal(res)
        else json(res, gateJson({ checks: [check('lint')] }))
      })
      return
    }
    gets.push(req.url ?? '')
    json(res, gateJson({ id: 'holder-1', state: 'passed' }))
  })
  t.after(fake.close)

  const res = await runCli(
    ['gate', 'run', file, '--cwd', 'C:\\src\\app', '--machine', 'build-01', '--head-sha', 'abc1234', '--dirty'],
    { env: fake.env, configPath: NO_CONFIG },
  )
  assert.equal(res.exitCode, 0, res.stderr)
  assert.equal(posts.length, 2)
  assert.notEqual(posts[0].key, posts[1].key)
  assert.deepEqual(posts[1].body, {
    file: { key: 'pre-pr', checks: [{ ref: 'lint', job_type: 'lint' }] },
    cwd: 'C:\\src\\app',
    machine: 'build-01',
    headSha: 'abc1234',
    dirty: true,
  })
  assert.deepEqual(gets, ['/api/projects/alpha/gates/holder-1?wait=25'])
  assert.match(res.stdout, /^gate gate-1 running · pre-pr/)
  assert.ok(res.stdout.endsWith('next: devrounds gate show gate-1 --wait\n'), res.stdout)
})

test('gate run --no-wait-lock exits 1 with DR308 and the holder id at once', async (t) => {
  const dir = await scratch('gate-')
  t.after(() => removeDir(dir))
  const file = join(dir, 'gate.yaml')
  await writeFile(file, GATE_FILE)
  let requests = 0
  const fake = await fakeServer((_req, res) => {
    requests++
    refusal(res)
  })
  t.after(fake.close)

  const res = await runCli(['gate', 'run', file, '--cwd', 'C:\\src\\app', '--no-wait-lock'], {
    env: fake.env,
    configPath: NO_CONFIG,
  })
  assert.equal(res.exitCode, 1)
  assert.match(res.stderr, /^DR308 /)
  assert.equal(requests, 1)
})

test('gate run past --wait-lock exits 1 with DR308', async (t) => {
  const dir = await scratch('gate-')
  t.after(() => removeDir(dir))
  const file = join(dir, 'gate.yaml')
  await writeFile(file, GATE_FILE)
  const waits: string[] = []
  const fake = await fakeServer((req, res) => {
    if (req.method === 'POST') return refusal(res)
    waits.push(new URL(req.url ?? '', 'http://x').searchParams.get('wait') ?? '')
    // The holder keeps running: the real route answers once the wait is up.
    setTimeout(() => json(res, gateJson({ id: 'holder-1' })), 300)
  })
  t.after(fake.close)

  const started = Date.now()
  const res = await runCli(['gate', 'run', file, '--cwd', 'C:\\src\\app', '--wait-lock', '1'], {
    env: fake.env,
    configPath: NO_CONFIG,
  })
  assert.equal(res.exitCode, 1)
  assert.match(res.stderr, /^DR308 /)
  assert.ok(Date.now() - started < 5000)
  // A wait never asks for more than the time left.
  assert.ok(waits.length >= 1 && waits.every((w) => Number(w) <= 1), waits.join())
})

test('gate show lists failed, then stopped, then skipped checks first, with the run logs command', async (t) => {
  // In ref order, as gates/service.ts loadGateView returns them: the skipped and stopped checks sort before the failed.
  const fake = await fakeServer((_req, res) =>
    json(
      res,
      gateJson({
        state: 'failed',
        finishedAt: '2026-11-23T10:01:00.000Z',
        wallMs: 60_000,
        checks: [
          check('build', { state: 'finished', runState: 'finished', durationMs: 12_300 }),
          check('docs'),
          check('e2e', {
            state: 'skipped',
            runState: 'skipped',
            failureSummary: 'skipped: dependency test failed',
          }),
          check('lint', { state: 'stopped', runState: 'stopped', failureClass: 'cancelled', durationMs: 1_000 }),
          check('test', {
            state: 'failed',
            runState: 'failed',
            failureClass: 'check_red',
            failureSummary: '3 tests failed',
            durationMs: 45_600,
          }),
        ],
      }),
    ),
  )
  t.after(fake.close)

  const res = await runCli(['gate', 'show', 'gate-1'], { env: fake.env, configPath: NO_CONFIG })
  assert.equal(res.exitCode, 0, res.stderr)
  assert.deepEqual(res.stdout.trimEnd().split('\n'), [
    'test failed check_red 45.6 s 3 tests failed',
    '  log: devrounds run logs run-test',
    'lint stopped cancelled 1.0 s -',
    '  log: devrounds run logs run-lint',
    'e2e skipped - - skipped: dependency test failed',
    'gate gate-1 failed · pre-pr · 60.0 s',
    'build finished 12.3 s',
    'docs queued',
    'next: devrounds run logs run-test',
  ])
})

test('run logs --out writes a 3-page log byte for byte and prints one line', async (t) => {
  const dir = await scratch('logs-')
  t.after(() => removeDir(dir))
  const pages: Record<string, { lines: { seq: number; text: string }[]; nextCursor: number | null }> = {
    '': {
      lines: [
        { seq: 1, text: 'alpha' },
        { seq: 2, text: 'bravo' },
      ],
      nextCursor: 3,
    },
    '3': { lines: [{ seq: 3, text: 'charlie é' }], nextCursor: 4 },
    '4': {
      lines: [
        { seq: 4, text: '' },
        { seq: 5, text: 'echo' },
      ],
      nextCursor: null,
    },
  }
  const cursors: string[] = []
  const fake = await fakeServer((req, res) => {
    const cursor = new URL(req.url ?? '', 'http://x').searchParams.get('cursor') ?? ''
    cursors.push(cursor)
    json(res, pages[cursor])
  })
  t.after(fake.close)

  const file = join(dir, 'run.log')
  await writeFile(file, 'stale content that is longer than the log')
  const res = await runCli(['run', 'logs', 'run-1', '--out', file], { env: fake.env, configPath: NO_CONFIG })
  assert.equal(res.exitCode, 0, res.stderr)
  const expected = 'alpha\nbravo\ncharlie é\n\necho\n'
  assert.deepEqual(await readFile(file), Buffer.from(expected))
  assert.deepEqual(cursors, ['', '3', '4'])
  assert.deepEqual(res.stdout.trimEnd().split('\n'), [
    `wrote ${Buffer.byteLength(expected)} bytes to ${file}`,
    'next: devrounds run show run-1',
  ])
})

test('run logs --out in a directory that does not exist exits 2 with DR101 before any request', async (t) => {
  const dir = await scratch('logs-')
  t.after(() => removeDir(dir))
  let requests = 0
  const fake = await fakeServer((_req, res) => {
    requests++
    json(res, { lines: [], nextCursor: null })
  })
  t.after(fake.close)

  const res = await runCli(['run', 'logs', 'run-1', '--out', join(dir, 'missing', 'run.log')], {
    env: fake.env,
    configPath: NO_CONFIG,
  })
  assert.equal(res.exitCode, 2)
  assert.match(res.stderr, /^DR101 /)
  assert.equal(requests, 0)
})

test('a cached check prints cached from its source run', async (t) => {
  const fake = await fakeServer((_req, res) =>
    json(
      res,
      gateJson({
        state: 'passed',
        wallMs: 1000,
        finishedAt: '2026-11-23T10:00:01.000Z',
        checks: [check('lint', { state: 'finished', runState: 'finished', cachedFrom: 'run-old' })],
      }),
    ),
  )
  t.after(fake.close)

  const res = await runCli(['gate', 'show', 'gate-1'], { env: fake.env, configPath: NO_CONFIG })
  assert.deepEqual(res.stdout.trimEnd().split('\n'), [
    'gate gate-1 passed · pre-pr · 1.0 s',
    'lint cached from run-old',
    'next: devrounds plan show',
  ])
})

test('gate show --json prints the gate view only', async (t) => {
  const view = gateJson({ checks: [check('lint')] })
  const fake = await fakeServer((_req, res) => json(res, view))
  t.after(fake.close)

  const res = await runCli(['gate', 'show', 'gate-1', '--json'], { env: fake.env, configPath: NO_CONFIG })
  assert.equal(res.exitCode, 0)
  assert.equal(res.stdout, `${JSON.stringify(view)}\n`)
})

test('report improvement --open-tasks opens each finding once across two runs', async () => {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  await createProject(ctx, { key: 'alpha', name: 'Alpha' })
  await putJobType(ctx, 'alpha', { key: 'check', command: { program: 'node', args: ['check.js'] } })
  const queued = await enqueueRun(ctx, { projectKey: 'alpha', jobTypeKey: 'check', cwd: 'C:\\work' })
  const job = await t.admin
    .selectFrom('runs')
    .select(['job_id', 'job_type_id', 'project_id'])
    .where('id', '=', queued.id)
    .executeTakeFirstOrThrow()
  // Two check_red and two unclassified failures on 2026-11-10 in the tenant's default America/Sao_Paulo and none
  // before: check_red doubled and the unclassified share are the two findings. Unclassified doubled too, but the
  // share already tracks it, so it opens no class task of its own.
  const failures = ['check_red', 'check_red', 'unclassified', 'unclassified'] as const
  for (const [i, failureClass] of failures.entries()) {
    const finished = Date.parse(`2026-11-10T1${i}:00:00Z`)
    await t.admin
      .insertInto('runs')
      .values({
        tenant_id: tenant.tenantId,
        ...job,
        attempt: i + 2,
        state: 'failed',
        failure_class: failureClass,
        queued_at: new Date(finished - 5000),
        not_before: new Date(finished - 5000),
        started_at: new Date(finished - 1000),
        finished_at: new Date(finished),
      })
      .execute()
  }
  const token = await createToken(t.admin, tenant.tenantId, 'human', 'human')
  const env = { DEVROUNDS_URL: url, DEVROUNDS_TOKEN: token, DEVROUNDS_PROJECT: 'alpha' }
  const argv = ['report', 'improvement', '--day', '2026-11-10', '--open-tasks']

  const first = await runCli(argv, { env, configPath: NO_CONFIG })
  const second = await runCli(argv, { env, configPath: NO_CONFIG })

  assert.equal(first.exitCode, 0, first.stderr)
  assert.equal(second.exitCode, 0, second.stderr)
  assert.match(first.stdout, /^opened F-0001 /m)
  assert.match(first.stdout, /^opened F-0002 /m)
  assert.match(second.stdout, /^already open F-0001 improvement:class:check:check_red$/m)
  assert.match(second.stdout, /^already open F-0002 improvement:unclassified$/m)
  assert.doesNotMatch(second.stdout, /^opened /m)
  const tasks = await t.admin
    .selectFrom('tasks')
    .select(['id', 'key', 'source_key', 'phase_id', 'description'])
    .where('tenant_id', '=', tenant.tenantId)
    .orderBy('key')
    .execute()
  assert.deepEqual(
    tasks.map((task) => [task.key, task.source_key, task.phase_id]),
    [
      ['F-0001', 'improvement:class:check:check_red', null],
      ['F-0002', 'improvement:unclassified', null],
    ],
  )
  assert.match(tasks[1].description, /2 of 4 failed runs on 2026-11-10/)
  const criteria = await t.admin.selectFrom('criteria').select('text').where('task_id', '=', tasks[0].id).execute()
  assert.deepEqual(criteria, [{ text: 'explained or fixed, with evidence' }])
})

test('report improvement --open-tasks tries every finding after one is refused and exits with its code', async (t) => {
  const finding = (sourceKey: string) => ({ sourceKey, kind: 'class_doubled', title: sourceKey, evidence: 'e' })
  const report = {
    day: '2026-11-10',
    timeZone: 'America/Sao_Paulo',
    slowestSteps: [],
    retries: [],
    unclassifiedShare: 1,
    findings: [finding('refused'), finding('improvement:unclassified')],
  }
  const posted: string[] = []
  const fake = await fakeServer((req, res) => {
    if (req.method === 'GET') return json(res, report)
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const { sourceKey } = JSON.parse(raw)
      posted.push(sourceKey)
      if (sourceKey === 'refused') {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ code: 'DR101', text: 'Invalid input.', hint: 'fix it', data: {} }))
      }
      json(res, { key: 'F-0002', created: true, eventId: '1' })
    })
  })
  t.after(fake.close)

  const res = await runCli(['report', 'improvement', '--open-tasks'], { env: fake.env, configPath: NO_CONFIG })

  assert.deepEqual(posted, ['refused', 'improvement:unclassified'])
  assert.equal(res.exitCode, 2, res.stderr)
  assert.match(res.stdout, /^not opened refused: DR101 Invalid input\.$/m)
  assert.match(res.stdout, /^opened F-0002 improvement:unclassified$/m)
})

// A tenant with project `alpha`, task P3-T06 and version 1 proposed by the agent: pattern rules for web and for the
// engine (warn, block), a block rule for docs, and a repo-wide judgment rule.
async function conventionsTenant() {
  const t = await testDb()
  const tenant = await t.newTenant()
  const human = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  const agent = { db: t.db, tenantId: tenant.tenantId, actor: tenant.agent }
  await createProject(human, { key: 'alpha', name: 'Alpha' })
  await addTask(human, { projectKey: 'alpha', key: 'P3-T06', title: 'Conventions' })
  const evidence = [{ path: 'AGENTS.md', excerpt: 'Never', role: 'source' as const }]
  const pattern = (key: string, paths: string[], severity: 'warn' | 'block') => ({
    key,
    section: 'Never',
    title: `title of ${key}`,
    why: `why of ${key}`,
    paths,
    check: { kind: 'pattern' as const, forbid: 'TODO' },
    severity,
    examples: { bad: ['// TODO'] },
    evidence,
  })
  await propose(agent, 'alpha', {
    document: {
      targets: [{ path: 'AGENTS.md' }],
      rules: [
        {
          key: 'repo.judgment',
          section: 'Always',
          title: 'title of repo.judgment',
          why: 'why',
          check: { kind: 'judgment' },
          severity: 'block',
          evidence,
        },
        pattern('web.warn', ['web/**'], 'warn'),
        pattern('engine.warn', ['control-plane/src/**/*.ts'], 'warn'),
        pattern('engine.block', ['control-plane/src/**/*.ts'], 'block'),
        pattern('docs.block', ['docs/**'], 'block'),
      ],
    },
    basedOn: null,
    headSha: null,
    task: 'P3-T06',
  })
  const envFor = async (kind: 'human' | 'agent') => ({
    DEVROUNDS_URL: url,
    DEVROUNDS_TOKEN: await createToken(t.admin, tenant.tenantId, kind, kind),
    DEVROUNDS_PROJECT: 'alpha',
  })
  return { human, envFor }
}

test('conventions approve with an agent token exits 5', async () => {
  const { envFor } = await conventionsTenant()
  const res = await runCli(['conventions', 'approve', '1'], { env: await envFor('agent'), configPath: NO_CONFIG })
  assert.equal(res.exitCode, 5, res.stderr)
  assert.match(res.stderr, /^DR453 Only a human member can approve conventions\./)
})

test('conventions show --paths prints the rules of those paths, blocking first', async () => {
  const { human, envFor } = await conventionsTenant()
  await decide(human, 'alpha', 1, 'approve', undefined)
  const res = await runCli(['conventions', 'show', '--paths', 'control-plane/src/a.ts,README.md'], {
    env: await envFor('agent'),
    configPath: NO_CONFIG,
  })
  assert.equal(res.exitCode, 0, res.stderr)
  const rules = res.stdout.split('\n').filter((line) => /^[a-z]+\.[a-z]+ /.test(line))
  assert.deepEqual(rules, [
    'engine.block block pattern title of engine.block',
    'engine.warn warn pattern title of engine.warn',
    'repo.judgment block judgment title of repo.judgment',
  ])
  assert.match(res.stdout, /^engine\.block block pattern title of engine\.block\n {2}why of engine\.block$/m)
})

test('conventions render writes the blocks; render --check exits 1 after a hand edit', async () => {
  const { human, envFor } = await conventionsTenant()
  await decide(human, 'alpha', 1, 'approve', undefined)
  const repo = await scratch('render-')
  try {
    const agents = join(repo, 'AGENTS.md')
    await writeFile(agents, '# AGENTS.md\r\n\r\nHand-written.\r\n')
    const opts = { env: await envFor('agent'), configPath: NO_CONFIG }
    const written = await runCli(['conventions', 'render', '--cwd', repo], opts)
    assert.equal(written.exitCode, 0, written.stdout + written.stderr)
    assert.match(written.stdout, /^rendered version 1 into AGENTS\.md$/m)
    const text = await readFile(agents, 'utf8')
    assert.ok(text.startsWith('# AGENTS.md\r\n\r\nHand-written.\r\n\r\n<!-- devrounds:conventions begin version=1 '))

    const clean = await runCli(['conventions', 'render', '--cwd', repo, '--check'], opts)
    assert.equal(clean.exitCode, 0, clean.stdout + clean.stderr)

    await writeFile(agents, text.replace('why of engine.block', 'why not'))
    const drift = await runCli(['conventions', 'render', '--cwd', repo, '--check'], opts)
    assert.equal(drift.exitCode, 1, drift.stdout + drift.stderr)
    assert.match(drift.stdout, /^docs_drift AGENTS\.md different\n/)
    assert.equal(
      await readFile(agents, 'utf8'),
      text.replace('why of engine.block', 'why not'),
      '--check writes nothing',
    )
  } finally {
    await removeDir(repo)
  }
})

test('a target dropped by the active version: render --check reports its block, render removes it', async (t) => {
  const tdb = await testDb()
  const tenant = await tdb.newTenant()
  const human = { db: tdb.db, tenantId: tenant.tenantId, actor: tenant.human }
  await createProject(human, { key: 'alpha', name: 'Alpha' })
  await addTask(human, { projectKey: 'alpha', key: 'P3-T05', title: 'Conventions' })
  const evidence = [{ path: 'AGENTS.md', excerpt: 'Never', role: 'source' as const }]
  const fact = { key: 'layout.cp', section: 'Layout', text: 'control-plane/: the control plane.', evidence }
  const version = async (basedOn: number | null, targets: string[], factTarget: string) => {
    const document = { targets: targets.map((path) => ({ path })), rules: [], facts: [{ ...fact, target: factTarget }] }
    const { version: v } = await propose(human, 'alpha', { document, basedOn, headSha: null, task: 'P3-T05' })
    await decide(human, 'alpha', v, 'approve', undefined)
  }
  const repo = await scratch('stale-')
  t.after(() => removeDir(repo))
  const readme = join(repo, 'README.md')
  await writeFile(readme, '# README\r\n\r\nHand-written.\r\n')
  const opts = {
    env: {
      DEVROUNDS_URL: url,
      DEVROUNDS_TOKEN: await createToken(tdb.admin, tenant.tenantId, 'agent', 'agent'),
      DEVROUNDS_PROJECT: 'alpha',
    },
    configPath: NO_CONFIG,
  }
  await version(null, ['AGENTS.md', 'README.md'], 'README.md')
  assert.equal((await runCli(['conventions', 'render', '--cwd', repo], opts)).exitCode, 0)
  await version(1, ['AGENTS.md'], 'AGENTS.md')

  const drift = await runCli(['conventions', 'render', '--cwd', repo, '--check'], opts)
  assert.equal(drift.exitCode, 1, drift.stdout + drift.stderr)
  assert.match(drift.stdout, /^docs_drift AGENTS\.md different\ndocs_drift README\.md stale_block\n/)

  const rendered = await runCli(['conventions', 'render', '--cwd', repo], opts)
  assert.equal(rendered.exitCode, 0, rendered.stdout + rendered.stderr)
  assert.match(rendered.stdout, /^removed the version 1 block from README\.md$/m)
  assert.equal(await readFile(readme, 'utf8'), '# README\r\n\r\nHand-written.\r\n')
  assert.equal((await runCli(['conventions', 'render', '--cwd', repo, '--check'], opts)).exitCode, 0)
})

test('conventions propose with a stale excerpt exits 2 and sends nothing', async (t) => {
  const repo = await scratch('propose-')
  t.after(() => removeDir(repo))
  await writeFile(join(repo, 'AGENTS.md'), '# Rules\n\nNever call sync fs.\n')
  const file = join(repo, 'conventions.yaml')
  await writeFile(
    file,
    [
      'targets: [{ path: AGENTS.md }]',
      'rules:',
      '  - key: engine.no-sync',
      '    section: Never',
      '    title: Never call sync fs',
      '    why: It blocks the event loop.',
      '    check: { kind: judgment }',
      '    evidence: [{ path: AGENTS.md, excerpt: Never call sync child-process, role: source }]',
      '',
    ].join('\n'),
  )
  let requests = 0
  const fake = await fakeServer((_req, res) => {
    requests += 1
    json(res, {})
  })
  t.after(fake.close)

  const res = await runCli(['conventions', 'propose', file, '--cwd', repo, '--task', 'P3-T01'], {
    env: fake.env,
    configPath: NO_CONFIG,
  })

  assert.equal(res.exitCode, 2, res.stderr)
  assert.match(res.stderr, /^DR101 .*\/rules\/0\/evidence\/0.*excerpt not found in AGENTS\.md \(line 8,/)
  assert.equal(requests, 0)
})

test('conventions verify --open-tasks opens one F- task per stale rule and none the second time', async (t) => {
  const repo = await scratch('verify-')
  t.after(() => removeDir(repo))
  await writeFile(join(repo, 'AGENTS.md'), '# Rules\n\nNever call sync fs.\n')
  const tdb = await testDb()
  const tenant = await tdb.newTenant()
  const human = { db: tdb.db, tenantId: tenant.tenantId, actor: tenant.human }
  await createProject(human, { key: 'alpha', name: 'Alpha' })
  await addTask(human, { projectKey: 'alpha', key: 'P3-T01', title: 'Conventions' })
  const rule = (key: string, excerpt: string, path = 'AGENTS.md', check: object = { kind: 'judgment' }) => ({
    key,
    section: 'Never',
    title: `title of ${key}`,
    why: 'why',
    check,
    evidence: [{ path, excerpt, role: 'source' as const }],
  })
  await propose(human, 'alpha', {
    document: {
      targets: [{ path: 'AGENTS.md' }],
      rules: [
        rule('fresh', 'Never call sync fs.'),
        rule('gone-excerpt', 'Never rerun a flaky test'),
        rule('gone-file', 'x', 'docs/none.md'),
        rule('no-job-type', 'Never call', 'AGENTS.md', { kind: 'job_type', enforced_by: 'devrounds-test' }),
      ],
    },
    basedOn: null,
    headSha: null,
    task: 'P3-T01',
  })
  await decide(human, 'alpha', 1, 'approve', undefined)
  const env = {
    DEVROUNDS_URL: url,
    DEVROUNDS_TOKEN: await createToken(tdb.admin, tenant.tenantId, 'agent', 'agent'),
    DEVROUNDS_PROJECT: 'alpha',
  }
  const argv = ['conventions', 'verify', '--cwd', repo, '--open-tasks']

  const first = await runCli(argv, { env, configPath: NO_CONFIG })
  const second = await runCli(argv, { env, configPath: NO_CONFIG })

  assert.equal(first.exitCode, 0, first.stderr)
  assert.equal(second.exitCode, 0, second.stderr)
  assert.match(first.stdout, /^gone-excerpt \/rules\/1\/evidence\/0 excerpt not found in AGENTS\.md$/m)
  assert.match(first.stdout, /^no-job-type enforced_by devrounds-test: no such job type$/m)
  assert.match(second.stdout, /^already open F-0001 conventions:evidence:gone-excerpt$/m)
  assert.doesNotMatch(second.stdout, /^opened /m)
  const tasks = await tdb.admin
    .selectFrom('tasks')
    .select(['key', 'source_key'])
    .where('tenant_id', '=', tenant.tenantId)
    .where('source_key', 'is not', null)
    .orderBy('key')
    .execute()
  assert.deepEqual(
    tasks.map((task) => [task.key, task.source_key]),
    [
      ['F-0001', 'conventions:evidence:gone-excerpt'],
      ['F-0002', 'conventions:evidence:gone-file'],
      ['F-0003', 'conventions:evidence:no-job-type'],
    ],
  )
})

const CHECK_DIFF = fileURLToPath(new URL('../../../roadmap/fixtures/conventions/check-cli.diff', import.meta.url))

test('conventions check --diff <fixture> prints blocking first and exits 1', async (t) => {
  const { human, envFor } = await conventionsTenant()
  await decide(human, 'alpha', 1, 'approve', undefined)
  const repo = await scratch('check-')
  t.after(() => removeDir(repo))
  const opts = { env: await envFor('agent'), configPath: NO_CONFIG }
  // AGENTS.md is the target: rendered, so the only drift is the one written below.
  assert.equal((await runCli(['conventions', 'render', '--cwd', repo], opts)).exitCode, 0)

  const res = await runCli(['conventions', 'check', '--cwd', repo, '--diff', CHECK_DIFF], opts)
  assert.equal(res.exitCode, 1, res.stdout + res.stderr)
  assert.equal(
    res.stdout,
    [
      'control-plane/src/x.ts:5 engine.block title of engine.block',
      '  // TODO engine',
      'web/a.ts:2 web.warn title of web.warn',
      '  // TODO web',
      'control-plane/src/x.ts:5 engine.warn title of engine.warn',
      '  // TODO engine',
      'checked 2 files against version 1: 1 blocking, 2 warnings',
      "next: devrounds conventions show --paths 'control-plane/src/x.ts,web/a.ts'",
      '',
    ].join('\n'),
  )

  // Only the web file: its warn rule prints and passes.
  const warnOnly = join(repo, 'warn.diff')
  await writeFile(warnOnly, (await readFile(CHECK_DIFF, 'utf8')).split('diff --git a/control-plane')[0])
  const warned = await runCli(['conventions', 'check', '--cwd', repo, '--diff', warnOnly], opts)
  assert.equal(warned.exitCode, 0, warned.stdout + warned.stderr)
  assert.match(warned.stdout, /\nchecked 1 files against version 1: 0 blocking, 1 warnings\n/)

  await writeFile(join(repo, 'AGENTS.md'), 'hand-written only\n')
  const drift = await runCli(['conventions', 'check', '--cwd', repo, '--diff', CHECK_DIFF], opts)
  assert.equal(drift.exitCode, 1)
  assert.match(drift.stdout, /^AGENTS\.md docs_drift missing_block\ncontrol-plane\/src\/x\.ts:5 engine\.block /)
  assert.match(drift.stdout, /\nchecked 2 files against version 1: 2 blocking, 2 warnings\n/)
  assert.match(drift.stdout, /\nnext: devrounds conventions render --cwd /)
})

test('conventions check inside a run whose result is refused exits 6, never a pass', async (t) => {
  const { human, envFor } = await conventionsTenant()
  await decide(human, 'alpha', 1, 'approve', undefined)
  const repo = await scratch('check-run-')
  t.after(() => removeDir(repo))
  const env = await envFor('agent')
  assert.equal((await runCli(['conventions', 'render', '--cwd', repo], { env, configPath: NO_CONFIG })).exitCode, 0)
  const runId = '00000000-0000-4000-8000-000000000000'
  const res = await runCli(['conventions', 'check', '--cwd', repo, '--diff', CHECK_DIFF], {
    env: { ...env, DEVROUNDS_RUN_ID: runId },
    configPath: NO_CONFIG,
  })
  assert.equal(res.exitCode, 6, res.stdout + res.stderr)
  assert.match(res.stdout, new RegExp(`^not recorded for run ${runId}: DR201 `))
  assert.match(res.stdout, /\nchecked 2 files against version 1: 1 blocking, 2 warnings\n/)
})

test('conventions check refuses text that is not a unified diff instead of passing on zero files', async (t) => {
  const repo = await scratch('check-text-')
  t.after(() => removeDir(repo))
  const notDiff = join(repo, 'external.txt')
  // What `git diff` prints through an external driver such as `diff.external=echo`.
  await writeFile(notDiff, 'src/a.ts /dev/null . . C:\\Temp\\git-blob-1 0123456 100644\n')
  const res = await runCli(['conventions', 'check', '--cwd', repo, '--diff', notDiff], {
    env: { DEVROUNDS_URL: url, DEVROUNDS_TOKEN: 'unused', DEVROUNDS_PROJECT: 'alpha' },
    configPath: NO_CONFIG,
  })
  assert.equal(res.exitCode, 2, res.stdout + res.stderr)
  assert.match(res.stderr, /^DR101 .*--diff.*is not a unified diff/)
})

test('conventions check with no active version exits 3', async () => {
  const { envFor } = await conventionsTenant()
  const res = await runCli(['conventions', 'check', '--cwd', '.', '--diff', CHECK_DIFF], {
    env: await envFor('agent'),
    configPath: NO_CONFIG,
  })
  assert.equal(res.exitCode, 3, res.stdout + res.stderr)
  assert.match(res.stderr, /^DR201 /)
})
