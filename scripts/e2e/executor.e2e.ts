#!/usr/bin/env node
// pnpm e2e: the executor end to end on this machine, self-contained. Builds the release binaries, starts its own
// control plane on the test database (port 4993) and its own executor under `supervise` with a home in
// .superpowers/tmp and a tree-fixture copy of its own on PATH, pairs it into a fresh tenant, then runs:
//   synthetic  tree-fixture with 3 lingering children, placed by the scheduler: finished, stamped, swept, hidden,
//              steps and 1000 log lines
//   lint       `pnpm lint` of this repo through pnpm.cmd, placed by the scheduler: finished and hidden
//   orphan     `run` killed under a live run, restarted by its supervisor: the run is orphaned, killed, tree gone
//   re-pair    the machine revoked, the same home paired again as a new machine: synthetic finishes on it
// then measures both sides with scripts/footprint.ts after 60 s idle, and checks that `run` exits once its supervisor
// is gone. Nothing is installed; everything it started, and nothing else, is stopped at the end, so it can run beside
// an installed executor service.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bootstrap } from '../../control-plane/src/admin.ts'
import { runCli } from '../../control-plane/src/cli/commands.ts'
import { createDb } from '../../control-plane/src/db/connection.ts'
import { migrateToLatest } from '../../control-plane/src/db/migrate.ts'
import {
  TEST_ADMIN_URL,
  TEST_APP_PASSWORD,
  TEST_APP_ROLE,
  TEST_DATABASE_URL,
} from '../../control-plane/src/test-support/test-db-urls.ts'
import { footprint, IDLE_MS } from '../footprint.ts'

const run = promisify(execFile)

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const EXECUTOR_DIR = join(ROOT, 'executor')
const RELEASE = join(EXECUTOR_DIR, 'target', 'release')
const EXE = join(RELEASE, 'devrounds-executor.exe')
const FIXTURE = join(RELEASE, 'tree-fixture.exe')
const JOB_TYPES = join(ROOT, 'roadmap', 'fixtures', 'job-types')
const PORT = 4993
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'devrounds'
const TERMINAL = ['finished', 'failed', 'stopped', 'orphaned']

type RunJson = {
  id: string
  state: string
  timeline: Record<string, string | null>
  durations: Record<string, number | null>
  outcome: { exitCode: number | null; failureClass: string | null; failureSummary: string | null }
  resources: { peak: number | null; swept: number | null; visibleWindows: number | null }
  steps: { name: string; outcome: string | null }[]
}
type Proc = { ProcessId: number; CommandLine: string | null }

const started = Date.now()
const log = (line: string) => console.log(`[e2e ${((Date.now() - started) / 1000).toFixed(1)} s] ${line}`)

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`)
    await sleep(250)
  }
}

async function powershellJson<T>(script: string): Promise<T[]> {
  const command = `$ProgressPreference = 'SilentlyContinue'\nConvertTo-Json -Compress -InputObject @(${script})`
  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
  })
  return stdout.trim() === '' ? [] : (JSON.parse(stdout) as T[])
}

// Processes started from `exe`; other copies (an installed executor, a live service's jobs, the debug fixture of
// cargo test) are not ours.
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`
const processesOf = (exe: string, name: string) =>
  powershellJson<Proc>(
    `Get-CimInstance Win32_Process -Filter "name='${name}'" | Where-Object { $_.ExecutablePath -eq ${ps(exe)} } | ` +
      'Select-Object ProcessId, CommandLine',
  )
