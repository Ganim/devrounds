import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { type Static, type TSchema, Type } from '@sinclair/typebox'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { getBalance } from '../planning/balance.ts'
import { exportPlan } from '../planning/export.ts'
import { importPlan } from '../planning/import.ts'
import { parsePlanFile } from '../planning/plan-file.ts'
import type { TaskState as TaskStateName } from '../planning/rules.ts'
import {
  addCriterion,
  addDependency,
  addLink,
  addPhase,
  addPhaseDependency,
  addTask,
  type Ctx,
  checkCriterion,
  closePhase,
  editPhase,
  editTask,
  movePhase,
  removeDependency,
  removePhaseDependency,
  reopenPhase,
  transition,
} from '../planning/service.ts'
import { getPlan, listEvents } from '../planning/view.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'
import { periodWindow } from './period-window.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })
const Text = Type.String({ minLength: 1 })
const Position = Type.Integer({ minimum: 1 })
const Reason = Type.String()
// A plain `enum` instead of a union of literals: Ajv then reports the allowed values instead of one branch's miss.
const oneOf = <T extends string>(values: T[], opts: { default?: T } = {}) =>
  Type.Unsafe<T>({ type: 'string', enum: values, ...opts })
const TaskState = oneOf<TaskStateName>(['todo', 'in_progress', 'blocked', 'done', 'cancelled'])

const ProjectParams = Type.Object({ key: Key })
const PhaseParams = Type.Object({ key: Key, phaseKey: Key })
const TaskParams = Type.Object({ key: Key, taskKey: Key })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Key) })
// Criteria and links name exactly one of taskKey or phaseKey; the service answers DR101 otherwise.
const TargetBody = { taskKey: Type.Optional(Key), phaseKey: Type.Optional(Key) }
const Dependency = Type.Object({ blockedByKey: Key, reason: Type.Optional(Reason) }, { additionalProperties: false })

const object = <T extends Record<string, TSchema>>(props: T) => Type.Object(props, { additionalProperties: false })

// Event ids are bigint; a longer cursor would make Postgres fail the cast, which is a 500.
const BIGINT_MAX = 9_223_372_036_854_775_807n

