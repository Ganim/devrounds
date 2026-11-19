import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
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

// How often the parent is looked at, and how often its pid is checked against reuse (a PowerShell start each time,
// slow under antivirus, so rarely).
const PARENT_POLL_MS = 1_000
const PARENT_REUSE_CHECK_MS = 5 * 60_000
// How long a serve gets to close after its IPC channel is dropped before this process exits anyway.
const SERVE_STOP_MS = 10_000

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

let serving: ChildProcess | undefined
let stopping = false

// Resolves with the uptime when the child exits. The IPC channel ties serve's life to this process (see main.ts).
async function runServe(): Promise<number> {
  const started = Date.now()
  const child = spawn(process.execPath, [SERVE, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  serving = child
  const pipe = (chunk: Buffer) => serveLog.enqueue(chunk)
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

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but this account may not signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const run = promisify(execFile)

// When the process now holding `pid` started, or undefined when that cannot be read (gone, or no access).
async function startedAt(pid: number): Promise<number | undefined> {
  const query = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], {
      windowsHide: true,
    })
    const time = Date.parse(stdout.trim())
    return Number.isNaN(time) ? undefined : time
  } catch {
    return undefined
  }
}

// The scheduled task starts this process under `conhost --headless`, and stopping the task (`schtasks /End`,
// Stop-ScheduledTask) kills only that conhost. Without this, the supervisor and its serve outlive the task, keep the
// port with the old code, and the next task instance crash-loops serve on the taken port. Started by hand from a
// shell, the shell is the parent: closing it stops the supervisor too.
//
// A pid alone can name another process once the parent is gone. The parent necessarily started before this process,
// so a process at that pid that started later is a reuse, and counts as the parent being gone.
async function watchParent(onGone: () => Promise<void>): Promise<void> {
  const parent = process.ppid
  const self = Date.now() - process.uptime() * 1000
  let lastReuseCheck = Date.now()
  for (;;) {
    await sleep(PARENT_POLL_MS)
    let gone = !exists(parent)
    if (!gone && process.platform === 'win32' && Date.now() - lastReuseCheck >= PARENT_REUSE_CHECK_MS) {
      lastReuseCheck = Date.now()
      const started = await startedAt(parent)
      gone = started === undefined ? !exists(parent) : started > self
    }
    if (gone) return onGone()
  }
}

// Drops serve's IPC channel so it closes on its own (main.ts stops on 'disconnect'), then exits. Exiting at once
// would also end serve, since node puts its children in a kill-on-close job, but without letting it close cleanly.
async function stopForGoneParent(): Promise<void> {
  stopping = true
  await log(`parent (pid ${process.ppid}) is gone: stopping serve and exiting`)
  const child = serving
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    if (child.connected) child.disconnect()
    await Promise.race([exited, sleep(SERVE_STOP_MS)])
  }
  process.exit(0)
}

async function supervise(): Promise<never> {
  await prune()
  await log(`supervisor started (pid ${process.pid}, parent ${process.ppid})`)
  void watchParent(stopForGoneParent)
  let delay: number | null = null
  for (;;) {
    const uptime = await runServe()
    // Exiting already (stopForGoneParent): no new serve meanwhile.
    if (stopping) await new Promise(() => {})
    delay = nextDelay(delay, uptime)
    await log(`restarting serve in ${delay / 1000} s`)
    await prune()
    await sleep(delay)
    if (stopping) await new Promise(() => {})
  }
}

if (await isMain(import.meta.url)) await supervise()
