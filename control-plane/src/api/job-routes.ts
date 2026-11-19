import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import { BatchInput } from '../jobs/batch-file.ts'
import { batchView, submitBatch } from '../jobs/enqueue.ts'
import { listQueues, putQueue, QueueSettings } from '../queues/service.ts'
import { listSchedules, putSchedule, ScheduleSettings } from '../scheduler/schedules.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Key) })

// Queues and batches of one project. Enqueued runs wait for the scheduler; nothing is sent to an executor here.
export const jobRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database> }> = async (app, { db }) => {
  authenticateMembers(app, db)

  app.put(
    '/queues/:queue',
    { schema: { params: Type.Object({ key: Key, queue: Key }), headers: Headers, body: QueueSettings } },
    (request, reply) =>
      mutateIdempotent(db, request, reply, (ctx) =>
        putQueue(ctx, request.params.key, { ...request.body, key: request.params.queue }),
      ),
  )

  app.get('/queues', { schema: { params: Type.Object({ key: Key }) } }, (request) =>
    listQueues(memberCtx(db, request), request.params.key),
  )

  app.put(
    '/schedules/:schedule',
    { schema: { params: Type.Object({ key: Key, schedule: Key }), headers: Headers, body: ScheduleSettings } },
    (request, reply) =>
      mutateIdempotent(db, request, reply, (ctx) =>
        putSchedule(ctx, request.params.key, { ...request.body, key: request.params.schedule }),
      ),
  )

  app.get('/schedules', { schema: { params: Type.Object({ key: Key }) } }, (request) =>
    listSchedules(memberCtx(db, request), request.params.key),
  )

  app.post(
    '/batches',
    { schema: { params: Type.Object({ key: Key }), headers: Headers, body: BatchInput } },
    (request, reply) =>
      mutateIdempotent(db, request, reply, (ctx) => submitBatch(ctx, request.params.key, request.body)),
  )

  app.get('/batches/:id', { schema: { params: Type.Object({ key: Key, id: Key }) } }, (request) =>
    batchView(memberCtx(db, request), request.params.key, request.params.id),
  )
}
