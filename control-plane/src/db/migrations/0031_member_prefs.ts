import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'

// Preferences a member shares across devices (P5 design call 8): session order, custom names, sections, board columns.
// One opaque JSON value per (member, project, name), owned by the feature that names it (prefs/service.ts); what is
// local to one device (theme, aside width, drafts) stays in the browser.
// Migrations take the next free number at merge (Kysely refuses one named below an applied one).
const TABLES = [
  `create table member_prefs (
    tenant_id uuid not null references tenants (id),
    member_id uuid not null,
    project_id uuid not null,
    name text not null check (name ~ '^[a-z][a-z0-9.-]{0,99}$'),
    value jsonb not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, member_id, project_id, name),
    foreign key (tenant_id, member_id) references members (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id)
  )`,
]

export const memberPrefs: Migration = {
  async up(db: Kysely<unknown>) {
    const statements = [
      ...TABLES,
      ...isolate('member_prefs', 'tenant_id'),
      // The primary key leads with (tenant_id, member_id); the project FK needs its own (0007_fk_indexes).
      'create index member_prefs_project_id on member_prefs (tenant_id, project_id)',
    ]
    for (const statement of statements) await sql.raw(statement).execute(db)
  },
}
