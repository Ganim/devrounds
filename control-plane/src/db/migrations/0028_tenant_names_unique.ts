import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// Admin commands find a tenant by name (admin.ts tenantIdByName), and bootstrap's check for a taken name runs before
// its transaction, so two bootstraps at once could both pass it and leave two tenants of one name. The constraint
// makes the second insert fail (23505), which bootstrap answers like the check. A database that already holds two
// tenants of one name fails this migration; rename one first.
export const tenantNamesUnique: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`alter table tenants add constraint tenants_name_key unique (name)`.execute(db)
  },
}
