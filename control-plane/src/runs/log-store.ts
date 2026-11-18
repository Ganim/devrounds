import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress as zstdDecompressCallback } from 'node:zlib'
import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { findProject, run, type TenantCtx } from '../planning/resolve.ts'
import { withTenant } from '../tenancy/scope.ts'
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
    // Zero-padded so a directory listing sorts like the seqs.
    const path = join(ctx.logsRoot, 'runs', ctx.tenantId, runId, `${String(segment.first_seq).padStart(20, '0')}.zst`)
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
        records: segment.records,
        bytes: bytes.length,
        path,
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
 * are read one at a time, so what this holds is one segment plus the page. A segment file already pruned is skipped.
 * With `projectKey`, a run of another project answers DR201 as if it did not exist.
 */
export async function readRunLog(
  ctx: TenantCtx,
  runId: string,
  opts: { cursor?: bigint; maxBytes: number; projectKey?: string },
): Promise<LogPage> {
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
      .select(['first_seq', 'path'])
      .where('run_id', '=', runId)
      .where('last_seq', '>=', String(start))
      .orderBy('first_seq')
      .execute()
  })
  const lines: LogLine[] = []
  let used = 0
  for (const segment of segments) {
    let compressed: Buffer
    try {
      compressed = await readFile(segment.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    const text = (await zstdDecompress(compressed)).toString('utf8')
    for (const json of text.split('\n')) {
      if (json === '') continue
      const line = JSON.parse(json) as StoredLine
      if (BigInt(line.seq) < start) continue
      const size = Buffer.byteLength(line.text) + 1
      if (lines.length > 0 && used + size > opts.maxBytes) return { lines, nextCursor: BigInt(line.seq) }
      used += size
      lines.push({ seq: line.seq, timestampMs: line.timestamp_ms, text: line.text, level: line.level })
    }
  }
  return { lines, nextCursor: null }
}

/**
 * Deletes every segment created more than `retentionDays` before `now`, row and file; returns how many. The expired
 * rows of all tenants come from expired_log_segments (0006); each tenant's are deleted inside that tenant, and the
 * files only once the delete committed, so a failed delete never leaves a row without its file.
 */
export async function pruneLogSegments(db: Kysely<Database>, now: Date, retentionDays: number): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const { rows } = await sql<{ tenant_id: string; id: string; path: string }>`
    select tenant_id, id, path from expired_log_segments(${cutoff})`.execute(db)
  const byTenant = new Map<string, string[]>()
  for (const row of rows) byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), row.id])
  let pruned = 0
  for (const [tenantId, ids] of byTenant) {
    const deleted = await withTenant(db, tenantId, (trx) =>
      trx.deleteFrom('log_segments').where('id', 'in', ids).returning('path').execute(),
    )
    for (const { path } of deleted) await rm(path, { force: true })
    pruned += deleted.length
  }
  return pruned
}
