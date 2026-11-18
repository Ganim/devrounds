import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { addTask, createProject } from '../planning/service.ts'
import { testDb } from '../test-support/db.ts'
import { moreCommandFor, runCli } from './commands.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

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
const NO_CONFIG = join(tmpdir(), 'devrounds-no-such-dir', 'config.json')

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
  const dir = await mkdtemp(join(tmpdir(), 'devrounds-import-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
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
  const dir = await mkdtemp(join(tmpdir(), 'devrounds-login-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
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

test('a config file that is not a JSON object answers DR502', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'devrounds-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const configPath = join(dir, 'config.json')
  for (const content of ['null', '[]', '"text"', '5']) {
    await writeFile(configPath, content)
    const res = await runCli(['plan', 'show'], { env: {}, configPath })
    assert.equal(res.exitCode, 6, `${content}: ${res.stderr}`)
    assert.match(res.stderr, /^DR502 .*JSON object/, content)
    assert.ok(res.stderr.endsWith('\nnext: devrounds login --url <url> --token <token> --project <key>\n'), content)
  }
})
