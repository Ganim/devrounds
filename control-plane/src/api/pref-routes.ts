import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import { getPref, listPrefs, PREF_NAME, setPref } from '../prefs/service.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const Name = Type.String({ pattern: PREF_NAME })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Key) })

// The calling member's preferences in one project, shared by every device it signs in from (P5 design call 8).
export const prefRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database> }> = async (app, { db }) => {
  authenticateMembers(app, db)

  app.get('/prefs', { schema: { params: Type.Object({ key: Key }) } }, (request) =>
    listPrefs(memberCtx(db, request), request.params.key),
  )

  app.get('/prefs/:name', { schema: { params: Type.Object({ key: Key, name: Name }) } }, (request) =>
    getPref(memberCtx(db, request), request.params.key, request.params.name),
  )

  app.put(
    '/prefs/:name',
    {
      schema: {
        params: Type.Object({ key: Key, name: Name }),
        headers: Headers,
        body: Type.Object({ value: Type.Unknown() }, { additionalProperties: false }),
      },
    },
    (request, reply) =>
      mutateIdempotent(db, request, reply, (ctx) =>
        setPref(ctx, request.params.key, request.params.name, request.body.value),
      ),
  )
}
