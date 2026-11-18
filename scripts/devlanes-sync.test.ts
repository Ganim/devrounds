import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseSyncConfig, pendingUpstream, type SyncConfig } from './devlanes-sync.ts'

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  )
  return stdout.trim()
}

describe('pendingUpstream', () => {
  let dir: string
  let cacheDir: string
  let base: string
  let logsCommit: string
  let readmeCommit: string

  before(async () => {
    await mkdir(join(repoRoot, '.superpowers', 'tmp'), { recursive: true })
    dir = await mkdtemp(join(repoRoot, '.superpowers', 'tmp', 'x-'))
    const work = join(dir, 'work')
    await mkdir(join(work, 'crates', 'logs', 'src'), { recursive: true })
    await git(dir, 'init', '-q', '-b', 'main', work)
    await writeFile(join(work, 'crates', 'logs', 'src', 'a.rs'), '// 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-q', '-m', 'base')
    base = await git(work, 'rev-parse', 'HEAD')
    await writeFile(join(work, 'crates', 'logs', 'src', 'a.rs'), '// 2\n')
    await git(work, 'commit', '-q', '-am', 'logs: rotate segments')
    logsCommit = await git(work, 'rev-parse', 'HEAD')
    await writeFile(join(work, 'README.md'), 'hi\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-q', '-m', 'docs: readme')
    readmeCommit = await git(work, 'rev-parse', 'HEAD')
    cacheDir = join(dir, 'cache.git')
    await git(dir, 'clone', '-q', '--bare', work, cacheDir)
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const config = (reviewed: SyncConfig['reviewed'] = []): SyncConfig => ({
    upstream: 'unused',
    crates: [{ name: 'logs', upstreamPath: 'crates/logs', syncedCommit: base }],
    reviewed,
  })

  it('lists upstream commits since synced_commit that touch a mapped path', async () => {
    const pending = await pendingUpstream({ cacheDir, config: config(), ref: 'main' })
    assert.deepEqual(pending, [{ commit: logsCommit, subject: 'logs: rotate segments', crate: 'logs' }])
  })

  it('a commit recorded as reviewed is not pending', async () => {
    const reviewed = [{ commit: logsCommit, crate: 'logs', decision: 'ported', reason: 'done' }]
    assert.deepEqual(await pendingUpstream({ cacheDir, config: config(reviewed), ref: 'main' }), [])
  })

  it('commits outside mapped paths are ignored', async () => {
    const pending = await pendingUpstream({ cacheDir, config: config(), ref: 'main' })
    assert.ok(!pending.some((p) => p.commit === readmeCommit))
  })

  it('parses the sync config', () => {
    const parsed = parseSyncConfig(`upstream = "u"
[[crate]]
name = "a"
upstream_path = "crates/a"
synced_commit = "abc"
[[reviewed]]
commit = "def"
crate = "a"
decision = "not_applicable"
reason = "x"
`)
    assert.equal(parsed.crates[0]?.upstreamPath, 'crates/a')
    assert.equal(parsed.reviewed[0]?.decision, 'not_applicable')
  })

  it('the real check passes against the cached fetch', async () => {
    const real = join(repoRoot, 'executor', '.devlanes-cache')
    await access(real).catch(() => assert.fail('run pnpm devlanes-sync --fetch'))
    const text = await readFile(join(repoRoot, 'executor', 'devlanes-sync.toml'), 'utf8')
    const pending = await pendingUpstream({
      cacheDir: real,
      config: parseSyncConfig(text),
      ref: 'refs/remotes/upstream/main',
    })
    assert.deepEqual(pending, [])
  })
})
