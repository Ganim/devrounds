import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { FastifyBaseLogger } from 'fastify'
import type { Kysely } from 'kysely'
import type { WebSocket } from 'ws'
import { bearer } from '../auth/tokens.ts'
import { toDevRoundsError } from '../convert-error.ts'
import type { Database } from '../db/schema.ts'
import { DevRoundsError } from '../errors/error.ts'
import { type PairingLimiter, redeemPairingCode, resolveMachineToken } from '../machines/pairing.ts'
import { CLOSE_REVOKED, recordHello, recordReport } from '../machines/service.ts'
import { type ControlPlaneMessage, checkHello, PROTOCOL, parseExecutorMessage } from './protocol.ts'

// WebSocket close codes the executor acts on: 4400 protocol (no or bad Hello), 4401 token (pair again, see
// CLOSE_REVOKED), 4409 replaced by a newer session of the same machine (do not reconnect and steal it back).
export const CLOSE_PROTOCOL = 4400
export const CLOSE_REPLACED = 4409
// RFC 6455 "internal error"; data stays out of the reason like 5xx bodies (see server.ts).
const CLOSE_INTERNAL = 1011
export const HELLO_TIMEOUT_MS = 10_000
// A LogSegment carries at most 1 MiB compressed, ~1.4 MiB as base64.
export const MAX_PAYLOAD = 4 * 1024 * 1024

// A close reason is at most 123 bytes of UTF-8.
const MAX_REASON_BYTES = 123

type Session = { tenantId: string; socket: WebSocket }

// The reason the executor reads: `DR### <data json>`, the same line it prints for its own errors.
function reasonOf(error: DevRoundsError): string {
  let reason = `${error.code} ${JSON.stringify(error.data)}`
  while (Buffer.byteLength(reason) > MAX_REASON_BYTES) reason = reason.slice(0, -1)
  return reason
}

const REASONS: Record<number, string> = {
  [CLOSE_REVOKED]: reasonOf(new DevRoundsError('DR452')),
  [CLOSE_REPLACED]: 'replaced by a newer session of this machine',
}

/** Live executor sessions of this process, one per machine. */
export class Sessions {
  #live = new Map<string, Session>()

  get(machineId: string): Session | undefined {
    return this.#live.get(machineId)
  }

  /** False when the machine has no live session. */
  send(machineId: string, message: ControlPlaneMessage): boolean {
    const session = this.#live.get(machineId)
    if (!session) return false
    session.socket.send(JSON.stringify(message))
    return true
  }

  close(machineId: string, code: number): void {
    const session = this.#live.get(machineId)
    if (!session) return
    this.#live.delete(machineId)
    session.socket.close(code, REASONS[code])
  }

  // A newer session wins: after an executor restart the old process may still hold a socket that has not timed out.
  open(machineId: string, session: Session): void {
    this.close(machineId, CLOSE_REPLACED)
    this.#live.set(machineId, session)
  }

  ended(machineId: string, session: Session): void {
    if (this.#live.get(machineId) === session) this.#live.delete(machineId)
  }
}

type GatewayOptions = { db: Kysely<Database>; sessions: Sessions; limiter: PairingLimiter }

// Messages are handled one at a time, in arrival order, on a promise chain: the listener must be attached before the
// token lookup awaits, or frames sent right after the upgrade are lost.
function serveSession(
  socket: WebSocket,
  authorization: string | undefined,
  opts: GatewayOptions,
  log: FastifyBaseLogger,
) {
  const { db, sessions } = opts
  let machine: { tenantId: string; machineId: string } | undefined
  let session: Session | undefined
  let closed = false

  const end = (code: number, error: DevRoundsError) => {
    if (closed) return
    closed = true
    if (machine && session) sessions.ended(machine.machineId, session)
    socket.close(code, reasonOf(error))
  }

  const hello = setTimeout(
    () =>
      end(CLOSE_PROTOCOL, new DevRoundsError('DR150', { type: 'Hello', path: '/', reason: 'no Hello within 10 s' })),
    HELLO_TIMEOUT_MS,
  )

  const handle = async (text: string) => {
    if (closed || !machine) return
    const ctx = { db, tenantId: machine.tenantId }
    let message: ReturnType<typeof parseExecutorMessage>
    try {
      message = parseExecutorMessage(text)
    } catch (err) {
      if (!session) return end(CLOSE_PROTOCOL, toDevRoundsError(err))
      // One bad frame does not end a session that runs work; the executor and control plane differ in version.
      log.warn({ err, machineId: machine.machineId }, 'executor message rejected')
      return
    }
    if (!session) {
      if (message.type !== 'Hello') {
        const reason = 'the first message must be Hello'
        return end(CLOSE_PROTOCOL, new DevRoundsError('DR150', { type: message.type, path: '/type', reason }))
      }
      const features = checkHello(message)
      clearTimeout(hello)
      session = { tenantId: machine.tenantId, socket }
      sessions.open(machine.machineId, session)
      // Revoked between the token lookup and now: the update finds no live row.
      const lastSeq = await recordHello(ctx, machine.machineId, message.version)
      if (lastSeq === null) return end(CLOSE_REVOKED, new DevRoundsError('DR452'))
      if (closed) return
      sessions.send(machine.machineId, {
        type: 'HelloAck',
        protocol: PROTOCOL,
        features,
        machine_id: machine.machineId,
        last_seq: Number(lastSeq),
      })
      return
    }
    if (message.type === 'MachineReport') await recordReport(ctx, machine.machineId, message)
    // Events and log chunks are handled from Task 12 on; unknown types are ignored by design.
  }

  // A server fault (the database, usually): logged here, never sent to the client, and the executor reconnects
  // after its backoff.
  const internal = (err: unknown, message: string) => {
    log.error({ err, machineId: machine?.machineId }, message)
    end(CLOSE_INTERNAL, new DevRoundsError('DR501'))
  }

  let chain = resolveMachineToken(db, bearer(authorization)).then(
    (found) => {
      machine = found
    },
    (err) => {
      // Only a token the control plane rejected closes 4401: the executor stops for good and needs a new pairing.
      if (err instanceof DevRoundsError && err.code === 'DR452') return end(CLOSE_REVOKED, err)
      internal(err, 'machine token lookup failed')
    },
  )
  socket.on('message', (data) => {
    const text = data.toString()
    chain = chain
      .then(() => handle(text))
      .catch((err) => {
        const error = toDevRoundsError(err)
        if (error.code !== 'DR501') return end(CLOSE_PROTOCOL, error)
        internal(err, 'executor message failed')
      })
  })
  socket.on('close', () => {
    clearTimeout(hello)
    closed = true
    if (machine && session) sessions.ended(machine.machineId, session)
  })
}

// Executor-facing routes. Neither carries a member token: pairing trades a one-time code for a machine token, and
// the session authenticates with that token.
export const executorRoutes: FastifyPluginAsyncTypebox<GatewayOptions> = async (app, opts) => {
  app.post(
    '/pair',
    {
      schema: {
        body: Type.Object(
          {
            code: Type.String({ maxLength: 64 }),
            os: Type.String({ minLength: 1, maxLength: 100 }),
            version: Type.String({ minLength: 1, maxLength: 100 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    (request) => {
      const { code, os, version } = request.body
      return redeemPairingCode(opts.db, opts.limiter, code, { os, version })
    },
  )

  app.get('/connect', { websocket: true }, (socket, request) =>
    serveSession(socket, request.headers.authorization, opts, request.log),
  )
}
