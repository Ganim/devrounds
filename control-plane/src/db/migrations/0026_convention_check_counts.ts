import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// Exact hits per rule of each conventions check, `{rule: {warn, block}}` (conventions/results.ts): violations keeps at
// most 500, so per-rule indicators counted from it undercount past that and list a rule that fired as silent. Rows
// recorded before this get the counts of the violations they kept, the best they have. Runs as the owner (superuser),
// so it sees every tenant's rows.
const STATEMENTS = [
  `alter table convention_checks add column counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(counts) = 'object')`,
  `update convention_checks c set counts = coalesce(
    (select jsonb_object_agg(rule, jsonb_build_object('warn', warn, 'block', block))
      from (
        select v->>'rule' as rule,
          count(*) filter (where v->>'severity' = 'warn') as warn,
          count(*) filter (where v->>'severity' = 'block') as block
        from jsonb_array_elements(c.violations) v group by v->>'rule'
      ) hits),
    '{}'::jsonb)`,
  'alter table convention_checks alter column counts drop default',
]

export const conventionCheckCounts: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of STATEMENTS) await sql.raw(statement).execute(db)
  },
}
