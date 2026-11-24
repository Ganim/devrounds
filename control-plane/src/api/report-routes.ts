import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import { improvementReport } from '../runs/improvement.ts'
import { authenticateMembers, memberCtx } from './members.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })

// Reports computed from runs. Read only: opening a task per finding is the caller's step (POST /findings), so a
// report can be read without changing the plan.
export const reportRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database> }> = async (app, { db }) => {
  authenticateMembers(app, db)

  app.get(
    '/reports/improvement',
    {
      schema: {
        params: Type.Object({ key: Key }),
        // The service checks the calendar date (DR101 at /day); omitted, the day is yesterday in the tenant time zone.
        querystring: Type.Object(
          { day: Type.Optional(Type.String({ maxLength: 10 })) },
          { additionalProperties: false },
        ),
      },
    },
    (request) => improvementReport(memberCtx(db, request), request.params.key, request.query.day),
  )
}
