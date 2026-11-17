import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: a synchronous call blocks the event loop for every tenant (MANIFESTO 7). Entries are
// 'path/relative/to/control-plane/src' using '/', and each needs a reason in a comment next to it.
const ALLOWED: string[] = []

const SYNC_CALL = /\b(spawnSync|execSync|execFileSync|\w+Sync)\s*\(/
const ROOT = fileURLToPath(new URL('.', import.meta.url))

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : []
    }),
  )
  return nested.flat()
}

async function filesWithSyncCalls(): Promise<string[]> {
  const files = await sourceFiles(ROOT)
  const hits: string[] = []
  for (const file of files) {
    if (SYNC_CALL.test(await readFile(file, 'utf8'))) hits.push(relative(ROOT, file).split(sep).join('/'))
  }
  return hits.sort()
}

test('control-plane/src has no synchronous child-process or fs calls', async () => {
  const offenders = (await filesWithSyncCalls()).filter((file) => !ALLOWED.includes(file))
  assert.deepEqual(offenders, [], 'use the async API, or add the file to ALLOWED with a reason')
})

test('every ALLOWED entry still contains a synchronous call', async () => {
  const hits = await filesWithSyncCalls()
  const stale = ALLOWED.filter((file) => !hits.includes(file))
  assert.deepEqual(stale, [], 'remove these entries from ALLOWED')
})
