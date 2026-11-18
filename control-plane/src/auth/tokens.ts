import { createHash, randomBytes } from 'node:crypto'
import { type Kysely, sql, type Transaction } from 'kysely'
import type { Database, MemberKind } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import type { Actor } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'

const PREFIX = 'drt_'
// 32 random bytes in base64url are always 43 characters.
const TOKEN = /^drt_[A-Za-z0-9_-]{43}$/

export type TokenOwner = { tenantId: string; member: Actor }

function hashOf(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

export function createToken(
  adminDb: Kysely<Database>,
  tenantId: string,
  memberName: string,
  kind: MemberKind,
): Promise<string> {
  return issueToken(adminDb, tenantId, memberName, kind).then((issued) => issued.token)
}

// The plaintext leaves this function once, to be printed to the operator; only its SHA-256 is stored. The id is
// what `devrounds-admin token revoke` takes.
// Creates the member when the tenant has none by that name; an existing member of the other kind is an input error.
export function issueToken(
  adminDb: Kysely<Database>,
  tenantId: string,
  memberName: string,
  kind: MemberKind,
): Promise<{ id: string; token: string }> {
  return withTenant(adminDb, tenantId, (trx) => issueTokenIn(trx, tenantId, memberName, kind))
}

// issueToken inside a caller's tenant-scoped transaction (bootstrap issues its token with the rest).
export async function issueTokenIn(
  trx: Transaction<Database>,
  tenantId: string,
  memberName: string,
  kind: MemberKind,
): Promise<{ id: string; token: string }> {
  const token = PREFIX + randomBytes(32).toString('base64url')
  await trx
    .insertInto('members')
    .values({ tenant_id: tenantId, kind, name: memberName })
    .onConflict((oc) => oc.columns(['tenant_id', 'name']).doNothing())
    .execute()
  // The owner connection bypasses RLS, so withTenant alone does not narrow this read; the filter must be explicit.
  const member = await trx
    .selectFrom('members')
    .select(['id', 'kind'])
    .where('tenant_id', '=', tenantId)
    .where('name', '=', memberName)
    .executeTakeFirstOrThrow()
  if (member.kind !== kind) fail('DR101', { path: '--kind', reason: `member ${memberName} is a ${member.kind}` })
  const row = await trx
    .insertInto('api_tokens')
    .values({ tenant_id: tenantId, member_id: member.id, token_hash: hashOf(token) })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { id: row.id, token }
}

// Token ids are global uuids and the operator does not name a tenant, so this runs on the owner connection
// outside withTenant on purpose. An unknown or already revoked id is not found.
export async function revokeToken(adminDb: Kysely<Database>, id: string): Promise<void> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuid.test(id)) fail('DR201', { kind: 'token', key: id })
  const result = await adminDb
    .updateTable('api_tokens')
    .set({ revoked_at: sql<Date>`now()` })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  if (result.numUpdatedRows === 0n) fail('DR201', { kind: 'token', key: id })
}

/** The token of an `Authorization: Bearer <token>` header, member and machine tokens alike. */
export function bearer(authorization: string | undefined): string | undefined {
  return /^Bearer (\S+)$/.exec(authorization ?? '')?.[1]
}

// Missing, malformed, unknown and revoked tokens all answer the same DR401, so a caller learns nothing from the
// difference. The lookup is by hash inside resolve_token, which reads across tenants before the tenant is known.
export async function resolveToken(appDb: Kysely<Database>, token: string | undefined): Promise<TokenOwner> {
  if (token === undefined || !TOKEN.test(token)) return fail('DR401')
  const { rows } = await sql<{ tenant_id: string; member_id: string; kind: MemberKind }>`
    select tenant_id, member_id, kind from resolve_token(${hashOf(token)})`.execute(appDb)
  const row = rows[0] ?? fail('DR401')
  return { tenantId: row.tenant_id, member: { id: row.member_id, kind: row.kind } }
}
