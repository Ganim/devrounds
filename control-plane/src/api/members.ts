import type { IncomingHttpHeaders } from 'node:http'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { resolveSession, SESSION_COOKIE } from '../auth/session.ts'
import { bearer, resolveToken } from '../auth/tokens.ts'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import type { Ctx } from '../planning/service.ts'

const HAS_SESSION_COOKIE = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE.replace('.', '\\.')}=`)
const READ_METHODS = new Set(['GET', 'HEAD'])

/** The header the web view sends with every write (web/src/data/http.ts); its value names the action, e.g. `task.add`. */
export const ACTION_HEADER = 'x-devrounds-action'

// Why a cookie write needs each of these (P5 design call 6, reversing P1 plan call 13): the browser attaches the
// SameSite=Lax cookie to same-site requests and to top-level cross-site navigations, so the cookie alone proves
// nothing about who built the request. A cross-site page can only set a custom header through CORS, which this server
// never grants, so the action header is the guard; Origin and Sec-Fetch-Site, sent by every current browser on a
// write, refuse a foreign page outright and also cover a same-site page on another port (127.0.0.1 is one site for
// every port). Origin and Sec-Fetch-Site are checked only when present: a request without them is not a browser
// carrying the cookie for another site's page. Returns the DR402 reason, or null when the write may go on.
export function crossSiteRefusal(headers: IncomingHttpHeaders, origins: readonly string[]): string | null {
  const action = headers[ACTION_HEADER]
  if (typeof action !== 'string' || action.trim() === '') return `has no ${ACTION_HEADER} header`
  const { origin } = headers
  if (origin !== undefined && !origins.includes(origin)) return 'comes from another origin'
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return 'is not a same-origin request'
  return null
}

// Every route of the plugin needs a member: a Bearer token first, else the web view's session cookie. onRequest runs
// before body parsing and validation, so an anonymous caller gets DR401, never a DR101.
//
// A present Authorization header decides alone (a bad token is DR401 even next to a valid cookie), so an agent never
// acts as whoever is signed in to the browser, and token callers (CLI, agents, executor) never meet the cookie guard.
// A cookie write that crossSiteRefusal refuses is DR402 before the session is even looked up (Review Focus 4). An
// admitted one runs the same route as a token write: the session's tenant, withTenant and RLS on every path.
export function authenticateMembers(app: FastifyInstance, db: Kysely<Database>): void {
  app.addHook('onRequest', async (request) => {
    const { authorization, cookie } = request.headers
    const sessionAuth = app.sessionAuth
    if (authorization === undefined && sessionAuth && cookie !== undefined && HAS_SESSION_COOKIE.test(cookie)) {
      if (!READ_METHODS.has(request.method)) {
        const reason = crossSiteRefusal(request.headers, sessionAuth.origins)
        if (reason !== null) fail('DR402', { method: request.method, route: request.url, reason })
      }
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
