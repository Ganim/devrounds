import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { parse } from 'smol-toml'
import { EXECUTOR, rustFiles } from './test-support/rust-files.ts'

const SYNC_COMMIT = 'e2e4f1ca'
// The FFI modules of sys-windows are the one accepted place for lint allows (AGENTS.md).
const ALLOWED = new Set(['crates/sys-windows/src/lib.rs'])
// Built by concatenation so this file does not match itself.
const ALLOW = new RegExp(`#!?\\[${'allow'}\\(|#\\[${'expect'}\\(`)

type SyncCrate = { name: string; upstream_path: string; synced_commit: string }

test('NOTICE names every crate of devlanes-sync.toml with its upstream path and commit', async () => {
  const notice = await readFile(join(EXECUTOR, 'NOTICE'), 'utf8')
  const sync = parse(await readFile(join(EXECUTOR, 'devlanes-sync.toml'), 'utf8')) as { crate?: SyncCrate[] }
  const crates = sync.crate ?? []
  assert.ok(crates.length > 0, 'devlanes-sync.toml lists no crate')
  for (const { name, upstream_path: upstreamPath } of crates) {
    assert.match(notice, new RegExp(`${name}.*${upstreamPath}.*${SYNC_COMMIT}`, 's'))
  }
})

// sys-windows spawn is the one place that starts processes, hidden and inside a job. The test fixtures are test
// programs, and tests/ may use std's Command: neither ships.
const SPAWN = /std::process::Command|tokio::process::Command|Command::new\(/

test('executor starts processes only through sys-windows spawn', async () => {
  const offenders: string[] = []
  for (const file of await rustFiles()) {
    const path = relative(EXECUTOR, file).split(sep).join('/')
    if (!path.split('/').includes('src') || path.startsWith('crates/test-fixtures/')) continue
    if (SPAWN.test(await readFile(file, 'utf8'))) offenders.push(path)
  }
  assert.deepEqual(offenders, [], 'start processes with devrounds_sys_windows::spawn::spawn')
})

test('rust code allows lints only in the accepted list', async () => {
  const offenders: string[] = []
  for (const file of await rustFiles()) {
    const path = relative(EXECUTOR, file).split(sep).join('/')
    if (!ALLOWED.has(path) && ALLOW.test(await readFile(file, 'utf8'))) offenders.push(path)
  }
  assert.deepEqual(offenders, [], 'fix the code instead of allowing the lint')
})
