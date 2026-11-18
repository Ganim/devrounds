import { execFile } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'smol-toml'

const run = promisify(execFile)

export type CrateSync = { name: string; upstreamPath: string; syncedCommit: string }
export type Reviewed = { commit: string; crate: string; decision: string; reason: string }
export type SyncConfig = { upstream: string; crates: CrateSync[]; reviewed: Reviewed[] }
export type Pending = { commit: string; subject: string; crate: string }

const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value === '') throw new Error(`devlanes-sync.toml: missing ${field}`)
  return value
}

export function parseSyncConfig(text: string): SyncConfig {
  const raw = parse(text)
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(raw[key]) ? (raw[key] as Record<string, unknown>[]) : []
  return {
    upstream: str(raw.upstream, 'upstream'),
    crates: list('crate').map((c) => ({
      name: str(c.name, 'crate.name'),
      upstreamPath: str(c.upstream_path, 'crate.upstream_path'),
      syncedCommit: str(c.synced_commit, 'crate.synced_commit'),
    })),
    reviewed: list('reviewed').map((r) => ({
      commit: str(r.commit, 'reviewed.commit'),
      crate: str(r.crate, 'reviewed.crate'),
      decision: str(r.decision, 'reviewed.decision'),
      reason: str(r.reason, 'reviewed.reason'),
    })),
  }
}

/**
 * Upstream commits after each crate's `synced_commit` that touch its upstream path and are not
 * recorded as reviewed. Reads only the cache; `fetchUpstream` is what talks to the network.
 */
export async function pendingUpstream(opts: { cacheDir: string; config: SyncConfig; ref: string }): Promise<Pending[]> {
  const pending: Pending[] = []
  for (const crate of opts.config.crates) {
    const { stdout } = await run(
      'git',
      ['log', '--format=%H%x09%s', `${crate.syncedCommit}..${opts.ref}`, '--', crate.upstreamPath],
      { cwd: opts.cacheDir },
    )
    for (const line of stdout.split('\n')) {
      if (line === '') continue
      const tab = line.indexOf('\t')
      const commit = line.slice(0, tab)
      const reviewed = opts.config.reviewed.some((r) => r.crate === crate.name && r.commit === commit)
      if (!reviewed) pending.push({ commit, subject: line.slice(tab + 1), crate: crate.name })
    }
  }
  return pending
}

/** Creates the bare cache when missing, then fetches upstream into `refs/remotes/upstream/*`. */
export async function fetchUpstream(cacheDir: string, upstream: string): Promise<void> {
  const exists = await access(join(cacheDir, 'HEAD')).then(
    () => true,
    () => false,
  )
  if (!exists) {
    await mkdir(cacheDir, { recursive: true })
    await run('git', ['init', '--bare', '-q', cacheDir])
  }
  const remotes = await run('git', ['remote'], { cwd: cacheDir })
  if (!remotes.stdout.split('\n').includes('upstream')) {
    await run('git', ['remote', 'add', 'upstream', upstream], { cwd: cacheDir })
  }
  await run('git', ['fetch', '--quiet', 'upstream', '+refs/heads/*:refs/remotes/upstream/*'], { cwd: cacheDir })
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const cacheDir = join(root, 'executor', '.devlanes-cache')
  const config = parseSyncConfig(await readFile(join(root, 'executor', 'devlanes-sync.toml'), 'utf8'))
  if (process.argv.includes('--fetch')) await fetchUpstream(cacheDir, config.upstream)
  const pending = await pendingUpstream({ cacheDir, config, ref: 'refs/remotes/upstream/main' }).catch(() => {
    throw new Error('devlanes cache missing or empty: run pnpm devlanes-sync --fetch')
  })
  if (pending.length === 0) return
  for (const p of pending) console.log(`${p.commit} ${p.crate} ${p.subject}`)
  console.log('next: port it or add a [[reviewed]] entry, then advance synced_commit')
  process.exitCode = 1
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
