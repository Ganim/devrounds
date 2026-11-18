import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { bearer, resolveToken } from '../auth/tokens.ts'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import type { Ctx } from '../planning/service.ts'

// Every route of the plugin needs a member token. onRequest runs before body parsing and validation, so an anonymous
// caller gets DR401, never a DR101.
export function authenticateMembers(app: FastifyInstance, db: Kysely<Database>): void {
  app.addHook('onRequest', async (request) => {
    request.owner = await resolveToken(db, bearer(request.headers.authorization))
  })
}

export function memberCtx(db: Kysely<Database>, request: FastifyRequest): Ctx {
  const owner = request.owner ?? fail('DR401')
  return { db, tenantId: owner.tenantId, actor: owner.member }
}
