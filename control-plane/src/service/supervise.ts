import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isMain } from '../is-main.ts'
import { KEEP_DAYS, LogWriter, MAX_LOG_BYTES, pruneLogs, safely } from './logs.ts'

// Keeps `main.ts serve` running. Task Scheduler only restarts a task that fails to start, so crash restarts are
// owned here; the scheduled task's 5-minute trigger (IgnoreNew) only brings this supervisor back if it dies.

const FIRST_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
// A serve that stayed up this long was healthy: its next crash starts the backoff over.
const HEALTHY_UPTIME_MS = 5 * 60_000

export function nextDelay(previousMs: number | null, uptimeMs: number): number {
  if (previousMs === null || uptimeMs >= HEALTHY_UPTIME_MS) return FIRST_DELAY_MS
  return Math.min(previousMs * 2, MAX_DELAY_MS)
}

const LOG_DIR = join(homedir(), '.devrounds', 'logs')
const SERVE = fileURLToPath(new URL('../main.ts', import.meta.url))

const prune = () => safely(() => pruneLogs(LOG_DIR, new Date(), KEEP_DAYS))
// Serve output goes through the supervisor (not straight to a file) so one file cannot grow without bound while a
// serve lives for weeks: files are named by UTC write day and roll over at MAX_LOG_BYTES.
const supervisorLog = new LogWriter(LOG_DIR, 'supervisor', MAX_LOG_BYTES, undefined, () => void prune())
const serveLog = new LogWriter(LOG_DIR, 'serve', MAX_LOG_BYTES, undefined, () => void prune())

async function log(line: string): Promise<void> {
  await safely(() => supervisorLog.write(Buffer.from(`${new Date().toISOString()} ${line}\n`)))
}

// Resolves with the uptime when the child exits. The IPC channel ties serve's life to this process (see main.ts).
async function runServe(): Promise<number> {
  const started = Date.now()
  const child = spawn(process.execPath, [SERVE, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  const pipe = (chunk: Buffer) => void serveLog.write(chunk).catch(() => {})
  child.stdout?.on('data', pipe)
  child.stderr?.on('data', pipe)
  await log(`serve started (pid ${child.pid})`)
  const reason = await new Promise<string>((resolve) => {
    child.once('error', (err) => resolve(`failed to start: ${err.message}`))
    child.once('exit', (code, signal) => resolve(`exited (code ${code}, signal ${signal})`))
  })
  const uptime = Date.now() - started
  await log(`serve ${reason} after ${Math.round(uptime / 1000)} s`)
  return uptime
}

async function supervise(): Promise<never> {
  await prune()
  await log(`supervisor started (pid ${process.pid})`)
  let delay: number | null = null
  for (;;) {
    const uptime = await runServe()
    delay = nextDelay(delay, uptime)
    await log(`restarting serve in ${delay / 1000} s`)
    await prune()
    await sleep(delay)
  }
}

if (await isMain(import.meta.url)) await supervise()
