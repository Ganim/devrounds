import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress as zstdDecompressCallback } from 'node:zlib'
import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { findProject, run, type TenantCtx } from '../planning/resolve.ts'
import { withTenant } from '../tenancy/scope.ts'
import { int4 } from './int-columns.ts'
import { requireRunId } from './view.ts'

const zstdDecompress = promisify(zstdDecompressCallback)

// A run's output lives in segment files on the control plane's disk, `<logsRoot>/runs/<tenant>/<run>/<first_seq>`,
// and in log_segments rows that index them by the run's line seqs. Each file is what the executor shipped: zstd JSON
// lines, one devrounds-logs LogLine per line. The executor numbers a run's lines 1, 2, ... with no gaps.

export type LogCtx = TenantCtx & { logsRoot: string }
/** A LogSegment event's payload. */
export type SegmentInput = { first_seq: number; last_seq: number; records: number; zstd_base64: string }
export type LogLine = { seq: number; timestampMs: number; text: string; level: string | null }
/** `nextCursor` is the seq of the first line left out, or null when the page reached the end of the log. */
export type LogPage = { lines: LogLine[]; nextCursor: bigint | null }

/** What one segment may decompress to. A 1 MiB executor segment is a few MiB of JSON lines at worst. */
export const SEGMENT_READ_BOUND = 16 * 1024 * 1024
/** Segment ids one prune delete names. */
const PRUNE_BATCH = 1000

type Warn = { warn(data: Record<string, unknown>, message: string): void }
const emitWarning: Warn = { warn: (data, message) => process.emitWarning(`${message} ${JSON.stringify(data)}`) }

/** A segment's path relative to the logs root, as log_segments.path keeps it. Zero-padded, so a listing sorts by seq. */
function segmentName(tenantId: string, runId: string, firstSeq: number): string {
  return join('runs', tenantId, runId, `${String(firstSeq).padStart(20, '0')}.zst`)
}

/**
 * Where segment `firstSeq` of run `runId` lives. Always derived from the ids and `logsRoot`, never read back from
 * log_segments.path: the root can move, and a path from the database must never decide which file is removed.
 */
export function segmentFile(logsRoot: string, tenantId: string, runId: string, firstSeq: number): string {
  return join(logsRoot, segmentName(tenantId, runId, firstSeq))
}

// The executor's LogLine as it serializes it.
type StoredLine = { seq: number; timestamp_ms: number; text: string; level: string | null }

/**
 * Stores one segment of run `runId`: the file first (written as `.part`, then renamed, so a reader never sees half a
 * file), then its row, and moves runs.log_cursor to the segment's last seq. A segment whose first_seq is already
 * stored is a no-op: the executor resends events after a lost Ack. With `machineId`, a run of another machine is
 * DR201, as for every other executor event.
 */
export async function storeSegment(
  ctx: LogCtx,
  runId: string,
  segment: SegmentInput,
  opts: { machineId?: string } = {},
): Promise<void> {
  requireRunId(runId)
  if (segment.last_seq < segment.first_seq) {
    fail('DR101', { path: '/event/last_seq', reason: 'must not be below first_seq' })
  }
  await run(ctx, async (trx) => {
    const found = await trx
      .selectFrom('runs')
      .select('id')
      .where('id', '=', runId)
      .$if(opts.machineId !== undefined, (query) => query.where('machine_id', '=', opts.machineId as string))
      .forNoKeyUpdate()
      .executeTakeFirst()
    if (!found) fail('DR201', { kind: 'run', key: runId })
    const known = await trx
      .selectFrom('log_segments')
      .select('id')
      .where('run_id', '=', runId)
      .where('first_seq', '=', String(segment.first_seq))
      .executeTakeFirst()
    if (known) return
    const bytes = Buffer.from(segment.zstd_base64, 'base64')
    const path = segmentFile(ctx.logsRoot, ctx.tenantId, runId, segment.first_seq)
    await mkdir(dirname(path), { recursive: true })
    // A rolled-back transaction leaves the file; the resent segment overwrites it with the same name.
    await writeFile(`${path}.part`, bytes)
    await rename(`${path}.part`, path)
    await trx
      .insertInto('log_segments')
      .values({
        tenant_id: ctx.tenantId,
        run_id: runId,
        first_seq: segment.first_seq,
        last_seq: segment.last_seq,
        records: int4(segment.records),
        bytes: bytes.length,
        // For people reading the table; code derives the file with segmentFile.
        path: segmentName(ctx.tenantId, runId, segment.first_seq),
      })
      .execute()
    await trx
      .updateTable('runs')
      .set({ log_cursor: sql`greatest(coalesce(log_cursor, 0), ${String(segment.last_seq)}::bigint)` })
      .where('id', '=', runId)
      .execute()
  })
}

/**
 * The lines of run `runId` from seq `cursor` on (from the start without one), cut at a whole line once they pass
 * `maxBytes` (UTF-8 text plus a newline each); the first line always fits, so paging always moves forward. Segments
 * are read one at a time, each bounded by SEGMENT_READ_BOUND, so what this holds is one segment plus the page. A
 * segment whose file is missing is skipped with a warning to `log`; one that does not decompress within the bound, or
 * is not JSON lines, is DR503 naming the cursor past it, so a reader can go on.
 * With `projectKey`, a run of another project answers DR201 as if it did not exist.
 */
