import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'smol-toml'
import { defaultConfigPath, runCli } from '../control-plane/src/cli/commands.ts'

const run = promisify(execFile)

export type CrateSync = { name: string; upstreamPath: string; syncedCommit: string }
export type Reviewed = { commit: string; crate: string; decision: string; reason: string }
export type SyncConfig = { upstream: string; crates: CrateSync[]; reviewed: Reviewed[] }
export type Pending = { commit: string; subject: string; crate: string }

const DECISIONS = ['ported', 'not_applicable']
const STAMP = 'devlanes-sync-fetched-at'
export const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000

const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value === '') throw new Error(`devlanes-sync.toml: missing ${field}`)
  return value
}

export function parseSyncConfig(text: string): SyncConfig {
  const raw = parse(text)
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(raw[key]) ? (raw[key] as Record<string, unknown>[]) : []
  const crates = list('crate').map((c) => ({
    name: str(c.name, 'crate.name'),
    upstreamPath: str(c.upstream_path, 'crate.upstream_path'),
    syncedCommit: str(c.synced_commit, 'crate.synced_commit'),
  }))
  const names = new Set(crates.map((c) => c.name))
  if (names.size !== crates.length) throw new Error('devlanes-sync.toml: duplicate crate name')
  const reviewed = list('reviewed').map((r) => ({
    commit: str(r.commit, 'reviewed.commit'),
    crate: str(r.crate, 'reviewed.crate'),
    decision: str(r.decision, 'reviewed.decision'),
    reason: str(r.reason, 'reviewed.reason'),
  }))
  for (const r of reviewed) {
    if (!DECISIONS.includes(r.decision)) {
      throw new Error(
        `devlanes-sync.toml: reviewed ${r.commit} has decision "${r.decision}", expected ported or not_applicable`,
      )
    }
    if (!names.has(r.crate)) {
      throw new Error(`devlanes-sync.toml: reviewed ${r.commit} names unknown crate "${r.crate}"`)
    }
  }
  return { upstream: str(raw.upstream, 'upstream'), crates, reviewed }
}

const gitOk = (cwd: string, ...args: string[]): Promise<boolean> =>
  run('git', args, { cwd }).then(
    () => true,
    () => false,
  )

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

/**
 * Upstream commits after each entry's `synced_commit` that touch its upstream path (directory or
 * single file) and are not recorded as reviewed. Reads only the cache; `fetchUpstream` talks to
 * the network. Fails closed: a missing cache, ref, synced commit, mapped path or reviewed sha
 * throws instead of reporting "nothing pending". If upstream rewrites history, `A..B` lists every
 * commit not reachable from the old base, which is noisy but never silent.
 */
