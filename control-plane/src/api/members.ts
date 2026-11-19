import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { resolveSession, SESSION_COOKIE } from '../auth/session.ts'
import { bearer, resolveToken } from '../auth/tokens.ts'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import type { Ctx } from '../planning/service.ts'

const HAS_SESSION_COOKIE = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE.replace('.', '\\.')}=`)
const READ_METHODS = new Set(['GET', 'HEAD'])

// Every route of the plugin needs a member: a Bearer token first, else the web view's session cookie. onRequest runs
// before body parsing and validation, so an anonymous caller gets DR401, never a DR101.
//
// A present Authorization header decides alone (a bad token is DR401 even next to a valid cookie), so an agent never
// acts as whoever is signed in to the browser. The cookie only reads: a browser sends it with any cross-site form
// post, so a mutation by cookie is DR402 before the session is even looked up (Review Focus 4; plan call 13).
export function authenticateMembers(app: FastifyInstance, db: Kysely<Database>): void {
  app.addHook('onRequest', async (request) => {
    const { authorization, cookie } = request.headers
    const sessionAuth = app.sessionAuth
    if (authorization === undefined && sessionAuth && cookie !== undefined && HAS_SESSION_COOKIE.test(cookie)) {
      if (!READ_METHODS.has(request.method)) fail('DR402', { method: request.method, route: request.url })
      const userId = await sessionAuth.userOf(new Headers({ cookie }))
      request.owner = await resolveSession(db, userId ?? fail('DR401'))
      return
    }
    request.owner = await resolveToken(db, bearer(authorization))
  })
}

export function memberCtx(db: Kysely<Database>, request: FastifyRequest): Ctx {
  const owner = request.owner ?? fail('DR401')
  return { db, tenantId: owner.tenantId, actor: owner.member }
}
