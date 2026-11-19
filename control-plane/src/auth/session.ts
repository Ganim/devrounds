import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BetterAuthOptions } from 'better-auth'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database, MemberKind } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import type { TokenOwner } from './tokens.ts'

// Session login through Better Auth (identity only, schema `auth`; see migrations/0016_auth.ts). Better Auth is loaded
// with a dynamic import so only `serve` and the admin commands that need it pay for it, never the CLI.

/** Better Auth's session cookie: `cookiePrefix` + `.session_token` (non-secure cookies carry no `__Secure-` prefix). */
export const SESSION_COOKIE = 'devrounds.session_token'

export type SessionAuth = {
  /** Answers every `/api/auth/*` request (sign-in, get-session, sign-out) on the raw Node request and response. */
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** The Better Auth user id of a valid session cookie in `headers`, or null. */
  userOf(headers: Headers): Promise<string | null>
  close(): Promise<void>
}

export type AuthConnection = { databaseUrl: string; port: number; secret: string }

// Its own small pool with `search_path=auth`, so Better Auth's unqualified table names land in schema `auth`.
export function authDb(databaseUrl: string): Kysely<unknown> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: '-c search_path=auth' })
  return new Kysely({ dialect: new PostgresDialect({ pool }) })
}

// The one place the Better Auth options are written, shared by serve, the migration and `login create`. Only
// `login create` passes signUp: there is no self sign-up, the operator creates every login.
export function authOptions(
  db: Kysely<unknown>,
  o: { port: number; secret: string; signUp?: boolean },
): BetterAuthOptions {
  const origins = [`http://127.0.0.1:${o.port}`, `http://localhost:${o.port}`]
  return {
    appName: 'DevRounds',
    baseURL: origins[0],
    basePath: '/api/auth',
    secret: o.secret,
    database: { db, type: 'postgres' },
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: o.signUp !== true,
      minPasswordLength: 12,
      // autoSignIn stays on: turned off, a sign-up with a taken email answers a made-up user instead of an error, and
      // `login create` would link the member to a user that does not exist. createLogin drops that first session.
    },
    trustedOrigins: origins,
    // The control plane listens on loopback over plain http, where a Secure cookie would never be sent back.
    advanced: { cookiePrefix: 'devrounds', useSecureCookies: false },
  }
}

export async function startAuth(o: AuthConnection): Promise<SessionAuth> {
  const [{ betterAuth }, { toNodeHandler }] = await Promise.all([import('better-auth'), import('better-auth/node')])
  const db = authDb(o.databaseUrl)
  const auth = betterAuth(authOptions(db, o))
  const handler = toNodeHandler(auth)
  return {
    handler,
    async userOf(headers) {
      const session = await auth.api.getSession({ headers })
      return session?.user.id ?? null
    },
    close: () => db.destroy(),
  }
}

// Sign-up reasons an operator can fix with another --email; anything else stays an internal error.
const EMAIL_REASONS: Record<string, string> = {
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'already belongs to another login',
  INVALID_EMAIL: 'is not a valid email address',
}

// For `devrounds-admin login create` only: a short-lived instance with sign-up on, over the owner connection (the one
// place a user is ever created). Returns the new user's id.
export async function createUser(
  o: AuthConnection,
  user: { email: string; password: string; name: string },
): Promise<string> {
  const { betterAuth } = await import('better-auth')
  const db = authDb(o.databaseUrl)
  try {
    const auth = betterAuth(authOptions(db, { ...o, signUp: true }))
    const created = await auth.api.signUpEmail({ body: user })
    return created.user.id
  } catch (err) {
    const reason = EMAIL_REASONS[(err as { body?: { code?: string } }).body?.code ?? '']
    if (reason) fail('DR101', { path: '--email', reason })
    throw err
  } finally {
    await db.destroy()
  }
}

// The member a signed-in user acts as. Like resolveToken, every failure is the same DR401: a user linked to no
// member, or to an agent, learns nothing more.
export async function resolveSession(appDb: Kysely<Database>, userId: string): Promise<TokenOwner> {
  const { rows } = await sql<{ tenant_id: string; member_id: string; kind: MemberKind }>`
    select tenant_id, member_id, kind from resolve_session(${userId})`.execute(appDb)
  const row = rows[0] ?? fail('DR401')
  return { tenantId: row.tenant_id, member: { id: row.member_id, kind: row.kind } }
}
