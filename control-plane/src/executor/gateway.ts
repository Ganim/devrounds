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
import type { TenantCtx, Trx } from '../planning/resolve.ts'
import { pendingOffers, runEvents } from '../runs/dispatch.ts'
import { type LogCtx, storeSegment } from '../runs/log-store.ts'
import { applyOrphans, applyRunEvent, pendingOrphanStops, reportFinished } from '../runs/record.ts'
import type { Telemetry } from '../telemetry/otel.ts'
import { withTenant } from '../tenancy/scope.ts'
import {
  type ControlPlaneMessage,
  checkHello,
  type EventMessage,
  PROTOCOL,
  parseExecutorMessage,
  SeqTracker,
} from './protocol.ts'

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

type GatewayOptions = {
  db: Kysely<Database>
  sessions: Sessions
  limiter: PairingLimiter
  logsRoot: string
  telemetry?: Telemetry | null
}

// Moves machines.last_seq to `seq`, only while it is below: the row lock and condition keep a replaced session still
// draining frames from applying a seq the newer one already did. False when the seq was applied already.
async function advanceLastSeq(trx: Trx, machineId: string, seq: number): Promise<boolean> {
  const row = await trx
    .updateTable('machines')
    .set({ last_seq: seq })
    .where('id', '=', machineId)
    .where('last_seq', '<', String(seq))
    .returning('id')
    .executeTakeFirst()
  return row !== undefined
}

type Rejected = { code: string; machineId: string; seq: number; run?: string }

// A rejected event is deterministic: replaying it fails the same way, so its seq counts as applied (nothing else
// changes) or it would block every later event. Only the code and identifiers are logged, never the payload.
async function skipEvent(ctx: TenantCtx, rejected: Rejected, log: FastifyBaseLogger) {
  log.warn(rejected, 'executor event rejected; counted as applied')
  await withTenant(ctx.db, ctx.tenantId, (trx) => advanceLastSeq(trx, rejected.machineId, rejected.seq))
}

/**
 * Applies one new event and moves machines.last_seq to its seq in one transaction, so after a crash the executor
 * resends exactly what was not applied. An event applyRunEvent rejects with a DevRounds code below DR5xx (DR351,
 * DR201, an input code) rolls back and is skipped (skipEvent); any other failure, DR5xx included, throws and closes
 * the session 1011, so the executor resends it later. Unknown event kinds advance last_seq and change nothing else. The Stops an Orphans event answers
 * go out through `reply` after the commit and before the caller's Ack: the executor reads an Ack of its Orphans event
 * with no Stop before it as the let_finish policy.
 */
async function applyEvent(
  ctx: LogCtx,
  machineId: string,
  message: EventMessage,
  log: FastifyBaseLogger,
  reply: (message: ControlPlaneMessage) => void,
  telemetry: Telemetry | null,
) {
  try {
    const applied = await withTenant(ctx.db, ctx.tenantId, async (trx) => {
      const none = { changed: [] as string[], replies: [] as ControlPlaneMessage[] }
      const { event } = message
      if (!(await advanceLastSeq(trx, machineId, message.seq)) || event.kind === 'Unknown') return none
      // A segment changes no run state, so nobody waiting on the run is woken for it.
      if (event.kind === 'LogSegment') {
        await storeSegment({ ...ctx, trx }, event.run, event, { machineId })
        return none
      }
      const at = new Date(message.at)
      if (event.kind === 'Orphans') {
        const replies = await applyOrphans({ ...ctx, trx }, machineId, event, at, log)
        return { changed: event.runs.map((orphan) => orphan.run), replies }
      }
      await applyRunEvent({ ...ctx, trx }, machineId, event, at, log)
      return { changed: [event.run], replies: [] }
    })
    for (const message of applied.replies) reply(message)
    // After the commit, so a waiting `GET /runs/:id?wait` reads the new state.
    for (const run of applied.changed) runEvents.emit('changed', run)
    // Only for a RunFinished applied now, never for a repeat of one already applied.
    if (telemetry && message.event.kind === 'RunFinished' && applied.changed.length > 0) {
      await reportFinished(ctx, telemetry, message.event.run, log)
    }
  } catch (err) {
    // A DR5xx is this side's fault (DR501 wraps a database error), not the event's: a replay can succeed.
    if (!(err instanceof DevRoundsError) || err.code.startsWith('DR5')) throw err
    const run = 'run' in message.event ? message.event.run : undefined
    await skipEvent(ctx, { code: err.code, machineId, seq: message.seq, run }, log)
  }
}

// The seq of an Event frame that failed its shape check, when the envelope still names a usable one.
function rejectedSeq(text: string): number | undefined {
  try {
    const value = JSON.parse(text) as { type?: unknown; seq?: unknown } | null
    const seq = value?.seq
    if (value?.type !== 'Event' || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
    return seq
  } catch {
    return undefined
  }
}

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
  // From HelloAck on: the last seq applied for this machine, as of this session.
  let tracker: SeqTracker | undefined
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
    const ctx = { db, tenantId: machine.tenantId, logsRoot: opts.logsRoot }
    let message: ReturnType<typeof parseExecutorMessage>
    try {
      message = parseExecutorMessage(text)
    } catch (err) {
      if (!session) return end(CLOSE_PROTOCOL, toDevRoundsError(err))
      // One bad frame does not end a session that runs work; the executor and control plane differ in version.
      const seq = rejectedSeq(text)
      if (seq === undefined || !tracker) {
        log.warn({ err, machineId: machine.machineId }, 'executor message rejected')
        return
      }
      // A malformed event still takes its place in the sequence, or the gap behind it would never close.
      const { code } = toDevRoundsError(err)
      const rejected = { code, machineId: machine.machineId, seq }
      return sequenced(seq, () => skipEvent(ctx, rejected, log))
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
      tracker = new SeqTracker(lastSeq)
      sessions.send(machine.machineId, {
        type: 'HelloAck',
        protocol: PROTOCOL,
        features,
        machine_id: machine.machineId,
        last_seq: Number(lastSeq),
      })
      // Offers lost with an earlier session; on the chain, so they go out before any later frame is handled.
      for (const offer of await pendingOffers(ctx, machine.machineId)) reply(offer)
      // Orphan Stops lost the same way; they must precede this session's first Ack (see pendingOrphanStops).
      for (const stop of await pendingOrphanStops(ctx, machine.machineId)) reply(stop)
      return
    }
    if (message.type === 'MachineReport') await recordReport(ctx, machine.machineId, message)
    if (message.type === 'Event') {
      const event = message
      const { machineId } = machine
      await sequenced(event.seq, () => applyEvent(ctx, machineId, event, log, reply, opts.telemetry ?? null))
    }
    // LogChunk is live output for watchers, and stage 1 has none, so it is dropped; the durable copy arrives as
    // LogSegment events. Unknown types are ignored by design.
  }

  // Ack is cumulative, so it always names tracker.lastSeq, the last applied seq, never the incoming one: acking an
  // ahead-of-gap event would let the executor drop the events still missing.
  // `apply` runs only for the next seq.
  const sequenced = async (seq: number, apply: () => Promise<void>) => {
    if (!tracker) return
    const verdict = tracker.accept(seq)
    if (verdict === 'gap') return reply({ type: 'Resync', from_seq: Number(tracker.lastSeq + 1n) })
    if (verdict === 'new') await apply()
    reply({ type: 'Ack', seq: Number(tracker.lastSeq) })
  }

  // This session's own socket: once replaced, sessions.send would reach the newer session.
  const reply = (message: ControlPlaneMessage) => {
    if (!closed) socket.send(JSON.stringify(message))
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
