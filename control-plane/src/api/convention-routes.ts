import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import { CheckInput, conventionIndicators, recordCheck } from '../conventions/results.ts'
import {
  checkProposal,
  conventionsSummary,
  decide,
  ProposeInput,
  recordProposal,
  versionDiff,
  versionView,
} from '../conventions/service.ts'
import type { Database } from '../db/schema.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'
import { periodWindow } from './period-window.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Key) })
const Version = Type.String({ pattern: '^[1-9][0-9]{0,8}$' })
const VersionOrActive = Type.String({ pattern: '^(active|[1-9][0-9]{0,8})$' })
const Reason = Type.String({ maxLength: 2000 })

// A document may be 1 MB (conventions/file.ts); the body wraps it, and JSON escaping can grow it.
const PROPOSAL_BODY_LIMIT = 4 * 1024 * 1024

// A project's conventions (design §4): versions, proposals and the human decision on them, check results and their
// indicators.
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
    async (request, reply) => {
      await checkProposal(request.body)
      return mutateIdempotent(db, request, reply, (ctx) => recordProposal(ctx, request.params.key, request.body))
    },
  )

  app.post(
    '/conventions/checks',
    { schema: { params: Type.Object({ key: Key }), headers: Headers, body: CheckInput } },
    (request, reply) =>
      mutateIdempotent(db, request, reply, (ctx) => recordCheck(ctx, request.params.key, request.body)),
  )

  app.get(
    '/indicators/conventions',
    {
      schema: {
        params: Type.Object({ key: Key }),
        querystring: Type.Object(
          {
            period: Type.Unsafe<'day' | 'week'>({ type: 'string', enum: ['day', 'week'], default: 'day' }),
            from: Type.Optional(Type.String()),
            to: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      },
    },
    (request) =>
      conventionIndicators(
        memberCtx(db, request),
        request.params.key,
        periodWindow('conventions indicators', request.query),
      ),
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
