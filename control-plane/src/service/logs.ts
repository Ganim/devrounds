import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// Same default as the executor's log retention.
export const KEEP_DAYS = 14
// One serve can run for weeks, so its output is capped per file instead of per day.
export const MAX_LOG_BYTES = 10 * 1024 * 1024

// Serve output waiting for the disk; beyond this the oldest chunks are dropped instead of growing memory.
export const MAX_PENDING_BYTES = 1024 * 1024

// A chunk without a trailing newline still counts as one line.
const countLines = (data: Buffer): number => Math.max(1, data.toString('utf8').split('\n').length - 1)

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
  private readonly maxPendingBytes: number
  private pending: Buffer[] = []
  private pendingBytes = 0
  private dropped = 0
  private draining: Promise<void> | null = null

  // onRoll fires on the first write of a new UTC day and when a file rolls on size: a supervisor that stays up for
  // weeks is the one that needs pruning at those moments, since it never restarts.
  constructor(
    dir: string,
    name: string,
    maxBytes: number,
    clock: () => Date = () => new Date(),
    onRoll: () => void = () => {},
    maxPendingBytes: number = MAX_PENDING_BYTES,
  ) {
    this.dir = dir
    this.name = name
    this.maxBytes = maxBytes
    this.clock = clock
    this.onRoll = onRoll
    this.maxPendingBytes = maxPendingBytes
  }

  // For a stream that cannot wait on the disk (child output): chunks beyond maxPendingBytes are dropped oldest first
  // and the next successful write starts with a "[N lines dropped]" line.
  enqueue(data: Buffer): void {
    this.pending.push(data)
    this.pendingBytes += data.length
    while (this.pendingBytes > this.maxPendingBytes && this.pending.length > 0) {
      const oldest = this.pending.shift() as Buffer
      this.pendingBytes -= oldest.length
      this.dropped += countLines(oldest)
    }
    this.draining ??= this.drain()
  }

  flush(): Promise<void> {
    return this.draining ?? Promise.resolve()
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = Buffer.concat(this.pending)
      this.pending = []
      this.pendingBytes = 0
      const dropped = this.dropped
      this.dropped = 0
      const marker = dropped > 0 ? Buffer.from(`[${dropped} lines dropped]\n`) : Buffer.alloc(0)
      try {
        await this.write(Buffer.concat([marker, batch]))
      } catch {
        this.dropped += dropped + countLines(batch)
      }
    }
    this.draining = null
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
      this.onRoll()
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

// Logging is best effort: a full disk or a locked file must never take the supervisor down.
export async function safely(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch {
    // Nowhere left to report it.
  }
}
