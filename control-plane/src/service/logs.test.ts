import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LogWriter, pruneLogs } from './logs.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function tempDir(): Promise<string> {
  const base = join(root, '.superpowers', 'tmp')
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, 'logs-'))
}

const DAY_MS = 86_400_000

test('pruneLogs removes log files older than the retention and keeps recent ones and other files', async () => {
  const dir = await tempDir()
  try {
    const now = new Date('2026-11-17T12:00:00Z')
    const old = new Date(now.getTime() - 15 * DAY_MS)
    const recent = new Date(now.getTime() - 13 * DAY_MS)
    for (const [name, at] of [
      ['serve-2026-11-01.log', old],
      ['supervisor-2026-11-01.log', old],
      ['serve-2026-11-04.log', recent],
      ['notes.txt', old],
    ] as const) {
      await writeFile(join(dir, name), 'x')
      await utimes(join(dir, name), at, at)
    }
    await pruneLogs(dir, now, 14)
    assert.deepEqual((await readdir(dir)).sort(), ['notes.txt', 'serve-2026-11-04.log'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pruneLogs ignores a missing directory', async () => {
  await pruneLogs(join(root, '.superpowers', 'tmp', 'does-not-exist'), new Date(), 14)
})

test('LogWriter rolls to a new file when one would pass the size cap, and starts over on a new day', async () => {
  const dir = await tempDir()
  try {
    let now = new Date('2026-11-17T23:00:00Z')
    const writer = new LogWriter(dir, 'serve', 10, () => now)
    await writer.write(Buffer.from('123456'))
    await writer.write(Buffer.from('123456'))
    await writer.write(Buffer.from('123'))
    now = new Date('2026-11-18T01:00:00Z')
    await writer.write(Buffer.from('1'))
    assert.deepEqual((await readdir(dir)).sort(), [
      'serve-2026-11-17.1.log',
      'serve-2026-11-17.log',
      'serve-2026-11-18.log',
    ])
    assert.equal((await stat(join(dir, 'serve-2026-11-17.1.log'))).size, 9)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
