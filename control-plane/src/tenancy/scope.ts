import { type Kysely, sql, type Transaction } from 'kysely'
import type { Database } from '../db/schema.ts'

// The only door to tenant data: RLS policies read app.tenant_id, and is_local=true clears it when the
// transaction ends, so a pooled connection never carries one tenant into the next request.
export function withTenant<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx)
    return fn(trx)
  })
}
