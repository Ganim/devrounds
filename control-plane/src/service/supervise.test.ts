import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { close } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { TEST_DATABASE_URL, testDb } from '../test-support/db.ts'
import { lockSupervisor, nextDelay } from './supervise.ts'

const SUPERVISE = fileURLToPath(new URL('./supervise.ts', import.meta.url))
// Startup of serve loads ~1100 modules; on a busy Windows disk under antivirus that has taken over a minute.
const START_BUDGET_MS = 120_000

test('restart delay doubles from 1 s to 30 s and starts over after 5 min up', () => {
  const delays: number[] = []
  let delay: number | null = null
  for (let i = 0; i < 7; i++) {
    delay = nextDelay(delay, 1_000)
    delays.push(delay)
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  assert.equal(nextDelay(30_000, 5 * 60_000), 1_000)
})

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as { port: number }
  probe.close()
  await once(probe, 'close')
  return port
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// The pids the supervisor logged: its own and the latest serve's.
async function loggedPids(logDir: string): Promise<{ supervisor?: number; serve?: number }> {
  let text = ''
  try {
    for (const name of await readdir(logDir)) {
      if (name.startsWith('supervisor-')) text += await readFile(join(logDir, name), 'utf8')
    }
  } catch {
    return {}
  }
  const last = (re: RegExp) => {
    const all = [...text.matchAll(re)]
    return all.length ? Number(all[all.length - 1][1]) : undefined
  }
  return { supervisor: last(/supervisor started \(pid (\d+)/g), serve: last(/serve started \(pid (\d+)\)/g) }
}

// The scheduled task runs supervise under `conhost --headless`, and `schtasks /End` kills only that conhost. The test
// starts supervise the same way and kills the conhost with TerminateProcess; nothing of the real install is touched:
// home (so the supervisor's logs), port and logs root are all temporary.
test('supervise and its serve exit when the process that started supervise is killed hard', {
  skip: process.platform !== 'win32',
  timeout: START_BUDGET_MS + 60_000,
}, async (t) => {
  await testDb()
  const scratch = join(fileURLToPath(new URL('../../../', import.meta.url)), '.superpowers', 'tmp')
  await mkdir(scratch, { recursive: true })
  const home = await mkdtemp(join(scratch, 'devrounds-supervise-'))
  const logDir = join(home, '.devrounds', 'logs')
  const port = await freePort()
  // conhost, as in the task. Not node: libuv puts a node parent's children in a kill-on-close job, so a node stand-in
  // would take supervise down with it and hide the bug.
  const standIn = spawn(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe'),
    ['--headless', process.execPath, SUPERVISE],
    {
      env: {
        ...process.env,
        USERPROFILE: home,
        DEVROUNDS_DATABASE_URL: TEST_DATABASE_URL,
        DEVROUNDS_PORT: String(port),
        DEVROUNDS_LOGS_ROOT: join(home, 'run-logs'),
        DEVROUNDS_OTLP_ENDPOINT: '',
        DEVROUNDS_LOG_RETENTION_DAYS: '36500',
      },
      // Pipes, not 'ignore': a headless conhost given null handles exits at once without starting anything.
      stdio: 'pipe',
      windowsHide: true,
    },
  )
  standIn.stdout?.resume()
  standIn.stderr?.resume()
  let pids: { supervisor?: number; serve?: number } = {}
  t.after(async () => {
    for (const pid of [standIn.pid, pids.supervisor, pids.serve]) {
      if (pid && alive(pid)) process.kill(pid)
    }
    await sleep(500)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  const deadline = Date.now() + START_BUDGET_MS
  let healthy = false
  while (!healthy && Date.now() < deadline) {
    await sleep(200)
    healthy = await fetch(`http://127.0.0.1:${port}/api/health`).then(
      (res) => res.ok,
      () => false,
    )
  }
  pids = await loggedPids(logDir)
  assert.ok(healthy && pids.supervisor && pids.serve, `serve never came up under supervise: ${JSON.stringify(pids)}`)

  await promisify(execFile)('taskkill', ['/F', '/PID', String(standIn.pid)], { windowsHide: true })
  const gone = Date.now() + 10_000
  while ((alive(pids.supervisor) || alive(pids.serve)) && Date.now() < gone) await sleep(200)
  assert.equal(alive(pids.supervisor), false, 'supervise outlived the process that started it')
  assert.equal(alive(pids.serve), false, 'serve outlived its supervisor')
})

// The incident of 18/11: stopping the task left supervise running, and the task's next trigger started a second one
// beside it. The lock is held by a stand-in process, so the test can also kill it hard and see the OS release it.
test('a supervisor started beside a running one exits without starting serve, and a dead holder frees the lock', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, async (t) => {
  const scratch = join(fileURLToPath(new URL('../../../', import.meta.url)), '.superpowers', 'tmp')
  await mkdir(scratch, { recursive: true })
  const home = await mkdtemp(join(scratch, 'devrounds-supervise-lock-'))
  const lock = join(home, '.devrounds', 'supervise.lock')
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { lockSupervisor } = await import(${JSON.stringify(new URL('./supervise.ts', import.meta.url).href)})
       if ((await lockSupervisor(${JSON.stringify(lock)})) === undefined) process.exit(1)
       console.log('held')
       setInterval(() => {}, 60_000)`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  )
  let second: ReturnType<typeof spawn> | undefined
  t.after(async () => {
    for (const child of [holder, second]) if (child?.exitCode === null) child.kill()
    await sleep(500)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const [held] = await once(holder.stdout as NodeJS.ReadableStream, 'data')
  assert.equal(String(held).trim(), 'held')

  // Should the lock not hold, this one starts serve: on a free port and the test database, never the live ones.
  second = spawn(process.execPath, [SUPERVISE], {
    env: {
      ...process.env,
      USERPROFILE: home,
      DEVROUNDS_DATABASE_URL: TEST_DATABASE_URL,
      DEVROUNDS_PORT: String(await freePort()),
      DEVROUNDS_LOGS_ROOT: join(home, 'run-logs'),
      DEVROUNDS_OTLP_ENDPOINT: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  const [code] = await Promise.race([once(second, 'exit'), sleep(30_000).then(() => ['still running'])])
  assert.equal(code, 0)
  const logged = await loggedPids(join(home, '.devrounds', 'logs'))
  assert.equal(logged.serve, undefined, 'the second supervisor started serve')

  // TerminateProcess, as a crash: the OS closes the holder's handle, so nothing is left behind to clean up.
  holder.kill()
  await once(holder, 'exit')
  const fd = await lockSupervisor(lock)
  assert.notEqual(fd, undefined, 'the lock outlived the process that held it')
  if (fd !== undefined) await promisify(close)(fd)
})
