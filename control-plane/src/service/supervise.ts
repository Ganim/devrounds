import { spawn } from 'node:child_process'
import { appendFile, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isMain } from '../is-main.ts'

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

// One file per day and process, so a log never grows past a day of output.
const logFile = (name: string) => join(LOG_DIR, `${name}-${new Date().toISOString().slice(0, 10)}.log`)

async function log(line: string): Promise<void> {
  await appendFile(logFile('supervisor'), `${new Date().toISOString()} ${line}\n`)
}

// Resolves with the uptime when the child exits. The IPC channel ties serve's life to this process (see main.ts).
async function runServe(): Promise<number> {
  const out = await open(logFile('serve'), 'a')
  const started = Date.now()
  try {
    const child = spawn(process.execPath, [SERVE, 'serve'], {
      stdio: ['ignore', out.fd, out.fd, 'ipc'],
      windowsHide: true,
    })
    await log(`serve started (pid ${child.pid})`)
    const reason = await new Promise<string>((resolve) => {
      child.once('error', (err) => resolve(`failed to start: ${err.message}`))
      child.once('exit', (code, signal) => resolve(`exited (code ${code}, signal ${signal})`))
    })
    const uptime = Date.now() - started
    await log(`serve ${reason} after ${Math.round(uptime / 1000)} s`)
    return uptime
  } finally {
    await out.close()
  }
}

async function supervise(): Promise<never> {
  await mkdir(LOG_DIR, { recursive: true })
  await log(`supervisor started (pid ${process.pid})`)
  let delay: number | null = null
  for (;;) {
    const uptime = await runServe()
    delay = nextDelay(delay, uptime)
    await log(`restarting serve in ${delay / 1000} s`)
    await sleep(delay)
  }
}

if (await isMain(import.meta.url)) await supervise()
