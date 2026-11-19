import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import type { MigrationOptions } from './index.ts'

// Schema `auth` holds Better Auth's identity tables (user, session, account, verification), the one accepted exception
// to the tenant table rule (AGENTS.md): a person signs in before any tenant is known, so these rows carry no tenant_id
// and no RLS. Tenant data never goes there. Better Auth creates its tables in auth/auth-migrate.ts, right after this
// migration, on the owner connection; the app role only gets DML, so `serve` can never create or alter them.
//
// members.user_id links a human member to a Better Auth user. It is text with no FK because Better Auth owns that
// schema and its ids; the partial unique index allows one tenant per login in P1.
//
// resolve_session maps a signed-in user to its member the way resolve_token maps a token: security definer because
// the tenant is not known yet (the app role sees members only through RLS), same hardening, human members only.
const RESOLVE_SESSION = `create function resolve_session(p_user_id text)
  returns table (tenant_id uuid, member_id uuid, kind text)
  language sql stable security definer set search_path = pg_catalog, public, pg_temp
  as $$
    select m.tenant_id, m.id, m.kind
    from public.members m
    where m.user_id = p_user_id and m.kind = 'human'
  $$`

const FUNCTION = 'resolve_session(text)'

export function auth({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      const role = sql.id(appRole)
      await sql`create schema auth`.execute(db)
      await sql`grant usage on schema auth to ${role}`.execute(db)
      await sql`alter default privileges in schema auth grant select, insert, update, delete on tables to ${role}`.execute(
        db,
      )
      await sql`alter table members add column user_id text`.execute(db)
      await sql`create unique index members_user on members (user_id) where user_id is not null`.execute(db)
      await sql.raw(RESOLVE_SESSION).execute(db)
      await sql.raw(`revoke all on function ${FUNCTION} from public`).execute(db)
      await sql`grant execute on function ${sql.raw(FUNCTION)} to ${role}`.execute(db)
    },
  }
}
