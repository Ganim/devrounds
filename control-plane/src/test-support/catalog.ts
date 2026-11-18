import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/schema.ts'

// Catalog guards: each returns the offending names, so a test asserts `deepEqual(rows, [])` and a failure lists them.
// They take a schema so a test can plant a bad table in a throwaway schema without disturbing parallel test files.

// Why: a new table without forced RLS and the tenant policy leaks every tenant through the app role. The policy name
// alone proves nothing, so the USING and WITH CHECK expressions are compared too.
export async function tablesWithoutTenantPolicy(db: Kysely<Database>, schema = 'public'): Promise<string[]> {
  // pg_policies prints the stored expression in Postgres' own normal form (explicit casts, upper-case NULLIF), not
  // as migrations/0001_core.ts wrote it. `tenants` is the one table keyed by `id`.
  const expected = (column: string) =>
    `(${column} = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)`
  const { rows } = await sql<{ table: string }>`
    select c.relname as table
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind = 'r'
      and not (c.relrowsecurity and c.relforcerowsecurity
        -- Exactly one policy: a second permissive policy would OR with the tenant one and widen access.
        and (select count(*) from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname) = 1
        and exists (
          select 1 from pg_policies p
          where p.schemaname = n.nspname and p.tablename = c.relname
            and p.policyname = 'tenant_isolation' and p.cmd = 'ALL' and p.permissive = 'PERMISSIVE'
            and p.roles = '{public}'
            and p.qual = case when c.relname = 'tenants' then ${expected('id')} else ${expected('tenant_id')} end
            and p.with_check = p.qual))
    order by 1`.execute(db)
  return rows.map((row) => row.table)
}