export const projectRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database> }> = async (app, { db }) => {
  authenticateMembers(app, db)
  const ctxOf = (request: FastifyRequest) => memberCtx(db, request)
  const mutate = (request: FastifyRequest, reply: FastifyReply, run: (ctx: Ctx) => Promise<unknown>) =>
    mutateIdempotent(db, request, reply, run)

  // Reads.

  app.get('/plan', { schema: { params: ProjectParams } }, (request) => getPlan(ctxOf(request), request.params.key))

  // Polling cursor. Known P0 limitation: bigserial ids are taken at insert but commit in any order, so a poller that
  // already read id 12 can miss an id 11 committed afterwards. P5 replaces polling with SSE.
  app.get(
    '/events',
    {
      schema: {
        params: ProjectParams,
        querystring: object({
          afterId: Type.Optional(Type.String({ pattern: '^[0-9]{1,19}$' })),
          limit: Type.Integer({ minimum: 1, maximum: 500, default: 100 }),
          // desc = newest first, for the web history; it cannot be combined with afterId (DR101).
          order: oneOf<'asc' | 'desc'>(['asc', 'desc'], { default: 'asc' }),
        }),
      },
    },
    (request) => {
      const { afterId } = request.query
      if (afterId !== undefined && BigInt(afterId) > BIGINT_MAX) {
        fail('DR101', { path: 'querystring/afterId', reason: 'is past the largest event id' })
      }
      return listEvents(ctxOf(request), request.params.key, request.query)
    },
  )

  app.get(
    '/balance',
    {
      schema: {
        params: ProjectParams,
        querystring: object({
          period: oneOf<'day' | 'week'>(['day', 'week'], { default: 'day' }),
          from: Type.Optional(Type.String()),
          to: Type.Optional(Type.String()),
        }),
      },
    },
    (request) => getBalance(ctxOf(request), request.params.key, periodWindow('balance', request.query)),
  )

  app.get('/export', { schema: { params: ProjectParams } }, async (request, reply) => {
    const yaml = await exportPlan(ctxOf(request), request.params.key)
    return reply.type('text/yaml; charset=utf-8').send(yaml)
  })

  // Mutations.

  // The actor of every change is the token's member.
  app.post('/import', { schema: { params: ProjectParams, headers: Headers, body: Text } }, (request, reply) =>
    mutate(request, reply, (ctx) => {
      const file = parsePlanFile(request.body)
      if (file.project.key !== request.params.key) {
        fail('DR101', { path: '/project/key', reason: `the file is for project ${file.project.key}` })
      }
      return importPlan(ctx, file)
    }),
  )

  app.post(
    '/phases',
    {
      schema: {
        params: ProjectParams,
        headers: Headers,
        body: object({
          key: Key,
          title: Text,
          goal: Type.String(),
          position: Type.Optional(Position),
          criteria: Type.Optional(Type.Array(Text)),
        }),
      },
    },
    (request, reply) =>
      mutate(request, reply, (ctx) => addPhase(ctx, { projectKey: request.params.key, ...request.body })),
  )

  app.patch(
    '/phases/:phaseKey',
    {
      schema: {
        params: PhaseParams,
        headers: Headers,
        body: object({ title: Type.Optional(Text), goal: Type.Optional(Type.String()), reason: Reason }),
      },
    },
    (request, reply) =>
      mutate(request, reply, (ctx) => editPhase(ctx, { ...phaseOf(request.params), ...request.body })),
  )

  app.post(
    '/phases/:phaseKey/move',
    { schema: { params: PhaseParams, headers: Headers, body: object({ position: Position, reason: Reason }) } },
    (request, reply) =>
      mutate(request, reply, (ctx) => movePhase(ctx, { ...phaseOf(request.params), ...request.body })),
  )

  app.post('/phases/:phaseKey/close', { schema: { params: PhaseParams, headers: Headers } }, (request, reply) =>
    mutate(request, reply, (ctx) => closePhase(ctx, phaseOf(request.params))),
  )

  app.post(
    '/phases/:phaseKey/reopen',
    { schema: { params: PhaseParams, headers: Headers, body: object({ reason: Reason }) } },
    (request, reply) =>
      mutate(request, reply, (ctx) => reopenPhase(ctx, { ...phaseOf(request.params), ...request.body })),
  )

  const phaseDependency = { schema: { params: PhaseParams, headers: Headers, body: Dependency } }
  app.post('/phases/:phaseKey/dependencies', phaseDependency, (request, reply) =>
    mutate(request, reply, (ctx) => addPhaseDependency(ctx, { ...phaseOf(request.params), ...request.body })),
  )
  app.delete('/phases/:phaseKey/dependencies', phaseDependency, (request, reply) =>
    mutate(request, reply, (ctx) => removePhaseDependency(ctx, { ...phaseOf(request.params), ...request.body })),
  )

  app.post(
    '/tasks',
    {
      schema: {
        params: ProjectParams,
        headers: Headers,
        body: object({
          key: Key,
          title: Text,
          phaseKey: Type.Optional(Key),
          parentKey: Type.Optional(Key),
          description: Type.Optional(Type.String()),
          assigneeName: Type.Optional(Key),
          estimateHours: Type.Optional(Type.Number({ minimum: 0 })),
          criteria: Type.Optional(Type.Array(Text)),
          blockedBy: Type.Optional(Type.Array(Key)),
        }),
      },
    },
    (request, reply) =>
      mutate(request, reply, (ctx) => addTask(ctx, { projectKey: request.params.key, ...request.body })),
  )

  // `null` clears phaseKey, assigneeName or estimateHours; an omitted field stays as it is.
  app.patch(
    '/tasks/:taskKey',
    {
      schema: {
        params: TaskParams,
        headers: Headers,
        body: object({
          title: Type.Optional(Text),
          description: Type.Optional(Type.String()),
          phaseKey: Type.Optional(Type.Union([Key, Type.Null()])),
          assigneeName: Type.Optional(Type.Union([Key, Type.Null()])),
          estimateHours: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
          reason: Reason,
        }),
      },
    },
    (request, reply) => mutate(request, reply, (ctx) => editTask(ctx, { ...taskOf(request.params), ...request.body })),
  )

  app.post(
    '/tasks/:taskKey/transition',
    {
      schema: {
        params: TaskParams,
        headers: Headers,
        body: object({ to: TaskState, reason: Type.Optional(Reason) }),
      },
    },
    (request, reply) =>
      mutate(request, reply, (ctx) => transition(ctx, { ...taskOf(request.params), ...request.body })),
  )

  const taskDependency = { schema: { params: TaskParams, headers: Headers, body: Dependency } }
  app.post('/tasks/:taskKey/dependencies', taskDependency, (request, reply) =>
    mutate(request, reply, (ctx) => addDependency(ctx, { ...taskOf(request.params), ...request.body })),
  )
  app.delete('/tasks/:taskKey/dependencies', taskDependency, (request, reply) =>
    mutate(request, reply, (ctx) => removeDependency(ctx, { ...taskOf(request.params), ...request.body })),
  )

  app.post(
    '/criteria',
    { schema: { params: ProjectParams, headers: Headers, body: object({ ...TargetBody, text: Text }) } },
    (request, reply) =>
      mutate(request, reply, (ctx) => addCriterion(ctx, { projectKey: request.params.key, ...request.body })),
  )

  app.post(
    '/criteria/check',
    {
      schema: {
        params: ProjectParams,
        headers: Headers,
        body: object({ ...TargetBody, position: Position, evidence: Text }),
      },
    },
    (request, reply) =>
      mutate(request, reply, (ctx) => checkCriterion(ctx, { projectKey: request.params.key, ...request.body })),
  )

  app.post(
    '/links',
    {
      schema: {
        params: ProjectParams,
        headers: Headers,
        body: object({ ...TargetBody, kind: Key, ref: Text, title: Type.Optional(Type.String()) }),
      },
    },
    (request, reply) =>
      mutate(request, reply, (ctx) => addLink(ctx, { projectKey: request.params.key, ...request.body })),
  )
}

function phaseOf(params: Static<typeof PhaseParams>) {
  return { projectKey: params.key, phaseKey: params.phaseKey }
}

function taskOf(params: Static<typeof TaskParams>) {
  return { projectKey: params.key, taskKey: params.taskKey }
}
