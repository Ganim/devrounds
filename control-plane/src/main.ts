#!/usr/bin/env node
import { buildServer } from './api/server.ts'
import { loadServerConfig } from './config.ts'
import { toDevRoundsError } from './convert-error.ts'
import { createDb } from './db/connection.ts'
import { explain } from './errors/error.ts'
import { pruneLogSegments } from './runs/log-store.ts'
import { startTelemetry } from './telemetry/otel.ts'

// The control plane. `serve` never migrates (that needs the owner URL; see `devrounds-admin migrate`) and binds to
// loopback only: the API is reached locally or through the local reverse proxy.
async function serve(): Promise<void> {
  const config = await loadServerConfig()
  const db = createDb(config.databaseUrl)
  const telemetry = await startTelemetry(config.otlpEndpoint)
  const app = buildServer({ db, logsRoot: config.logsRoot, telemetry })
  // At start and then hourly; a failed prune is logged and the next one tries again.
  const prune = () =>
    pruneLogSegments(db, config.logsRoot, new Date(), config.logRetentionDays).catch((err) =>
      app.log.error({ err }, 'log segment prune failed'),
    )
  const pruning = setInterval(prune, PRUNE_EVERY_MS)
  const stop = async () => {
    clearInterval(pruning)
    await app.close()
    await db.destroy()
    await telemetry?.shutdown()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // Only under the supervisor (it spawns serve with an IPC channel): when the supervisor dies, the channel closes and
  // serve stops too, so the next supervisor finds the port free instead of an orphan holding it.
  process.once('disconnect', stop)
  await app.listen({ host: '127.0.0.1', port: config.port })
  await prune()
}

const PRUNE_EVERY_MS = 60 * 60 * 1000

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
