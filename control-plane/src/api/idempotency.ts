import { type Kysely, sql, type Transaction } from 'kysely'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { withTenant } from '../tenancy/scope.ts'

export type StoredResponse = { status: number; body: unknown }

type Row = StoredResponse & { request: string }

// Same key + same tenant within 24 h returns the stored response without running the mutation again.
//
// The key row is inserted first and the mutation runs in the same transaction, so the stored response commits
// together with the mutation or not at all. A concurrent duplicate blocks on the primary key until the first one
// ends: after a commit its `on conflict do nothing` inserts nothing and it reads the stored response; after a
// rollback (the mutation failed) it runs the mutation itself. Failed mutations are therefore never stored, which
// is safe because they changed nothing.
//
// `request` (method and path) guards against a client reusing one key for a different call. Expired rows are only
// removed when their key comes back; a periodic sweep can come later if the table ever matters.
export async function runIdempotent(
  db: Kysely<Database>,
  tenantId: string,
  key: string,
  request: string,
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
      .values({ tenant_id: tenantId, key, response: JSON.stringify({ request, status: 0, body: null }) })
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
      if (stored.request !== request) {
        fail('DR101', { path: 'Idempotency-Key', reason: `the key was already used for ${stored.request}` })
      }
      return { status: stored.status, body: stored.body }
    }
    const response = await mutate(trx)
    await trx
      .updateTable('idempotency_keys')
      .set({ response: JSON.stringify({ request, ...response }) })
      .where('key', '=', key)
      .execute()
    return response
  })
}
