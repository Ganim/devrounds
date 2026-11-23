import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import pkg from '../../package.json' with { type: 'json' }
import { CLIENT_IP_HEADER, type SessionAuth } from '../auth/session.ts'
import type { TokenOwner } from '../auth/tokens.ts'
import { defaultLogsRoot } from '../config.ts'
import { toDevRoundsError } from '../convert-error.ts'
import type { Database } from '../db/schema.ts'
import { DevRoundsError, explain, fail } from '../errors/error.ts'
import { executorRoutes, MAX_PAYLOAD, type SchedulerPoke, Sessions } from '../executor/gateway.ts'
import { PairingLimiter } from '../machines/pairing.ts'
import type { Telemetry } from '../telemetry/otel.ts'
import { gateRoutes } from './gate-routes.ts'
import { jobRoutes } from './job-routes.ts'
import { machineRoutes } from './machine-routes.ts'
import { projectRoutes } from './routes.ts'
import { runRoutes } from './run-routes.ts'
import { viewRoutes } from './view-routes.ts'

declare module 'fastify' {
  interface FastifyRequest {
    // Set by the member auth hook on every /api/projects and /api/machines route; null elsewhere.
    owner: TokenOwner | null
  }
  interface FastifyInstance {
    // Read by the member auth hook (members.ts); null when session login is off.
    sessionAuth: SessionAuth | null
  }
}

export type ServerOptions = {
  db: Kysely<Database>
  logger?: FastifyServerOptions['logger']
  // Built by Task 10; served at `/` only when the directory exists.
  webDir?: string
  // One per process, shared by the gateway and the routes that reach executors; tests pass their own.
  sessions?: Sessions
  // Tests pass one on a manual clock.
  pairingLimiter?: PairingLimiter
  // Where run log segments are written (runs/log-store.ts); `serve` passes the configured one.
  logsRoot?: string
  // The OpenTelemetry exporter (telemetry/otel.ts); none, the default, means no spans.
  telemetry?: Telemetry | null
  // Woken by the gateway after each HelloAck and MachineReport (scheduler/scheduler.ts); `serve` passes its own.
  scheduler?: SchedulerPoke
  // The executor session ping interval (executor/gateway.ts PING_MS); tests pass a short one.
  pingMs?: number
  // Session login (auth/session.ts); `serve` builds it only when authSecret is set. Without it /api/auth/* has no route
  // and the member routes take API tokens only.
  sessionAuth?: SessionAuth
}

const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url))

// Fastify's own 4xx errors (bad JSON, unsupported media type, body too large) reach clients as DR101.
function inputError(err: FastifyError): DevRoundsError | null {
  if (err.validation) {
    const [first] = err.validation
    // Ajv points at the parent object for a missing or unknown field; name the field itself.
    const field = first.params.missingProperty ?? first.params.additionalProperty
    // An absent reason is the same DR104 the service answers for a blank one.
    if (err.validationContext === 'body' && first.keyword === 'required' && field === 'reason' && !first.instancePath) {
      return new DevRoundsError('DR104')
    }
    const reasons: Record<string, string> = {
      additionalProperties: 'is not a known field',
      enum: `must be one of ${String(first.params.allowedValues).replaceAll(',', ', ')}`,
    }
    const reason = reasons[first.keyword] ?? first.message
    // Body paths read like the service's (`/title`); query and params name their part (`querystring/limit`).
    const path = `${first.instancePath}${field === undefined ? '' : `/${String(field)}`}` || '/'
    const where = err.validationContext === 'body' ? '' : err.validationContext
    return new DevRoundsError('DR101', { path: `${where ?? ''}${path}`, reason: reason ?? 'is invalid' })
  }
  if (err.code?.startsWith('FST_') && err.statusCode !== undefined && err.statusCode < 500) {
    return new DevRoundsError('DR101', { path: '/', reason: err.message })
  }
  return null
}

