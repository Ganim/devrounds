import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  assertCacheFresh,
  fetchUpstream,
  findingsOf,
  openPendingTasks,
  parseSyncConfig,
  pendingUpstream,
  type SyncConfig,
} from './devlanes-sync.ts'

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const script = join(repoRoot, 'scripts', 'devlanes-sync.ts')

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  )
  return stdout.trim()
}

async function put(work: string, rel: string, text: string): Promise<void> {
  await mkdir(join(work, rel, '..'), { recursive: true })
  await writeFile(join(work, rel), text)
}

async function commitAll(work: string, message: string): Promise<string> {
  await git(work, 'add', '-A')
  await git(work, 'commit', '-q', '-m', message)
  return git(work, 'rev-parse', 'HEAD')
}

const entry = (name: string, upstreamPath: string, syncedCommit: string) => ({ name, upstreamPath, syncedCommit })

describe('devlanes-sync', () => {
  let dir: string
  let cacheDir: string
  let work: string
  let base: string
  let logsCommit: string
  let bothCommit: string
  let sideCommit: string
  let readmeCommit: string

  before(async () => {
    await mkdir(join(repoRoot, '.superpowers', 'tmp'), { recursive: true })
    dir = await mkdtemp(join(repoRoot, '.superpowers', 'tmp', 'x-'))
    work = join(dir, 'work')
    await git(dir, 'init', '-q', '-b', 'main', work)
    await put(work, 'crates/logs/src/a.rs', '// 1\n')
    await put(work, 'crates/core/src/b.rs', '// 1\n')
    base = await commitAll(work, 'base')
    await put(work, 'crates/logs/src/a.rs', '// 2\n')
    logsCommit = await commitAll(work, 'logs: rotate segments')
    await put(work, 'crates/logs/src/a.rs', '// 3\n')
    await put(work, 'crates/core/src/b.rs', '// 3\n')
    bothCommit = await commitAll(work, 'both: shared change')
    await put(work, 'README.md', 'hi\n')
    readmeCommit = await commitAll(work, 'docs: readme')
    // Side branch commit merged back with the other side's tree winning: history simplification would hide it.
    await git(work, 'checkout', '-q', '-b', 'side', base)
    await put(work, 'crates/logs/src/side.rs', '// side\n')
    sideCommit = await commitAll(work, 'logs: side branch')
    await git(work, 'checkout', '-q', 'main')
    await git(work, 'merge', '-q', '--no-ff', '-s', 'ours', '-m', 'merge side', 'side')
    cacheDir = join(dir, 'cache.git')
    await git(dir, 'clone', '-q', '--bare', work, cacheDir)
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const config = (
    reviewed: SyncConfig['reviewed'] = [],
    crates = [entry('logs', 'crates/logs', base)],
  ): SyncConfig => ({
    upstream: 'unused',
    crates,
    reviewed,
  })

  it('lists upstream commits since synced_commit that touch a mapped path, ignoring other paths', async () => {
    const pending = await pendingUpstream({ cacheDir, config: config(), ref: 'main' })
    const shas = pending.map((p) => p.commit)
    assert.ok(shas.includes(logsCommit))
    assert.ok(!shas.includes(readmeCommit))
    assert.equal(pending.find((p) => p.commit === logsCommit)?.crate, 'logs')
    assert.equal(pending.find((p) => p.commit === logsCommit)?.subject, 'logs: rotate segments')
  })

  it('a commit recorded as reviewed is not pending', async () => {
    const reviewed = [{ commit: logsCommit, crate: 'logs', decision: 'ported', reason: 'done' }]
    const pending = await pendingUpstream({ cacheDir, config: config(reviewed), ref: 'main' })
    assert.ok(!pending.some((p) => p.commit === logsCommit))
  })

  it('lists a side-branch commit that a merge hides from simplified history', async () => {
    const pending = await pendingUpstream({ cacheDir, config: config(), ref: 'main' })
    assert.ok(pending.some((p) => p.commit === sideCommit))
  })

  it('lists a commit touching two mapped crates once per crate', async () => {
    const crates = [entry('logs', 'crates/logs', base), entry('core', 'crates/core', base)]
    const pending = await pendingUpstream({ cacheDir, config: config([], crates), ref: 'main' })
    assert.deepEqual(
      pending
        .filter((p) => p.commit === bothCommit)
        .map((p) => p.crate)
        .sort(),
      ['core', 'logs'],
    )
  })

  it('maps a single file as an upstream path', async () => {
    const pending = await pendingUpstream({
      cacheDir,
      config: config([], [entry('b', 'crates/core/src/b.rs', base)]),
      ref: 'main',
    })
    const shas = pending.map((p) => p.commit)
    assert.ok(shas.includes(bothCommit))
    assert.ok(!shas.includes(logsCommit))
  })

  it('fails when a mapped path does not exist at the ref', async () => {
    await assert.rejects(
      pendingUpstream({ cacheDir, config: config([], [entry('x', 'crates/typo', base)]), ref: 'main' }),
      /crates\/typo does not exist upstream/,
    )
  })

  it('fails when upstream renames a mapped directory', async () => {
    const clone = join(dir, 'renamed.git')
    await git(dir, 'clone', '-q', work, join(dir, 'renamed-work'))
    const renamedWork = join(dir, 'renamed-work')
    await git(renamedWork, 'mv', 'crates/logs', 'crates/logs2')
    await commitAll(renamedWork, 'rename logs')
    await git(dir, 'clone', '-q', '--bare', renamedWork, clone)
    await assert.rejects(pendingUpstream({ cacheDir: clone, config: config(), ref: 'HEAD' }), /does not exist upstream/)
  })

  it('distinguishes a missing cache and an unknown synced_commit', async () => {
    await assert.rejects(
      pendingUpstream({ cacheDir: join(dir, 'nope'), config: config(), ref: 'main' }),
      /cache missing: run pnpm devlanes-sync --fetch/,
    )
    const unknown = 'f'.repeat(40)
    await assert.rejects(
      pendingUpstream({ cacheDir, config: config([], [entry('logs', 'crates/logs', unknown)]), ref: 'main' }),
      /synced_commit .* is not in the devlanes cache/,
    )
  })

  it('rejects reviewed shas that are not in the cache', async () => {
    const reviewed = [{ commit: 'e'.repeat(40), crate: 'logs', decision: 'ported', reason: 'x' }]
    await assert.rejects(pendingUpstream({ cacheDir, config: config(reviewed), ref: 'main' }), /reviewed commit/)
  })

  it('validates the config', () => {
    const ok = `upstream = "u"
[[crate]]
name = "a"
upstream_path = "crates/a"
synced_commit = "abc"
[[reviewed]]
commit = "def"
crate = "a"
decision = "not_applicable"
reason = "x"
`
    const parsed = parseSyncConfig(ok)
    assert.equal(parsed.crates[0]?.upstreamPath, 'crates/a')
    assert.equal(parsed.reviewed[0]?.decision, 'not_applicable')
    assert.throws(() => parseSyncConfig(ok.replace('not_applicable', 'maybe')), /decision/)
    assert.throws(() => parseSyncConfig(ok.replace('crate = "a"', 'crate = "zzz"')), /unknown crate/)
  })

  it('treats a cache fetched more than 7 days ago as stale', async () => {
    const fresh = join(dir, 'fresh.git')
    await git(dir, 'init', '-q', '--bare', fresh)
    await assert.rejects(assertCacheFresh(fresh), /run pnpm devlanes-sync --fetch/)
    await fetchUpstream(fresh, work)
    await assertCacheFresh(fresh)
    const eightDays = Date.now() + 8 * 24 * 60 * 60 * 1000
    await assert.rejects(assertCacheFresh(fresh, undefined, eightDays), /stale/)
    const remote = await git(fresh, 'remote', 'get-url', 'upstream')
    assert.equal(remote, work)
    await fetchUpstream(fresh, cacheDir)
    assert.equal(await git(fresh, 'remote', 'get-url', 'upstream'), cacheDir)
  })

  it('the CLI exits 1 listing pending commits and 0 once they are reviewed', async () => {
    const root = join(dir, 'cli-root')
    await mkdir(join(root, 'executor'), { recursive: true })
    await git(dir, 'clone', '-q', '--bare', work, join(root, 'executor', '.devlanes-cache'))
    const cache = join(root, 'executor', '.devlanes-cache')
    await git(cache, 'update-ref', 'refs/remotes/upstream/main', 'main')
    const toml = (reviewed: string) =>
      `upstream = "unused"\n[[crate]]\nname = "logs"\nupstream_path = "crates/logs"\nsynced_commit = "${base}"\n${reviewed}`
    await writeFile(join(root, 'executor', 'devlanes-sync.toml'), toml(''))
    const failed = await run('node', [script, '--root', root]).then(
      () => assert.fail('expected exit 1'),
      (error: { code: number; stdout: string }) => error,
    )
    assert.equal(failed.code, 1)
    assert.match(failed.stdout, new RegExp(`${logsCommit} logs logs: rotate segments`))
    assert.match(failed.stdout, /next: port it or add a \[\[reviewed\]\] entry, then advance synced_commit/)
    const all = (await git(cache, 'log', '--full-history', '--format=%H', `${base}..main`, '--', 'crates/logs')).split(
      '\n',
    )
    const reviewed = all
      .map((sha) => `[[reviewed]]\ncommit = "${sha}"\ncrate = "logs"\ndecision = "ported"\nreason = "test"\n`)
      .join('')
    await writeFile(join(root, 'executor', 'devlanes-sync.toml'), toml(reviewed))
    await run('node', [script, '--root', root])
  })

  it('one finding per commit with its crates joined and key devlanes:<sha>', () => {
    const sha = 'a'.repeat(40)
    const findings = findingsOf([
      { commit: sha, subject: 'both: shared change', crate: 'logs' },
      { commit: 'b'.repeat(40), subject: 'logs: rotate', crate: 'logs' },
      { commit: sha, subject: 'both: shared change', crate: 'core' },
    ])
    assert.equal(findings.length, 2)
    assert.equal(findings[0]?.sourceKey, `devlanes:${sha}`)
    assert.equal(findings[0]?.title, 'Port devlanes aaaaaaaaaaaa: both: shared change')
    assert.match(findings[0]?.description ?? '', /logs, core/)
    assert.deepEqual(findings[0]?.criteria, ['ported or recorded as [[reviewed]] in executor/devlanes-sync.toml'])
  })

  it('--open-tasks is green once every commit has a task and red when an open fails', async () => {
    const pending = [
      { commit: 'a'.repeat(40), subject: 's1', crate: 'logs' },
      { commit: 'b'.repeat(40), subject: 's2', crate: 'logs' },
    ]
    const opened: string[] = []
    assert.equal(
      await openPendingTasks(pending, async (f) => {
        opened.push(f.sourceKey)
        return 0
      }),
      true,
    )
    assert.equal(opened.length, 2)
    const attempted: string[] = []
    assert.equal(
      await openPendingTasks(pending, async (f) => {
        attempted.push(f.sourceKey)
        return attempted.length === 1 ? 4 : 0
      }),
      false,
    )
    // A failed open does not stop the others.
    assert.equal(attempted.length, 2)
  })

  it('the real check passes against a fresh cached fetch', async () => {
    const real = join(repoRoot, 'executor', '.devlanes-cache')
    await access(real).catch(() => assert.fail('run pnpm devlanes-sync --fetch'))
    await assertCacheFresh(real)
    const text = await readFile(join(repoRoot, 'executor', 'devlanes-sync.toml'), 'utf8')
    const pending = await pendingUpstream({
      cacheDir: real,
      config: parseSyncConfig(text),
      ref: 'refs/remotes/upstream/main',
    })
    assert.deepEqual(pending, [])
  })
})
