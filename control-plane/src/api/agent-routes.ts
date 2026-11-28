import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import { listBudgets, setBudget } from '../engines/agent-runtime/budgets.ts'
import { reportResult } from '../engines/agent-runtime/results.ts'
import { runEvents } from '../runs/dispatch.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Key) })
const Cap = Type.Union([Type.Number({ minimum: 0, maximum: 1e9 }), Type.Null()])

// Agent runs (engines/agent-runtime): the result a run reports, and the project's agent budgets.
export const agentRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database> }> = async (app, { db }) => {
  authenticateMembers(app, db)

  // `devrounds run result`, called by the agent from inside its run.
  app.post(
    '/runs/:id/result',
    {
      schema: {
        params: Type.Object({ key: Key, id: Key }),
        headers: Headers,
        body: Type.Object(
          {
            label: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }),
            data: Type.Optional(Type.Object({}, { additionalProperties: true })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const answer = await mutateIdempotent(db, request, reply, (ctx) =>
        reportResult(ctx, request.params.key, request.params.id, {
          label: request.body.label,
          data: request.body.data ?? {},
        }),
      )
      runEvents.emit('changed', request.params.id)
      return answer
    },
  )

  app.get('/agent-budgets', { schema: { params: Type.Object({ key: Key }) } }, (request) =>
    listBudgets(memberCtx(db, request), request.params.key),
  )

  // Replaces the budget of one job type or member; every cap null removes it.
  app.put(
    '/agent-budgets',
    {
      schema: {
        params: Type.Object({ key: Key }),
        headers: Headers,
        body: Type.Object(
          {
            jobType: Type.Optional(Key),
            member: Type.Optional(Key),
            usdPerDay: Cap,
            tokensPerDay: Type.Union([Type.Integer({ minimum: 0, maximum: 1e15 }), Type.Null()]),
            usdPerRun: Cap,
          },
          { additionalProperties: false },
        ),
      },
    },
    (request, reply) =>
      mutateIdempotent(db, request, reply, async (ctx) => ({
        budget: await setBudget(ctx, { projectKey: request.params.key, ...request.body }),
      })),
  )
}
