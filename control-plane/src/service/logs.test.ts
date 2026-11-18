import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LogWriter, pruneLogs, safely } from './logs.ts'

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

test('safely swallows a log write that fails, so the supervisor keeps running', async () => {
  const dir = await tempDir()
  try {
    // A file where the log directory should be makes every append fail.
    const blocked = join(dir, 'file')
    await writeFile(blocked, 'x')
    const writer = new LogWriter(join(blocked, 'logs'), 'supervisor', 1024)
    await assert.rejects(writer.write(Buffer.from('x')))
    await safely(() => writer.write(Buffer.from('x')))
    await safely(() => pruneLogs(blocked, new Date(), 14))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a long-lived writer prunes expired files when the day changes, without a restart', async () => {
  const dir = await tempDir()
  try {
    let now = new Date('2026-11-01T10:00:00Z')
    const writer = new LogWriter(
      dir,
      'serve',
      1024,
      () => now,
      () => void pruneLogs(dir, now, 14),
    )
    await writer.write(Buffer.from('first day\n'))
    const old = new Date('2026-11-01T10:00:00Z')
    await utimes(join(dir, 'serve-2026-11-01.log'), old, old)

    now = new Date('2026-11-20T10:00:00Z')
    await writer.write(Buffer.from('much later\n'))
    assert.deepEqual(await readdir(dir), ['serve-2026-11-20.log'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('enqueue keeps at most the cap in memory while a write is stalled and notes what it dropped', async () => {
  const dir = await tempDir()
  try {
    const writer = new LogWriter(dir, 'serve', 1024, undefined, undefined, 30)
    // The first chunk goes in flight; the rest pile up behind it before any write finishes.
    for (let i = 0; i < 10; i++) writer.enqueue(Buffer.from(`line-${i}\n`))
    await writer.flush()
    const text = await readFile(join(dir, (await readdir(dir))[0] as string), 'utf8')
    assert.equal(text, 'line-0\n[5 lines dropped]\nline-6\nline-7\nline-8\nline-9\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