export async function pendingUpstream(opts: { cacheDir: string; config: SyncConfig; ref: string }): Promise<Pending[]> {
  const { cacheDir, config, ref } = opts
  if (!(await exists(join(cacheDir, 'HEAD')))) {
    throw new Error('devlanes cache missing: run pnpm devlanes-sync --fetch')
  }
  if (!(await gitOk(cacheDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`))) {
    throw new Error(`devlanes cache has no ${ref}: run pnpm devlanes-sync --fetch`)
  }
  for (const r of config.reviewed) {
    if (!(await gitOk(cacheDir, 'cat-file', '-e', `${r.commit}^{commit}`))) {
      throw new Error(`reviewed commit ${r.commit} is not in the devlanes cache`)
    }
  }
  const pending: Pending[] = []
  for (const crate of config.crates) {
    if (!(await gitOk(cacheDir, 'cat-file', '-e', `${crate.syncedCommit}^{commit}`))) {
      throw new Error(
        `${crate.name}: synced_commit ${crate.syncedCommit} is not in the devlanes cache (upstream history rewritten?)`,
      )
    }
    if (!(await gitOk(cacheDir, 'cat-file', '-e', `${ref}:${crate.upstreamPath}`))) {
      throw new Error(`${crate.name}: ${crate.upstreamPath} does not exist upstream at ${ref} (moved or renamed?)`)
    }
    // --full-history keeps side-branch commits that a merge would otherwise hide.
    const { stdout } = await run(
      'git',
      ['log', '--full-history', '--format=%H%x09%s', `${crate.syncedCommit}..${ref}`, '--', crate.upstreamPath],
      { cwd: cacheDir },
    )
    const seen = new Set<string>()
    for (const line of stdout.split('\n')) {
      if (line === '') continue
      const tab = line.indexOf('\t')
      const commit = line.slice(0, tab)
      if (seen.has(commit)) continue
      seen.add(commit)
      const reviewed = config.reviewed.some((r) => r.crate === crate.name && r.commit === commit)
      if (!reviewed) pending.push({ commit, subject: line.slice(tab + 1), crate: crate.name })
    }
  }
  return pending
}

/** Creates the bare cache when missing, fetches upstream into `refs/remotes/upstream/*` and stamps the time. */
export async function fetchUpstream(cacheDir: string, upstream: string): Promise<void> {
  if (!(await exists(join(cacheDir, 'HEAD')))) {
    await mkdir(cacheDir, { recursive: true })
    await run('git', ['init', '--bare', '-q', cacheDir])
  }
  const remotes = await run('git', ['remote'], { cwd: cacheDir })
  const verb = remotes.stdout.split('\n').includes('upstream') ? 'set-url' : 'add'
  await run('git', ['remote', verb, 'upstream', upstream], { cwd: cacheDir })
  await run('git', ['fetch', '--quiet', 'upstream', '+refs/heads/*:refs/remotes/upstream/*'], { cwd: cacheDir })
  await writeFile(join(cacheDir, STAMP), new Date().toISOString())
}

/** "Nothing pending" only holds as of the last `--fetch`; fails when that is older than `maxAgeMs`. */
export async function assertCacheFresh(cacheDir: string, maxAgeMs = MAX_CACHE_AGE_MS, now = Date.now()): Promise<void> {
  const stamp = await readFile(join(cacheDir, STAMP), 'utf8').catch(() => '')
  const fetchedAt = Date.parse(stamp)
  if (Number.isNaN(fetchedAt) || now - fetchedAt > maxAgeMs) {
    throw new Error('devlanes cache is stale or was never fetched: run pnpm devlanes-sync --fetch')
  }
}

export type Finding = { sourceKey: string; title: string; description: string; criteria: string[] }

/** One finding per upstream commit (a commit touching two crates is one task), in first-seen order. */
export function findingsOf(pending: Pending[]): Finding[] {
  const byCommit = new Map<string, Pending[]>()
  for (const p of pending) byCommit.set(p.commit, [...(byCommit.get(p.commit) ?? []), p])
  return [...byCommit].map(([commit, entries]) => ({
    sourceKey: `devlanes:${commit}`,
    title: `Port devlanes ${commit.slice(0, 12)}: ${entries[0]?.subject ?? ''}`,
    description: `Upstream devlanes commit ${commit} touches the crates: ${entries.map((e) => e.crate).join(', ')}.`,
    criteria: ['ported or recorded as [[reviewed]] in executor/devlanes-sync.toml'],
  }))
}

/**
 * Opens a finding task per pending commit (an open one is answered, not duplicated). Tries every commit
 * even when one fails, so a single bad open does not hide the rest; true when all of them succeeded.
 */
export async function openPendingTasks(
  pending: Pending[],
  open: (finding: Finding) => Promise<number>,
): Promise<boolean> {
  let ok = true
  for (const finding of findingsOf(pending)) {
    if ((await open(finding)) !== 0) ok = false
  }
  return ok
}

async function openViaCli(finding: Finding): Promise<number> {
  const argv = ['task', 'open-finding', '--source-key', finding.sourceKey, '--title', finding.title]
  argv.push('--description', finding.description)
  for (const criterion of finding.criteria) argv.push('--criterion', criterion)
  const { exitCode, stdout, stderr } = await runCli(argv, { env: process.env, configPath: defaultConfigPath() })
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  return exitCode
}

async function main(): Promise<void> {
  const rootArg = process.argv.indexOf('--root')
  const root = rootArg >= 0 ? (process.argv[rootArg + 1] ?? '') : fileURLToPath(new URL('..', import.meta.url))
  const cacheDir = join(root, 'executor', '.devlanes-cache')
  const config = parseSyncConfig(await readFile(join(root, 'executor', 'devlanes-sync.toml'), 'utf8'))
  if (process.argv.includes('--fetch')) await fetchUpstream(cacheDir, config.upstream)
  const pending = await pendingUpstream({ cacheDir, config, ref: 'refs/remotes/upstream/main' })
  if (pending.length === 0) return
  for (const p of pending) console.log(`${p.commit} ${p.crate} ${p.subject}`)
  console.log('next: port it or add a [[reviewed]] entry, then advance synced_commit')
  process.exitCode = process.argv.includes('--open-tasks') ? ((await openPendingTasks(pending, openViaCli)) ? 0 : 1) : 1
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