const executors = () => processesOf(EXE, 'devrounds-executor.exe')
const runProcess = async () => (await executors()).find((p) => /\srun\s+--supervised\s*$/.test(p.CommandLine ?? ''))
const kill = (pid: number) => run('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }).catch(() => {})

// A process seen under the e2e executor, by pid and start time so a reused pid is never killed at teardown.
type Snapshot = { ProcessId: number; ParentProcessId: number; Started: string }
const snapshot = () =>
  powershellJson<Snapshot>(
    "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, @{ n = 'Started'; e = { $_.CreationDate.ToString('o') } }",
  )

// Records every descendant of `root` alive now. Jobs other than tree-fixture (the lint job's pnpm and node) have no
// path of their own to find them by, and once their parent is gone the tree cannot be walked any more.
async function track(tracked: Map<number, string>, root: number): Promise<void> {
  const all = await snapshot()
  const below = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const p of all) {
      if (below.has(p.ParentProcessId) && !below.has(p.ProcessId)) {
        below.add(p.ProcessId)
        tracked.set(p.ProcessId, p.Started)
        grew = true
      }
    }
  }
}

function pathEnv(prepend: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // Windows names it Path; a second PATH key would make the child's value depend on sort order.
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  env[key] = `${prepend};${env[key] ?? ''}`
  return env
}

async function build(): Promise<void> {
  log('cargo build --release')
  const cargo = spawn('cargo', ['build', '--release'], { cwd: EXECUTOR_DIR, stdio: 'inherit', windowsHide: true })
  const code = await new Promise<number | null>((resolve, reject) => {
    cargo.once('error', reject)
    cargo.once('exit', resolve)
  })
  assert.equal(code, 0, 'cargo build --release failed')
}

