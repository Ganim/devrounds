import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import { GateInput } from '../gates/file.ts'
import { submitGate, waitForGate } from '../gates/service.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Key) })

// Gates of one project. A submit never waits for the worktree lock: it answers DR308 with the holder, and the CLI waits
// on `GET /gates/<holder>?wait` and submits again (plan call 2), so no request outlives the CLI's timeout.
export const gateRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database> }> = async (app, { db }) => {
  authenticateMembers(app, db)

  app.post(
    '/gates',
    { schema: { params: Type.Object({ key: Key }), headers: Headers, body: GateInput } },
    (request, reply) =>
      mutateIdempotent(db, request, reply, (ctx) => submitGate(ctx, request.params.key, request.body)),
  )

  app.get(
    '/gates/:id',
    {
      schema: {
        params: Type.Object({ key: Key, id: Key }),
        querystring: Type.Object({ wait: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })) }),
      },
    },
    (request, reply) => {
      // The response closing before it was sent means the client went away: end the wait and drop its listener.
      const gone = new AbortController()
      if (request.raw.socket.destroyed) gone.abort()
      else reply.raw.once('close', () => gone.abort())
      return waitForGate(memberCtx(db, request), request.params.key, request.params.id, request.query.wait ?? 0, {
        signal: gone.signal,
      })
    },
  )
}
