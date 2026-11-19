import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { TEST_DATABASE_URL, testDb } from './test-support/db.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
// Startup loads ~1100 modules; on a busy Windows disk under antivirus that has taken over a minute.
const START_BUDGET_MS = 120_000

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as { port: number }
  probe.close()
  await once(probe, 'close')
  return port
}

// Spawned the way service/supervise.ts does it, IPC channel included: that channel alone keeps a child alive.
function serve(port: number, logsRoot: string): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, [MAIN, 'serve'], {
    env: {
      ...process.env,
      DEVROUNDS_DATABASE_URL: TEST_DATABASE_URL,
      DEVROUNDS_PORT: String(port),
      DEVROUNDS_LOGS_ROOT: logsRoot,
      DEVROUNDS_OTLP_ENDPOINT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  let stderr = ''
  child.stdout?.resume()
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  return { child, stderr: () => stderr }
}

async function healthy(port: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return true
    } catch {
      // Not listening yet.
    }
    await sleep(200)
  }
  return false
}

test('serve listens, and a second serve on the same port exits instead of hanging', {
  timeout: 2 * START_BUDGET_MS + 10_000,
}, async (t) => {
  await testDb()
  const scratch = join(fileURLToPath(new URL('../../', import.meta.url)), '.superpowers', 'tmp')
  await mkdir(scratch, { recursive: true })
  const logsRoot = await mkdtemp(join(scratch, 'devrounds-serve-'))
  const port = await freePort()
  const first = serve(port, logsRoot)
  t.after(async () => {
    first.child.kill()
    await rm(logsRoot, { recursive: true, force: true })
  })
  assert.ok(await healthy(port, Date.now() + START_BUDGET_MS), first.stderr())

  const second = serve(port, logsRoot)
  t.after(() => second.child.kill())
  const exited = once(second.child, 'exit')
  const deadline = Date.now() + START_BUDGET_MS
  while (!second.stderr().includes('EADDRINUSE') && second.child.exitCode === null && Date.now() < deadline) {
    await sleep(200)
  }
  assert.match(second.stderr(), /EADDRINUSE/)
  // Once the failure is reported nothing may keep it alive, or the supervisor never gets to restart it.
  const result = await Promise.race([exited, sleep(10_000, 'still running')])
  assert.notEqual(result, 'still running', `a serve that cannot listen must exit:\n${second.stderr()}`)
  assert.notEqual((result as [number | null])[0], 0)
})
