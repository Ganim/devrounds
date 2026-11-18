import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { type Kysely, sql, type Transaction } from 'kysely'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import type { Ctx } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { memberCtx } from './members.ts'

export type StoredResponse = { status: number; body: unknown }

type Row = StoredResponse & { fingerprint: string }

// JSON with keys sorted at every level, so two bodies that differ only in key order fingerprint the same.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// SHA-256 over method, URL and body. A string body (the YAML import) is hashed as the raw text it arrived as.
export function fingerprintOf(method: string, url: string, body: unknown): string {
  const text = typeof body === 'string' ? body : body === undefined ? '' : canonical(body)
  return createHash('sha256').update(`${method} ${url}\n${text}`).digest('hex')
}

// Same key + same tenant within 24 h returns the stored response without running the mutation again.
//
// The key row is inserted first and the mutation runs in the same transaction, so the stored response commits
// together with the mutation or not at all. A concurrent duplicate blocks on the primary key until the first one
// ends: after a commit its `on conflict do nothing` inserts nothing and it reads the stored response; after a
// rollback (the mutation failed) it runs the mutation itself. Failed mutations are therefore never stored, which
// is safe because they changed nothing.
//
// The fingerprint (fingerprintOf) catches a client reusing one key for a different call or body: replaying the
// first response would silently drop the second mutation, so that is DR101 instead. Expired rows are only removed
// when their key comes back; a periodic sweep can come later if the table ever matters.
export async function runIdempotent(
  db: Kysely<Database>,
  tenantId: string,
  key: string,
  fingerprint: string,
  mutate: (trx: Transaction<Database>) => Promise<StoredResponse>,
): Promise<StoredResponse> {
  return withTenant(db, tenantId, async (trx) => {
    await trx
      .deleteFrom('idempotency_keys')
      .where('key', '=', key)
      .where('created_at', '<', sql<Date>`now() - interval '24 hours'`)
      .execute()
    const claimed = await trx
      .insertInto('idempotency_keys')
      .values({ tenant_id: tenantId, key, response: JSON.stringify({ fingerprint, status: 0, body: null }) })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst()
    if (!claimed) {
      const row = await trx
        .selectFrom('idempotency_keys')
        .select('response')
        .where('key', '=', key)
        .executeTakeFirstOrThrow()
      const stored = (typeof row.response === 'string' ? JSON.parse(row.response) : row.response) as Row
      if (stored.fingerprint !== fingerprint) {
        fail('DR101', { path: '/Idempotency-Key', reason: 'key reused with a different request' })
      }
      return { status: stored.status, body: stored.body }
    }
    const response = await mutate(trx)
    await trx
      .updateTable('idempotency_keys')
      .set({ response: JSON.stringify({ fingerprint, ...response }) })
      .where('key', '=', key)
      .execute()
    return response
  })
}

// Every member mutation goes through here: without an Idempotency-Key it just runs; with one, the response is stored
// with the mutation (runIdempotent) and replayed for the same key.
export async function mutateIdempotent(
  db: Kysely<Database>,
  request: FastifyRequest,
  reply: FastifyReply,
  run: (ctx: Ctx) => Promise<unknown>,
): Promise<unknown> {
  const ctx = memberCtx(db, request)
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string') return run(ctx)
  const fingerprint = fingerprintOf(request.method, request.url, request.body)
  const stored = await runIdempotent(db, ctx.tenantId, key, fingerprint, async (trx) => ({
    status: 200,
    body: await run({ ...ctx, trx }),
  }))
  return reply.code(stored.status).send(stored.body)
}
