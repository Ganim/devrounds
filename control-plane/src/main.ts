#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sql } from 'kysely'
import { IDEMPOTENCY_TTL_MS, pruneIdempotencyKeys } from './api/idempotency.ts'
import { buildServer } from './api/server.ts'
import { startAuth } from './auth/session.ts'
import { loadServerConfig } from './config.ts'
import { toDevRoundsError } from './convert-error.ts'
import { createDb } from './db/connection.ts'
import { explain, fail } from './errors/error.ts'
import { Sessions } from './executor/gateway.ts'
import { pruneLogSegments } from './runs/log-store.ts'
import { Scheduler } from './scheduler/scheduler.ts'
import { startTelemetry } from './telemetry/otel.ts'

// The control plane. `serve` never migrates (that needs the owner URL; see `devrounds-admin migrate`) and binds to
// loopback only: the API is reached locally or through the local reverse proxy.
async function serve(): Promise<void> {
  const config = await loadServerConfig()
  const db = createDb(config.databaseUrl)
  // Before the gateway listens, as a HelloAck pokes the scheduler and a tick expires offers: an offer still pending
  // was made by an earlier process, and its executor may have answered while no control plane was up to hear it.
  // Each gets a full timeout again instead of being withdrawn and requeued at the first tick.
  try {
    await sql`select rearm_offers(${config.offerTimeoutS})`.execute(db)
  } catch (err) {
    await db.destroy()
    throw err
  }
  // The app logger exists only once the server is built with the telemetry; until then SDK warnings go to stderr.
  let warn = (message: string) => console.error(message)
  const telemetry = await startTelemetry(config.otlpEndpoint, undefined, (message) => warn(message))
  // Session login only once `devrounds-admin migrate` has written authSecret; until then the token API alone works.
  const sessionAuth = config.authSecret
    ? await startAuth({ databaseUrl: config.databaseUrl, port: config.port, secret: config.authSecret })
    : undefined
  const sessions = new Sessions()
  // The scheduler is built before the server (the gateway pokes it) and logs through the server's logger once it exists.
  const scheduler = new Scheduler({
    db,
    sessions,
    offerTimeoutS: config.offerTimeoutS,
    pollMs: config.schedulerPollS * 1000,
    telemetry,
    log: {
      warn: (data, message) => app.log.warn(data, message),
      error: (data, message) => app.log.error(data, message),
    },
  })
  const app = buildServer({ db, logsRoot: config.logsRoot, telemetry, sessions, scheduler, sessionAuth })
  warn = (message) => app.log.warn(message)
  // At start and then hourly; a failed prune is logged and the next one tries again.
  const prune = () =>
    Promise.all([
      pruneLogSegments(db, config.logsRoot, new Date(), config.logRetentionDays).catch((err) =>
        app.log.error({ err }, 'log segment prune failed'),
      ),
      // Keys live IDEMPOTENCY_TTL_MS (runIdempotent); this removes the ones whose request never came back.
      pruneIdempotencyKeys(db, new Date(Date.now() - IDEMPOTENCY_TTL_MS)).catch((err) =>
        app.log.error({ err }, 'idempotency key prune failed'),
      ),
    ])
  const pruning = setInterval(prune, PRUNE_EVERY_MS)
  const stop = async () => {
    clearInterval(pruning)
    // First, so no tick claims against a closing pool or offers to a closing gateway.
    await scheduler.stop()
    // The 'disconnect' listener below keeps the IPC channel, and so this process, alive until it is closed.
    process.off('disconnect', stop)
    if (process.connected) process.disconnect()
    await app.close()
    await sessionAuth?.close()
    await db.destroy()
    await telemetry?.shutdown()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // Only under the supervisor (it spawns serve with an IPC channel): when the supervisor dies, the channel closes and
  // serve stops too, so the next supervisor finds the port free instead of an orphan holding it.
  process.once('disconnect', stop)
  try {
    await app.listen({ host: '127.0.0.1', port: config.port })
  } catch (err) {
    // Release the prune timer and the IPC channel, or a serve that cannot listen (port taken) prints the error and
    // then stays up forever, and the supervisor waiting for its exit never restarts it.
    await stop()
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      fail('DR504', { port: config.port, holder: await portHolder(config.port) })
    }
    throw err
  }
  // LISTEN uses the server's own URL on a dedicated connection, outside the pool.
  await scheduler.start(config.databaseUrl)
  await prune()
}

// Who listens on `port` on loopback or every address, for DR504. netstat, not Get-NetTCPConnection: no PowerShell
// start (seconds under antivirus), and the columns are the same in every Windows language, unlike the state word
// (a listener is the row whose remote address is `0.0.0.0:0`). Elsewhere, or when it cannot tell, the text stays
// generic.
async function portHolder(port: number): Promise<string> {
  const unknown = 'another process'
  if (process.platform !== 'win32') return unknown
  try {
    // Bounded: a hung netstat would keep this serve, which failed to listen, alive, and the supervisor never restarts it.
    const { stdout } = await promisify(execFile)('netstat', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
      timeout: NETSTAT_TIMEOUT_MS,
    })
    for (const line of stdout.split('\n')) {
      const [proto, local, remote, , pid] = line.trim().split(/\s+/)
      if (proto !== 'TCP' || remote !== '0.0.0.0:0' || !pid) continue
      if (local === `127.0.0.1:${port}` || local === `0.0.0.0:${port}`) return `process ${pid.trim()}`
    }
  } catch {
    // Fall back to the generic text: the port being taken is the news, the pid only helps.
  }
  return unknown
}

const PRUNE_EVERY_MS = 60 * 60 * 1000
const NETSTAT_TIMEOUT_MS = 15_000

const [command] = process.argv.slice(2)
if (command === 'serve') {
  try {
    await serve()
  } catch (err) {
    const error = toDevRoundsError(err)
    const { text, hint, exitCode } = explain(error.code, error.data)
    console.error(`${error.code}: ${text}\n${hint}`)
    if (error.code === 'DR501') console.error(String(error.data.cause))
    process.exitCode = exitCode
  }
} else {
  console.error('usage: main.ts serve')
  process.exitCode = 2
}