export async function readRunLog(
  ctx: LogCtx,
  runId: string,
  opts: { cursor?: bigint; maxBytes: number; projectKey?: string; log?: Warn },
): Promise<LogPage> {
  const log = opts.log ?? emitWarning
  requireRunId(runId)
  const start = opts.cursor ?? 0n
  const segments = await run(ctx, async (trx) => {
    const projectId = opts.projectKey === undefined ? undefined : (await findProject(trx, opts.projectKey)).id
    const found = await trx
      .selectFrom('runs')
      .select('id')
      .where('id', '=', runId)
      .$if(projectId !== undefined, (query) => query.where('project_id', '=', projectId as string))
      .executeTakeFirst()
    if (!found) fail('DR201', { kind: 'run', key: runId })
    return trx
      .selectFrom('log_segments')
      .select(['first_seq', 'last_seq'])
      .where('run_id', '=', runId)
      .where('last_seq', '>=', String(start))
      .orderBy('first_seq')
      .execute()
  })
  const lines: LogLine[] = []
  let used = 0
  for (const segment of segments) {
    // Exact as numbers: the protocol refuses any seq past 2^53 (executor/protocol.ts).
    const firstSeq = Number(segment.first_seq)
    const lastSeq = Number(segment.last_seq)
    let compressed: Buffer
    try {
      compressed = await readFile(segmentFile(ctx.logsRoot, ctx.tenantId, runId, firstSeq))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      log.warn({ run: runId, firstSeq, lastSeq }, 'log segment file is missing; its lines are skipped')
      continue
    }
    let stored: StoredLine[]
    try {
      const text = (await zstdDecompress(compressed, { maxOutputLength: SEGMENT_READ_BOUND })).toString('utf8')
      stored = text
        .split('\n')
        .filter((json) => json !== '')
        .map((json) => JSON.parse(json) as StoredLine)
    } catch (err) {
      // Good lines already read go out first; the next page, from this segment, reports it.
      if (lines.length > 0) return { lines, nextCursor: BigInt(firstSeq) }
      const reason = (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 'larger than 16 MiB' : String(err)
      fail('DR503', { run: runId, firstSeq, lastSeq, reason, next: lastSeq + 1 })
    }
    for (const line of stored) {
      if (BigInt(line.seq) < start) continue
      const size = Buffer.byteLength(line.text) + 1
      if (lines.length > 0 && used + size > opts.maxBytes) return { lines, nextCursor: BigInt(line.seq) }
      used += size
      lines.push({ seq: line.seq, timestampMs: line.timestamp_ms, text: line.text, level: line.level })
    }
  }
  return { lines, nextCursor: null }
}

/** The lines of one shipped segment (a LogSegment event's zstd_base64), decompressed within SEGMENT_READ_BOUND. */
export async function segmentLines(zstdBase64: string): Promise<LogLine[]> {
  const text = (
    await zstdDecompress(Buffer.from(zstdBase64, 'base64'), { maxOutputLength: SEGMENT_READ_BOUND })
  ).toString('utf8')
  return text
    .split('\n')
    .filter((json) => json !== '')
    .map((json) => {
      const line = JSON.parse(json) as StoredLine
      return { seq: line.seq, timestampMs: line.timestamp_ms, text: line.text, level: line.level }
    })
}

/**
 * Deletes every segment created more than `retentionDays` before `now`, row and file; returns how many. The expired
 * rows of all tenants come from expired_log_segments (0006); each tenant's are deleted inside that tenant, and the
 * files only once the delete committed, so a failed delete never leaves a row without its file.
 */
export async function pruneLogSegments(
  db: Kysely<Database>,
  logsRoot: string,
  now: Date,
  retentionDays: number,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const { rows } = await sql<{ tenant_id: string; id: string }>`
    select tenant_id, id from expired_log_segments(${cutoff})`.execute(db)
  const byTenant = new Map<string, string[]>()
  for (const row of rows) {
    const ids = byTenant.get(row.tenant_id)
    if (ids) ids.push(row.id)
    else byTenant.set(row.tenant_id, [row.id])
  }
  let pruned = 0
  for (const [tenantId, ids] of byTenant) {
    // One statement binds at most 65535 parameters.
    for (let at = 0; at < ids.length; at += PRUNE_BATCH) {
      const batch = ids.slice(at, at + PRUNE_BATCH)
      const deleted = await withTenant(db, tenantId, (trx) =>
        trx.deleteFrom('log_segments').where('id', 'in', batch).returning(['run_id', 'first_seq']).execute(),
      )
      for (const row of deleted) {
        // Number is exact: the protocol caps seqs at 2^53.
        await rm(segmentFile(logsRoot, tenantId, row.run_id, Number(row.first_seq)), { force: true })
      }
      pruned += deleted.length
    }
  }
  return pruned
}