export function buildServer(opts: ServerOptions) {
  const app = Fastify({
    logger: opts.logger ?? true,
    // Reject unknown body fields instead of silently dropping them.
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorateRequest('owner', null)
  app.decorate('sessionAuth', opts.sessionAuth ?? null)

  for (const type of ['text/yaml', 'application/yaml']) {
    app.addContentTypeParser(type, { parseAs: 'string' }, (_req, body, done) => done(null, body))
  }

  app.setErrorHandler((err: FastifyError, request, reply) => {
    const error = inputError(err) ?? toDevRoundsError(err)
    const { text, hint, httpStatus } = explain(error.code, error.data)
    // 5xx data carries raw internal messages (DR501's cause): log it, never send it.
    if (httpStatus >= 500) request.log.error({ err, code: error.code, data: error.data }, 'request failed')
    const data = httpStatus >= 500 ? {} : error.data
    return reply.code(httpStatus).send({ code: error.code, text, hint, data })
  })

  // Not DR201: that one is about plan keys. A wrong route usually means the CLI and the server versions differ.
  app.setNotFoundHandler(async (request) => fail('DR202', { route: `${request.method} ${request.url}` }))

  app.get('/api/health', async () => ({ ok: true, version: pkg.version }))

  const { sessionAuth } = opts
  if (sessionAuth) app.register(authRoutes, { sessionAuth })

  const sessions = opts.sessions ?? new Sessions()
  const limiter = opts.pairingLimiter ?? new PairingLimiter()
  app.register(fastifyWebsocket, { options: { maxPayload: MAX_PAYLOAD } })
  app.register(projectRoutes, { prefix: '/api/projects/:key', db: opts.db })
  const logsRoot = opts.logsRoot ?? defaultLogsRoot()
  const telemetry = opts.telemetry ?? null
  app.register(runRoutes, { prefix: '/api/projects/:key', db: opts.db, sessions, logsRoot })
  app.register(jobRoutes, { prefix: '/api/projects/:key', db: opts.db })
  app.register(gateRoutes, { prefix: '/api/projects/:key', db: opts.db })
  app.register(viewRoutes, { prefix: '/api/projects/:key', db: opts.db })
  app.register(machineRoutes, { prefix: '/api/machines', db: opts.db, sessions })
  app.register(executorRoutes, {
    prefix: '/api/executor',
    db: opts.db,
    sessions,
    limiter,
    logsRoot,
    telemetry,
    scheduler: opts.scheduler,
    pingMs: opts.pingMs,
  })

  const webDir = opts.webDir ?? DEFAULT_WEB_DIR
  app.register(async (instance) => {
    const found = await stat(webDir).then(
      (s) => s.isDirectory(),
      () => false,
    )
    // Exact /api routes win over the static wildcard in Fastify's router, so the API is never shadowed.
    if (found) await instance.register(fastifyStatic, { root: webDir, prefix: '/' })
  })

  return app
}

// Better Auth parses bodies itself. This plugin reads every body as text under the server's bodyLimit and hands it over
// as `raw.body`, which Better Auth's node handler uses once the stream is consumed. Encapsulated: the rest of the API
// keeps its JSON and YAML parsers.
async function authRoutes(app: FastifyInstance, { sessionAuth }: { sessionAuth: SessionAuth }): Promise<void> {
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: app.initialConfig.bodyLimit }, (_req, body, done) =>
    done(null, body),
  )
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      reply.hijack()
      const raw = request.raw as typeof request.raw & { body?: unknown }
      raw.body = request.body
      raw.headers[CLIENT_IP_HEADER] = request.ip
      try {
        await sessionAuth.handler(raw, reply.raw)
      } catch (err) {
        // Hijacked: Fastify's error handler no longer answers, so an unanswered socket would hang until it times out.
        request.log.error({ err }, 'session auth request failed')
        if (!reply.raw.headersSent) {
          const { text, hint } = explain('DR501')
          reply.raw.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          reply.raw.end(JSON.stringify({ code: 'DR501', text, hint, data: {} }))
        } else reply.raw.end()
      }
    },
  })
}

export type Server = ReturnType<typeof buildServer>
