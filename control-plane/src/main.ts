#!/usr/bin/env node
import { buildServer } from './api/server.ts'
import { loadConfig } from './config.ts'
import { toDevRoundsError } from './convert-error.ts'
import { createDb } from './db/connection.ts'
import { explain } from './errors/error.ts'

// The control plane. `serve` never migrates (that needs the owner URL; see `devrounds-admin migrate`) and binds to
// loopback only: the API is reached locally or through the local reverse proxy.
async function serve(): Promise<void> {
  const config = await loadConfig()
  const db = createDb(config.databaseUrl)
  const app = buildServer({ db })
  const stop = async () => {
    await app.close()
    await db.destroy()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await app.listen({ host: '127.0.0.1', port: config.port })
}

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
