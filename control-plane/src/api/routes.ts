import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { type Static, type TSchema, Type } from '@sinclair/typebox'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { resolveToken } from '../auth/tokens.ts'
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
import { fingerprintOf, runIdempotent } from './idempotency.ts'

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

// Balance windows: defaults when from/to are omitted, and caps so one request cannot ask for years of rows.
const DAY_MS = 86_400_000
const BALANCE_WINDOW = { day: { defaultDays: 13, maxDays: 366 }, week: { defaultDays: 7 * 11, maxDays: 3660 } }

// Strict ISO 8601: a date, or a date-time with an explicit zone (a zoneless time would take the server's zone).
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/

// A date without a time is UTC midnight, not tenant midnight; callers wanting local days send instants.
function instant(value: string | undefined, path: string): Date | undefined {
  if (value === undefined) return undefined
  const match = ISO_INSTANT.exec(value)
  // Date.UTC rolls 2026-02-31 over into March; reading the day back catches it.
  const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])]
  const calendar = new Date(Date.UTC(year, month - 1, day))
  const date = new Date(value)
  if (!match || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || Number.isNaN(date.getTime())) {
    fail('DR101', { path, reason: 'expected an ISO 8601 date (YYYY-MM-DD) or date-time with a zone' })
  }
  return date
}

// Event ids are bigint; a longer cursor would make Postgres fail the cast, which is a 500.
const BIGINT_MAX = 9_223_372_036_854_775_807n

function bearer(request: FastifyRequest): string | undefined {
  const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')
  return match?.[1]
}

export const projectRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database> }> = async (app, { db }) => {
  // onRequest runs before body parsing and validation, so an anonymous caller gets DR401, never a DR101.
  app.addHook('onRequest', async (request) => {
    request.owner = await resolveToken(db, bearer(request))
  })

  const ctxOf = (request: FastifyRequest): Ctx => {
    const owner = request.owner ?? fail('DR401')
    return { db, tenantId: owner.tenantId, actor: owner.member }
  }

  // Every mutation goes through here: without an Idempotency-Key it just runs; with one, the response is stored
  // with the mutation (see idempotency.ts) and replayed for the same key.
  const mutate = async (request: FastifyRequest, reply: FastifyReply, run: (ctx: Ctx) => Promise<unknown>) => {
    const ctx = ctxOf(request)
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string') return run(ctx)
    const fingerprint = fingerprintOf(request.method, request.url, request.body)
    const stored = await runIdempotent(db, ctx.tenantId, key, fingerprint, async (trx) => ({
      status: 200,
      body: await run({ ...ctx, trx }),
    }))
    return reply.code(stored.status).send(stored.body)
  }

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
    (request) => {
      const { period } = request.query
      const window = BALANCE_WINDOW[period]
      const to = instant(request.query.to, 'querystring/to') ?? new Date()
      const from =
        instant(request.query.from, 'querystring/from') ?? new Date(to.getTime() - window.defaultDays * DAY_MS)
      if (from.getTime() > to.getTime()) fail('DR101', { path: 'querystring/from', reason: 'must not be after to' })
      if (to.getTime() - from.getTime() > window.maxDays * DAY_MS) {
        fail('DR101', { path: 'querystring/from', reason: `a ${period} balance spans at most ${window.maxDays} days` })
      }
      return getBalance(ctxOf(request), request.params.key, { period, from, to })
    },
  )

  app.get('/export', { schema: { params: ProjectParams } }, async (request, reply) => {
    const yaml = await exportPlan(ctxOf(request), request.params.key)
    return reply.type('text/yaml; charset=utf-8').send(yaml)
  })

  // Mutations.

  // The actor of every change is the tenant's `import` member (importPlan picks it), not the token's member.
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
