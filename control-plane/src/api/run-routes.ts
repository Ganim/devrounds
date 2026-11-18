import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import type { Sessions } from '../executor/gateway.ts'
import type { ControlPlaneMessage } from '../executor/protocol.ts'
import { parseJobTypeFile } from '../job-types/file.ts'
import { getJobType, putJobType } from '../job-types/service.ts'
import { prepareStop, recordDispatch, waitForRun } from '../runs/dispatch.ts'
import { readRunLog } from '../runs/log-store.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Key) })
const JobTypeParams = Type.Object({ key: Key, jobType: Key })
const RunParams = Type.Object({ key: Key, id: Key })
// The agent output budget (cli/output.ts BODY_BUDGET): one page is one CLI screen.
const LOG_PAGE_BYTES = 16384

// Job types and runs of one project. Messages to the executor go out only after mutateIdempotent committed, and only
// when the mutation ran: a replayed Idempotency-Key offers or stops nothing again.
export const runRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database>; sessions: Sessions }> = async (
  app,
  { db, sessions },
) => {
  authenticateMembers(app, db)

  app.put(
    '/job-types/:jobType',
    { schema: { params: JobTypeParams, headers: Headers, body: Type.String({ minLength: 1 }) } },
    (request, reply) =>
      mutateIdempotent(db, request, reply, (ctx) => {
        const file = parseJobTypeFile(request.body)
        if (file.key !== request.params.jobType) {
          fail('DR101', { path: '/key', reason: `the file is for job type ${file.key}` })
        }
        return putJobType(ctx, request.params.key, file)
      }),
  )

  app.get('/job-types/:jobType', { schema: { params: JobTypeParams } }, (request) =>
    getJobType(memberCtx(db, request), request.params.key, request.params.jobType),
  )

  app.post(
    '/runs',
    {
      schema: {
        params: Type.Object({ key: Key }),
        headers: Headers,
        body: Type.Object(
          { jobType: Key, machine: Key, cwd: Type.String({ minLength: 1, maxLength: 1000 }), task: Type.Optional(Key) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      let send: { machineId: string; message: ControlPlaneMessage } | undefined
      const { jobType, machine, cwd, task } = request.body
      const answer = await mutateIdempotent(db, request, reply, async (ctx) => {
        const input = { projectKey: request.params.key, jobTypeKey: jobType, machineName: machine, cwd, taskKey: task }
        const { view, machineId, offer } = await recordDispatch(ctx, sessions, input)
        send = { machineId, message: offer }
        return view
      })
      // A session lost since the check leaves the run offered; the executor's reconnect does not replay Offers.
      if (send) sessions.send(send.machineId, send.message)
      return answer
    },
  )

  app.get(
    '/runs/:id',
    {
      schema: {
        params: RunParams,
        querystring: Type.Object({ wait: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })) }),
      },
    },
    (request, reply) => {
      // The response closing before it was sent means the client went away: end the wait and drop its listener.
      const gone = new AbortController()
      if (request.raw.socket.destroyed) gone.abort()
      else reply.raw.once('close', () => gone.abort())
      return waitForRun(memberCtx(db, request), request.params.id, request.query.wait ?? 0, {
        projectKey: request.params.key,
        signal: gone.signal,
      })
    },
  )

  // One page of the run's output; the CLI shows it as `devrounds run logs <id> [--cursor <n>]`.
  app.get(
    '/runs/:id/logs',
    {
      schema: {
        params: RunParams,
        querystring: Type.Object({ cursor: Type.Optional(Type.String({ pattern: '^[0-9]{1,19}$' })) }),
      },
    },
    async (request) => {
      const { cursor } = request.query
      const page = await readRunLog(memberCtx(db, request), request.params.id, {
        cursor: cursor === undefined ? undefined : BigInt(cursor),
        maxBytes: LOG_PAGE_BYTES,
        projectKey: request.params.key,
      })
      // Seqs fit a JS number: the protocol refuses any past 2^53 (executor/protocol.ts).
      return { lines: page.lines, nextCursor: page.nextCursor === null ? null : Number(page.nextCursor) }
    },
  )

  app.post('/runs/:id/stop', { schema: { params: RunParams, headers: Headers } }, async (request, reply) => {
    let target: { machineId: string; machine: string } | undefined
    const answer = await mutateIdempotent(db, request, reply, async (ctx) => {
      const { view, machineId } = await prepareStop(ctx, sessions, request.params.id, request.params.key)
      target = { machineId, machine: view.machine }
      return view
    })
    // Same answer as stopRun: a session lost since the check is DR350, not a stop that silently went nowhere.
    if (target && !sessions.send(target.machineId, { type: 'Stop', run: request.params.id, reason: 'cancel' })) {
      fail('DR350', { machine: target.machine })
    }
    return answer
  })
}
