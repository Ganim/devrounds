import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'

const EXECUTOR = fileURLToPath(new URL('../../executor/', import.meta.url))
const SYNC_COMMIT = 'e2e4f1ca'
// The FFI modules of sys-windows are the one accepted place for lint allows (AGENTS.md).
const ALLOWED = new Set(['crates/sys-windows/src/lib.rs'])
// Built by concatenation so this file does not match itself.
const ALLOW = new RegExp(`#!?\\[${'allow'}\\(|#\\[${'expect'}\\(`)

type SyncCrate = { name: string; upstream_path: string; synced_commit: string }

async function rustFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'target' ? [] : rustFiles(path)
      return entry.name.endsWith('.rs') ? [path] : []
    }),
  )
  return nested.flat()
}

test('NOTICE names every crate of devlanes-sync.toml with its upstream path and commit', async () => {
  const notice = await readFile(join(EXECUTOR, 'NOTICE'), 'utf8')
  const sync = parse(await readFile(join(EXECUTOR, 'devlanes-sync.toml'), 'utf8')) as { crate?: SyncCrate[] }
  const crates = sync.crate ?? []
  assert.ok(crates.length > 0, 'devlanes-sync.toml lists no crate')
  for (const { name, upstream_path: upstreamPath } of crates) {
    assert.match(notice, new RegExp(`${name}.*${upstreamPath}.*${SYNC_COMMIT}`, 's'))
  }
})

test('rust code allows lints only in the accepted list', async () => {
  const offenders: string[] = []
  for (const file of await rustFiles(EXECUTOR)) {
    const path = relative(EXECUTOR, file).split(sep).join('/')
    if (!ALLOWED.has(path) && ALLOW.test(await readFile(file, 'utf8'))) offenders.push(path)
  }
  assert.deepEqual(offenders, [], 'fix the code instead of allowing the lint')
})
