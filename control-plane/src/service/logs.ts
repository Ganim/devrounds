import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// Same default as the executor's log retention.
export const KEEP_DAYS = 14
// One serve can run for weeks, so its output is capped per file instead of per day.
export const MAX_LOG_BYTES = 10 * 1024 * 1024

const LOG_NAME = /^(supervisor|serve)-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/

export async function pruneLogs(dir: string, now: Date, keepDays: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const cutoff = now.getTime() - keepDays * 86_400_000
  for (const name of names) {
    if (!LOG_NAME.test(name)) continue
    const path = join(dir, name)
    try {
      if ((await stat(path)).mtimeMs < cutoff) await unlink(path)
    } catch {
      // Gone already, or held open by a serve that is still writing; the next prune retries.
    }
  }
}

// Appends to `<name>-<UTC day>.log`, moving to `<name>-<day>.<n>.log` before a write that would pass maxBytes.
// Writes are chained so concurrent chunks keep their order and the size count stays exact.
export class LogWriter {
  private day = ''
  private seq = 0
  private size = 0
  private queue: Promise<void> = Promise.resolve()
  private readonly dir: string
  private readonly name: string
  private readonly maxBytes: number
  private readonly clock: () => Date
  private readonly onRoll: () => void

  constructor(
    dir: string,
    name: string,
    maxBytes: number,
    clock: () => Date = () => new Date(),
    onRoll: () => void = () => {},
  ) {
    this.dir = dir
    this.name = name
    this.maxBytes = maxBytes
    this.clock = clock
    this.onRoll = onRoll
  }

  write(data: Buffer): Promise<void> {
    const result = this.queue.then(() => this.append(data))
    this.queue = result.catch(() => {})
    return result
  }

  private async append(data: Buffer): Promise<void> {
    const day = this.clock().toISOString().slice(0, 10)
    if (day !== this.day) {
      this.day = day
      this.seq = 0
      this.size = await this.currentSize()
    }
    if (this.size > 0 && this.size + data.length > this.maxBytes) {
      this.seq += 1
      this.size = await this.currentSize()
      this.onRoll()
    }
    await mkdir(this.dir, { recursive: true })
    await appendFile(this.path(), data)
    this.size += data.length
  }

  private path(): string {
    const suffix = this.seq === 0 ? '' : `.${this.seq}`
    return join(this.dir, `${this.name}-${this.day}${suffix}.log`)
  }

  private async currentSize(): Promise<number> {
    try {
      return (await stat(this.path())).size
    } catch {
      return 0
    }
  }
}
