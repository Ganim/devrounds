import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import { conventionsSummary, decide, ProposeInput, propose, versionDiff, versionView } from '../conventions/service.ts'
import type { Database } from '../db/schema.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Key) })
const Version = Type.String({ pattern: '^[1-9][0-9]{0,8}$' })
const VersionOrActive = Type.String({ pattern: '^(active|[1-9][0-9]{0,8})$' })
const Reason = Type.String({ maxLength: 2000 })

// A document may be 1 MB (conventions/file.ts); the body wraps it, and JSON escaping can grow it.
const PROPOSAL_BODY_LIMIT = 4 * 1024 * 1024

// A project's conventions (design §4): versions, proposals and the human decision on them. The check results and their
// indicators are added with convention_checks.
export const conventionRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database> }> = async (app, { db }) => {
  authenticateMembers(app, db)

  app.get('/conventions', { schema: { params: Type.Object({ key: Key }) } }, (request) =>
    conventionsSummary(memberCtx(db, request), request.params.key),
  )

  app.get(
    '/conventions/:version',
    { schema: { params: Type.Object({ key: Key, version: VersionOrActive }) } },
    (request) => versionView(memberCtx(db, request), request.params.key, request.params.version),
  )

  app.get(
    '/conventions/:version/diff',
    {
      schema: {
        params: Type.Object({ key: Key, version: VersionOrActive }),
        querystring: Type.Object({ against: Type.Optional(VersionOrActive) }, { additionalProperties: false }),
      },
    },
    (request) => versionDiff(memberCtx(db, request), request.params.key, request.params.version, request.query.against),
  )

  app.post(
    '/conventions/proposals',
    {
      bodyLimit: PROPOSAL_BODY_LIMIT,
      schema: { params: Type.Object({ key: Key }), headers: Headers, body: ProposeInput },
    },
    (request, reply) => mutateIdempotent(db, request, reply, (ctx) => propose(ctx, request.params.key, request.body)),
  )

  for (const decision of ['approve', 'reject'] as const) {
    app.post(
      `/conventions/:version/${decision}`,
      {
        schema: {
          params: Type.Object({ key: Key, version: Version }),
          headers: Headers,
          // A rejection needs a reason; decide answers DR104 for a missing or blank one.
          body: Type.Object({ reason: Type.Optional(Reason) }, { additionalProperties: false }),
        },
      },
      (request, reply) =>
        mutateIdempotent(db, request, reply, (ctx) =>
          decide(ctx, request.params.key, Number(request.params.version), decision, request.body.reason),
        ),
    )
  }
}
