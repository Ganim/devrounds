import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import { DevRoundsError } from '../errors/error.ts'
import type { Sessions } from '../executor/gateway.ts'
import {
  cancelFlowRun,
  FlowResumeInput,
  FlowRunInput,
  flowRunView,
  getFlow,
  listFlowRuns,
  listFlows,
  putFlow,
  resumeFlowRun,
  startFlowRun,
} from '../flows/service.ts'
import { type PreparedStop, prepareStop, runEvents } from '../runs/dispatch.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Key) })
const FlowRunState = Type.Union(['running', 'done', 'parked', 'cancelled'].map((s) => Type.Literal(s)))

// Flows and flow runs of one project (P4 design §3.G). The document body is checked by putFlow, so a problem is DR101
// with its path in the document rather than a schema error of the route.
export const flowRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database>; sessions: Sessions }> = async (
  app,
  { db, sessions },
) => {
  authenticateMembers(app, db)

  app.post(
    '/flows',
    { schema: { params: Type.Object({ key: Key }), headers: Headers, body: Type.Unknown() } },
    (r, reply) => mutateIdempotent(db, r, reply, (ctx) => putFlow(ctx, r.params.key, r.body)),
  )

  app.get('/flows', { schema: { params: Type.Object({ key: Key }) } }, (r) => listFlows(memberCtx(db, r), r.params.key))

  app.get(
    '/flows/:flow',
    {
      schema: {
        params: Type.Object({ key: Key, flow: Key }),
        querystring: Type.Object({ version: Type.Optional(Type.Integer({ minimum: 1 })) }),
      },
    },
    (r) => getFlow(memberCtx(db, r), r.params.key, r.params.flow, r.query.version),
  )

  app.post(
    '/flows/:flow/runs',
    { schema: { params: Type.Object({ key: Key, flow: Key }), headers: Headers, body: FlowRunInput } },
    (r, reply) => mutateIdempotent(db, r, reply, (ctx) => startFlowRun(ctx, r.params.key, r.params.flow, r.body)),
  )

  app.get(
    '/flow-runs',
    {
      schema: {
        params: Type.Object({ key: Key }),
        querystring: Type.Object({
          state: Type.Optional(FlowRunState),
          flow: Type.Optional(Key),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
      },
    },
    (r) =>
      listFlowRuns(memberCtx(db, r), r.params.key, {
        state: r.query.state as 'running' | 'done' | 'parked' | 'cancelled' | undefined,
        flow: r.query.flow,
        limit: r.query.limit,
      }),
  )

  app.get('/flow-runs/:id', { schema: { params: Type.Object({ key: Key, id: Key }) } }, (r) =>
    flowRunView(memberCtx(db, r), r.params.key, r.params.id),
  )

  // The live run of the cancelled node's job is stopped before the answer, so the answer shows it stopped, and only when
  // the cancel ran (a replayed Idempotency-Key stops nothing again). A stop that cannot reach its machine (DR350) leaves
  // the run as it is: its end later moves nothing, since the flow run is cancelled.
  app.post(
    '/flow-runs/:id/cancel',
    { schema: { params: Type.Object({ key: Key, id: Key }), headers: Headers } },
    async (r, reply) => {
      let stop: PreparedStop | undefined
      const answer = await mutateIdempotent(db, r, reply, async (ctx) => {
        const cancelled = await cancelFlowRun(ctx, r.params.key, r.params.id)
        if (cancelled.liveRun === null) return cancelled.view
        try {
          stop = await prepareStop(ctx, sessions, cancelled.liveRun, r.params.key)
        } catch (err) {
          if (!(err instanceof DevRoundsError)) throw err
          r.log.warn({ err, run: cancelled.liveRun }, 'flow run cancelled; its live run was not stopped')
          return cancelled.view
        }
        return flowRunView(ctx, r.params.key, r.params.id)
      })
      if (stop?.ended) {
        if (stop.sendTo !== undefined) sessions.send(stop.sendTo, { type: 'Stop', run: stop.view.id, reason: 'cancel' })
        for (const changed of stop.changed) runEvents.emit('changed', changed)
      } else if (stop && !sessions.send(stop.machineId, { type: 'Stop', run: stop.view.id, reason: 'cancel' })) {
        r.log.warn({ run: stop.view.id, machine: stop.machine }, 'flow run cancelled; its live run was not stopped')
      }
      return answer
    },
  )

  app.post(
    '/flow-runs/:id/resume',
    { schema: { params: Type.Object({ key: Key, id: Key }), headers: Headers, body: FlowResumeInput } },
    (r, reply) => mutateIdempotent(db, r, reply, (ctx) => resumeFlowRun(ctx, r.params.key, r.params.id, r.body)),
  )
}