async function main(): Promise<void> {
  await build()
  await mkdir(join(ROOT, '.superpowers', 'tmp'), { recursive: true })
  const tmp = await mkdtemp(join(ROOT, '.superpowers', 'tmp', 'e2e-'))
  const home = join(tmp, 'executor')
  // The jobs find `tree-fixture` on PATH: a copy of its own, so the tree checks and the teardown never touch the
  // tree-fixture of a live executor service, which runs the one in target\release or its own copy.
  const bin = join(tmp, 'bin')
  const fixture = join(bin, 'tree-fixture.exe')
  await mkdir(bin)
  await copyFile(FIXTURE, fixture)
  const fixtures = () => processesOf(fixture, 'tree-fixture.exe')
  // Every day log of the supervisor, in one string.
  const supervisorLog = async (): Promise<string> => {
    const files = (await readdir(join(home, 'logs'))).filter((f) => /^executor-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    assert.ok(files.length > 0, 'no executor-YYYY-MM-DD.log')
    return (await Promise.all(files.map((f) => readFile(join(home, 'logs', f), 'utf8')))).join('')
  }
  const tracked = new Map<number, string>()
  const admin = createDb(TEST_ADMIN_URL)
  const serveOutput: string[] = []
  let serve: ReturnType<typeof spawn> | undefined
  let supervise: ReturnType<typeof spawn> | undefined
  try {
    log('migrating the test database and bootstrapping a tenant')
    await migrateToLatest(TEST_ADMIN_URL, { appRole: TEST_APP_ROLE, appPassword: TEST_APP_PASSWORD })
    const { token } = await bootstrap(admin, TEST_APP_ROLE, {
      tenant: `e2e-${randomUUID()}`,
      project: PROJECT,
      name: 'E2E',
      human: 'e2e',
    })

    log(`control plane on ${BASE}`)
    serve = spawn(process.execPath, [join(ROOT, 'control-plane', 'src', 'main.ts'), 'serve'], {
      env: {
        ...process.env,
        DEVROUNDS_DATABASE_URL: TEST_DATABASE_URL,
        DEVROUNDS_PORT: String(PORT),
        DEVROUNDS_LOGS_ROOT: join(tmp, 'logs'),
        // Empty, not unset: an unset variable falls back to ~/.devrounds/server.json.
        DEVROUNDS_OTLP_ENDPOINT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // Warnings and errors only: every request logs at info (level 30).
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() !== '' && !line.includes('"level":30')) serveOutput.push(line)
      }
      serveOutput.splice(0, Math.max(0, serveOutput.length - 100))
    }
    serve.stdout?.on('data', keep)
    serve.stderr?.on('data', keep)
    const servePid = serve.pid ?? assert.fail('serve has no pid')

    const api = async <T>(path: string): Promise<T> => {
      const res = await fetch(`${BASE}/api${path}`, { headers: { authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`GET ${path} answered ${res.status}: ${await res.text()}`)
      return (await res.json()) as T
    }
    let notListening: unknown
    // As main.test.ts START_BUDGET_MS: right after the release build, the antivirus scanning the new files has held
    // serve's ~1100 module loads past 40 s on this machine, against 2 s once the disk is quiet.
    await until('the control plane to listen', 120_000, () =>
      api('/machines').then(
        () => true,
        (err) => {
          notListening = err
          return undefined
        },
      ),
    ).catch((err) => {
      throw new Error(`${(err as Error).message}; last answer: ${(notListening as Error)?.message}`)
    })

    const cliEnv = { DEVROUNDS_URL: BASE, DEVROUNDS_TOKEN: token, DEVROUNDS_PROJECT: PROJECT }
    const cli = async (...args: string[]): Promise<string> => {
      const r = await runCli(args, { env: cliEnv, configPath: join(tmp, 'cli.json') })
      if (r.exitCode !== 0) throw new Error(`devrounds ${args.join(' ')} exited ${r.exitCode}\n${r.stdout}${r.stderr}`)
      return r.stdout
    }

    const machine = `e2e-${randomBytes(4).toString('hex')}`
    const pairing = await cli('machine', 'pair-code', '--name', machine)
    const code = /pairing code for machine \S+: (\S+)/.exec(pairing)?.[1] ?? assert.fail(pairing)
    const executorEnv = { ...pathEnv(bin), DEVROUNDS_EXECUTOR_HOME: home }
    log(`pairing ${machine}; executor home ${home}`)
    await run(EXE, ['pair', '--url', BASE, '--code', code], { env: executorEnv, windowsHide: true })

    supervise = spawn(EXE, ['supervise'], { env: executorEnv, stdio: 'ignore', windowsHide: true })
    const supervisePid = supervise.pid ?? assert.fail('supervise has no pid')
    type MachineJson = { name: string; connected: boolean }
    await until('the executor to connect', 30_000, async () =>
      (await api<MachineJson[]>('/machines')).some((m) => m.name === machine && m.connected) ? true : undefined,
    )
    const firstRun = await until('supervise to start run', 10_000, runProcess)
    log(`executor connected: supervise ${supervisePid}, run ${firstRun.ProcessId}`)

    for (const file of ['synthetic.yaml', 'lint.yaml', 'orphan.yaml'])
      await cli('jobtype', 'set', join(JOB_TYPES, file))

    // No --machine: the scheduler places each run on the one connected machine once it has reported.
    const start = async (jobType: string, cwd: string): Promise<string> => {
      const out = await cli('run', 'start', jobType, '--cwd', cwd)
      return /run ([0-9a-f-]{36})/.exec(out)?.[1] ?? assert.fail(out)
    }
    const view = (id: string) => api<RunJson>(`/projects/${PROJECT}/runs/${id}`)
    const ended = (id: string, timeoutMs: number, onPoll?: () => Promise<void>) =>
      until(`run ${id} to end`, timeoutMs, async () => {
        await onPoll?.()
        const r = await view(id)
        return TERMINAL.includes(r.state) ? r : undefined
      })

    // synthetic
    log('synthetic: tree-fixture --children 3 --linger-ms 60000 --print 1000 --steps build,test --exit 0')
    const synthetic = await ended(await start('synthetic', tmp), 120_000)
    const detail = JSON.stringify(synthetic)
    assert.equal(synthetic.state, 'finished', detail)
    for (const [stamp, at] of Object.entries(synthetic.timeline)) assert.ok(at !== null, `timeline.${stamp} unset`)
    for (const [name, ms] of Object.entries(synthetic.durations)) {
      assert.ok(typeof ms === 'number' && ms >= 0, `durations.${name} = ${ms}`)
    }
    assert.equal(synthetic.resources.swept, 3, detail)
    assert.equal(synthetic.resources.visibleWindows, 0, detail)
    assert.deepEqual(
      synthetic.steps.map((s) => [s.name, s.outcome]),
      [
        ['build', 'finished'],
        ['test', 'finished'],
      ],
    )
    assert.ok((synthetic.resources.peak ?? 0) > 0, detail)
    // Segments may still ship after RunFinished: wait for the whole output.
    const lines = await until('1000 log lines', 30_000, async () => {
      const seen: string[] = []
      let cursor: string | undefined
      for (;;) {
        const out = await cli('run', 'logs', synthetic.id, ...(cursor ? ['--cursor', cursor] : []))
        seen.push(...out.split('\n').filter((line) => /^line \d+$/.test(line)))
        cursor = /^truncated; more: .* --cursor (\d+)$/m.exec(out)?.[1]
        if (!cursor) break
      }
      return seen.length >= 1000 ? seen : undefined
    })
    assert.equal(lines.length, 1000)
    assert.equal(lines.at(-1), 'line 1000')
    // The swept children were the only processes of this e2e's tree-fixture copy.
    await until('the swept tree to be gone', 10_000, async () => ((await fixtures()).length === 0 ? true : undefined))
    log(
      `synthetic finished: swept ${synthetic.resources.swept}, visible windows 0, peak ${synthetic.resources.peak} ` +
        `bytes, run ${synthetic.durations.runTimeMs} ms, 1000 log lines`,
    )

    // lint
    log('lint: pnpm lint in the repo root')
    const lint = await ended(await start('lint', ROOT.replace(/[\\/]$/, '')), 300_000, () =>
      track(tracked, supervisePid),
    )
    assert.equal(lint.state, 'finished', JSON.stringify(lint))
    assert.equal(lint.resources.visibleWindows, 0, JSON.stringify(lint))
    log(`lint finished in ${lint.durations.runTimeMs} ms, visible windows 0, swept ${lint.resources.swept}`)

    // orphan
    log('orphan: taskkill /F on run during a 60 s run')
    const orphanId = await start('orphan', tmp)
    await until('the orphan run to start', 30_000, async () =>
      (await view(orphanId)).state === 'running' ? true : undefined,
    )
    await until('the orphan tree (leader + 3 children)', 30_000, async () =>
      (await fixtures()).length >= 4 ? true : undefined,
    )
    const killed = (await runProcess()) ?? assert.fail('no run process')
    await kill(killed.ProcessId)
    const orphan = await ended(orphanId, 60_000)
    assert.equal(orphan.state, 'orphaned', JSON.stringify(orphan))
    const row = await admin.selectFrom('runs').select('orphan_action').where('id', '=', orphanId).executeTakeFirst()
    assert.equal(row?.orphan_action, 'killed')
    await until('the orphan tree to be gone', 30_000, async () => ((await fixtures()).length === 0 ? true : undefined))
    const restarted = await until('the restarted run', 30_000, async () => {
      const p = await runProcess()
      return p && p.ProcessId !== killed.ProcessId ? p : undefined
    })
    log(`orphan run orphaned, orphan_action killed, tree gone; run restarted as ${restarted.ProcessId}`)

    // re-pair: the home keeps its event history while the control plane makes a new machine at last_seq 0, so the
    // executor's next seq used to read as a gap and then as a duplicate forever, and the run stayed offered.
    log('re-pair: revoke the machine, pair the same home again, run synthetic')
    await cli('machine', 'revoke', machine)
    await until('run to exit after the revoke', 30_000, async () =>
      (await runProcess()) === undefined ? true : undefined,
    )
    // DR452 is final: the supervisor logs it and stops restarting run, which would only fail the same way.
    await until('the supervisor to give up on DR452', 15_000, async () =>
      /supervisor: run exited \(code 5\).*not restarting/.test(await supervisorLog()) ? true : undefined,
    )
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    assert.equal(await runProcess(), undefined, 'run restarted after DR452')
    // As `service uninstall` would: the supervisor goes before the home is paired again.
    await kill(supervisePid)
    const repaired = `${machine}-2`
    const repairing = await cli('machine', 'pair-code', '--name', repaired)
    const repairCode = /pairing code for machine \S+: (\S+)/.exec(repairing)?.[1] ?? assert.fail(repairing)
    await run(EXE, ['pair', '--url', BASE, '--code', repairCode], { env: executorEnv, windowsHide: true })
    supervise = spawn(EXE, ['supervise'], { env: executorEnv, stdio: 'ignore', windowsHide: true })
    const resupervisePid = supervise.pid ?? assert.fail('supervise has no pid')
    await until('the re-paired executor to connect', 30_000, async () =>
      (await api<MachineJson[]>('/machines')).some((m) => m.name === repaired && m.connected) ? true : undefined,
    )
    // Pinned, so the run proves the re-paired machine's new row takes work.
    const out = await cli('run', 'start', 'synthetic', '--machine', repaired, '--cwd', tmp)
    const repairedRun = await ended(/run ([0-9a-f-]{36})/.exec(out)?.[1] ?? assert.fail(out), 120_000)
    assert.equal(repairedRun.state, 'finished', JSON.stringify(repairedRun))
    await until('the swept tree to be gone', 10_000, async () => ((await fixtures()).length === 0 ? true : undefined))
    const rerun = (await runProcess()) ?? assert.fail('no run process after re-pairing')
    log(`re-paired as ${repaired}: synthetic finished; supervise ${resupervisePid}, run ${rerun.ProcessId}`)

    // footprint
    log(`footprint: waiting ${IDLE_MS / 1000} s idle`)
    const measured = await footprint({
      api: { url: BASE, token },
      pids: { controlPlane: [servePid], executor: [resupervisePid, rerun.ProcessId] },
    })
    for (const line of measured.lines) log(`footprint ${line}`)
    assert.ok(measured.ok, 'footprint over budget')

    // `run` follows its supervisor out.
    await kill(resupervisePid)
    await until('run to exit after its supervisor', 15_000, async () => {
      const left = await executors()
      if (left.length === 0) return true
      log(`still running: ${left.map((p) => `${p.ProcessId} ${p.CommandLine}`).join('; ')}`)
      return undefined
    })
    log('supervise killed: run exited on its own')
    const logged = await supervisorLog()
    assert.match(logged, /supervisor: run started \(pid \d+\)/)
    assert.match(logged, /supervisor: restarting run in 1 s/)
    log('supervisor start, run start, the 1 s restart and the DR452 stop logged')
    log('PASS')
  } catch (err) {
    console.error(`[e2e] FAIL: ${(err as Error).stack ?? err}`)
    console.error(`[e2e] control plane warnings and errors (last 100):\n${serveOutput.join('\n')}`)
    const logs = join(home, 'logs')
    for (const file of await readdir(logs).catch(() => [])) {
      console.error(`[e2e] ${file} (tail):\n${(await readFile(join(logs, file), 'utf8')).slice(-4000)}`)
    }
    process.exitCode = 1
  } finally {
    // Supervisor first, so nothing restarts; then what ran under it, still the same processes; then the rest of
    // this e2e's binaries.
    if (supervise?.pid) await kill(supervise.pid)
    for (const p of await snapshot().catch(() => [])) {
      if (tracked.get(p.ProcessId) === p.Started) await kill(p.ProcessId)
    }
    for (const p of [...(await executors().catch(() => [])), ...(await fixtures().catch(() => []))]) {
      await kill(p.ProcessId)
    }
    serve?.kill()
    await admin.destroy()
    // The executor's files may stay locked for a moment after it exits.
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch((err) =>
      console.error(`[e2e] ${tmp} not removed: ${(err as Error).message}`),
    )
  }
}

await main()
