#!/usr/bin/env node
// pnpm e2e: the executor end to end on this machine, self-contained. Builds the release binaries, starts its own
// control plane on the test database (port 4993; offers expire after 5 s, the scheduler polls every 2 s) and its own
// executor under `supervise` with a home in .superpowers/tmp and a tree-fixture copy of its own on PATH, pairs it
// into a fresh tenant, then runs, every run placed by the scheduler:
//   synthetic  tree-fixture with 3 lingering children: finished, stamped, swept, hidden, steps and 1000 log lines
//   lint       `pnpm lint` of this repo through pnpm.cmd: finished and hidden
//   lane       job type `lane` (environment devlanes, mode with) in roadmap/fixtures/environments: prints the
//              LANE_MARK of this worktree's devrounds-e2e lane, and the run shows that lane; the lane is cleaned after
//   schedule   `schedule set --every 60`, set first and checked after dag and retry: fires within 75 s, finishes
//   dag        roadmap/fixtures/batches/dag.yaml twice in one directory: red build → test skipped, never offered;
//              green build → test finished
//   retry      flaky, red once (check_red): attempt 2 is queued by the retry policy and finishes
//   expiry     `run` suspended, a run pinned to its machine is offered and not answered: after 5 s it is
//              stopped/infra with a requeue run; `run` resumed → the requeue finishes, the first never started
//   orphan     `run` killed under a live run, restarted by its supervisor: the run is orphaned, killed, tree gone
//   gate       roadmap/fixtures/gates/e2e.yaml three times in one directory: a second gate refused with DR308 while the
//              first runs; a waiting one (--wait-lock) created after the first ended; a third with the first's cache
//              keys passes at submit, every check cachedFrom the first's runs; the mark in a log; gate indicators
//   conventions roadmap/fixtures/conventions/e2e.yaml proposed and approved in this tenant, rendered into a directory
//              of its own, then gates of roadmap/fixtures/gates/conventions-e2e.yaml: red.diff fails check_red with
//              its convention_checks row; a hand edit of the block fails with docs_drift; green.diff passes, and
//              again from the cache; after version 2 is approved the green check runs again, against version 2
//   re-pair   the machine revoked, the same home paired again as a new machine: synthetic finishes on it
// then measures both sides with scripts/footprint.ts after 60 s idle, plus `serve` alone against an early warning,
// and checks that `run` exits once its supervisor is gone. Nothing is installed; everything it started, and nothing
// else, is stopped at the end, so it can run beside an installed executor service.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bootstrap } from '../../control-plane/src/admin.ts'
import { runCli } from '../../control-plane/src/cli/commands.ts'
import { createDb } from '../../control-plane/src/db/connection.ts'
import { migrateToLatest } from '../../control-plane/src/db/migrate.ts'
import { parseGateFile } from '../../control-plane/src/gates/file.ts'
import { parseJobTypeFile } from '../../control-plane/src/job-types/file.ts'
import { parseBatchFile } from '../../control-plane/src/jobs/batch-file.ts'
import {
  TEST_ADMIN_URL,
  TEST_APP_PASSWORD,
  TEST_APP_ROLE,
  TEST_AUTH_SECRET,
  TEST_DATABASE_URL,
} from '../../control-plane/src/test-support/test-db-urls.ts'
import { footprint, IDLE_MS, measure } from '../footprint.ts'

const run = promisify(execFile)

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const EXECUTOR_DIR = join(ROOT, 'executor')
const RELEASE = join(EXECUTOR_DIR, 'target', 'release')
const EXE = join(RELEASE, 'devrounds-executor.exe')
const FIXTURE = join(RELEASE, 'tree-fixture.exe')
const JOB_TYPES = join(ROOT, 'roadmap', 'fixtures', 'job-types')
const DAG_BATCH = join(ROOT, 'roadmap', 'fixtures', 'batches', 'dag.yaml')
const GATE_FILE = join(ROOT, 'roadmap', 'fixtures', 'gates', 'e2e.yaml')
const CONVENTIONS = join(ROOT, 'roadmap', 'fixtures', 'conventions')
const CONVENTIONS_GATE = join(ROOT, 'roadmap', 'fixtures', 'gates', 'conventions-e2e.yaml')
const LANE_DIR = join(ROOT, 'roadmap', 'fixtures', 'environments')
const PORT = 4993
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'devrounds'
const TERMINAL = ['finished', 'failed', 'stopped', 'orphaned', 'skipped']
// The shortest offer timeout serve accepts, so the expiry scenario waits seconds, not the default 2 minutes.
const OFFER_TIMEOUT_S = 5
// `serve` alone after the idle window: an early warning well under the control plane's 300 MB budget, which also
// counts the supervisor that only the live install has (pnpm footprint measures that one).
const SERVE_EARLY_WARNING = 230_000_000

type RunJson = {
  id: string
  state: string
  attempt: number
  cause: string
  timeline: Record<string, string | null>
  durations: Record<string, number | null>
  outcome: { exitCode: number | null; failureClass: string | null; failureSummary: string | null }
  resources: { peak: number | null; swept: number | null; visibleWindows: number | null }
  steps: { name: string; outcome: string | null }[]
  environment: { lane: { reference: string; path: string | null } | null; error: string | null } | null
}
type Proc = { ProcessId: number; CommandLine: string | null }
type GateJson = {
  id: string
  state: string
  createdAt: string
  finishedAt: string | null
  checks: { ref: string; runId: string; cachedFrom: string | null }[]
}

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

// Freezes or thaws every thread of `pid`, as a hung executor: its socket stays open, so the control plane keeps
// offering to it, and nothing answers. Windows has no command for it; ntdll's pair is what Process Explorer uses.
async function freeze(call: 'NtSuspendProcess' | 'NtResumeProcess', pid: number): Promise<void> {
  const [status] = await powershellJson<number>(
    `Add-Type -Namespace E2e -Name Nt -MemberDefinition '[DllImport("ntdll.dll")] public static extern int ${call}(IntPtr process);'; ` +
      `[E2e.Nt]::${call}((Get-Process -Id ${pid}).Handle)`,
  )
  assert.equal(status, 0, `${call}(${pid}) answered NTSTATUS ${status}`)
}

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
    await migrateToLatest(TEST_ADMIN_URL, {
      appRole: TEST_APP_ROLE,
      appPassword: TEST_APP_PASSWORD,
      authSecret: TEST_AUTH_SECRET,
    })
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
        DEVROUNDS_OFFER_TIMEOUT_S: String(OFFER_TIMEOUT_S),
        DEVROUNDS_SCHEDULER_POLL_S: '2',
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
    // The conventions job calls the CLI with these from the machine env: this tenant's, never the user variables of
    // a live control plane.
    const executorEnv = { ...pathEnv(bin), ...cliEnv, DEVROUNDS_EXECUTOR_HOME: home }
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

    for (const file of [
      'synthetic.yaml',
      'lint.yaml',
      'orphan.yaml',
      'dag-build.yaml',
      'dag-test.yaml',
      'flaky.yaml',
      'lane.yaml',
    ])
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

    // lane
    log('lane: node inside the devrounds-e2e lane of this worktree')
    let laneReference: string | undefined
    try {
      const lane = await ended(await start('lane', LANE_DIR), 120_000)
      assert.equal(lane.state, 'finished', JSON.stringify(lane))
      const seen = lane.environment?.lane ?? assert.fail(JSON.stringify(lane.environment))
      laneReference = seen.reference
      // devlanes names lane 0 `main` and lane N `laneN` (lane.name in the project file).
      const index = /^devrounds-e2e@(\d+)$/.exec(seen.reference)?.[1] ?? assert.fail(seen.reference)
      const mark = `mark lane-${index === '0' ? 'main' : `lane${index}`}`
      const out = await until('the lane mark in the log', 30_000, async () => {
        const text = await cli('run', 'logs', lane.id)
        return text.includes(mark) ? text : undefined
      })
      assert.ok(out.includes(mark), out)
      log(`lane finished in lane ${seen.reference} (${seen.path}): "${mark}"`)
    } finally {
      // Lanes are ephemeral: `devlanes with` stopped what it started; this drops the lane it registered.
      if (laneReference !== undefined) {
        await run('devlanes', ['lane', 'clean', '--yes', laneReference], { cwd: LANE_DIR, windowsHide: true }).catch(
          (err) => log(`lane clean failed: ${(err as Error).message}`),
        )
      }
    }

    // schedule: set now, checked after dag and retry, so its 60 s run in parallel with them.
    type ScheduleJson = { key: string; lastJob: { id: string; state: string } | null }
    type JobJson = { id: string; lastRun: { id: string } }
    log('schedule: synthetic every 60 s')
    const scheduledAt = Date.now()
    const scheduleArgs = ['e2e-every', '--job-type', 'synthetic', '--cwd', tmp, '--every', '60']
    await cli('schedule', 'set', ...scheduleArgs)
    const lastJob = async () => {
      const schedules = await api<ScheduleJson[]>(`/projects/${PROJECT}/schedules`)
      return schedules.find((s) => s.key === 'e2e-every')?.lastJob ?? undefined
    }

    // dag: the first build in a directory is red, the next one green (dag-build.yaml).
    const dagDir = join(tmp, 'dag')
    await mkdir(dagDir)
    const dagBatch = parseBatchFile(await readFile(DAG_BATCH, 'utf8'))
    for (const job of dagBatch.jobs) job.cwd = dagDir
    // JSON is YAML: the copy is the fixture with this e2e's directory in every cwd.
    const dagFile = join(tmp, 'dag.yaml')
    await writeFile(dagFile, JSON.stringify(dagBatch))
    type BatchJson = { jobs: { ref: string; runId: string; state: string }[] }
    const submitDag = async () => {
      const out = await cli('batch', 'submit', dagFile)
      const id = /devrounds batch show (\S+)/.exec(out)?.[1] ?? assert.fail(out)
      const { jobs } = await api<BatchJson>(`/projects/${PROJECT}/batches/${id}`)
      const runOf = (ref: string) => jobs.find((j) => j.ref === ref)?.runId ?? assert.fail(`${ref} not in ${out}`)
      return { build: runOf('build'), test: runOf('test') }
    }
    log('dag: red build, then green build, in one directory')
    const red = await submitDag()
    const redBuild = await ended(red.build, 120_000)
    assert.equal(redBuild.state, 'failed', JSON.stringify(redBuild))
    assert.equal(redBuild.outcome.failureClass, 'check_red', JSON.stringify(redBuild))
    const skipped = await ended(red.test, 30_000)
    assert.equal(skipped.state, 'skipped', JSON.stringify(skipped))
    assert.equal(skipped.timeline.offeredAt, null, `skipped test was offered: ${JSON.stringify(skipped)}`)
    const green = await submitDag()
    const greenBuild = await ended(green.build, 120_000)
    assert.equal(greenBuild.state, 'finished', JSON.stringify(greenBuild))
    const tested = await ended(green.test, 120_000)
    assert.equal(tested.state, 'finished', JSON.stringify(tested))
    // claim_run holds a dependent until its dependency finished.
    assert.ok(
      (tested.timeline.offeredAt ?? '') >= (greenBuild.timeline.finishedAt ?? '~'),
      `test offered before build finished: ${JSON.stringify([greenBuild.timeline, tested.timeline])}`,
    )
    log(`dag: red build → test skipped (${skipped.outcome.failureSummary}); green build → test finished`)

    // retry
    log('retry: flaky is red once (check_red), max_attempts 2')
    const flakyDir = join(tmp, 'flaky')
    await mkdir(flakyDir)
    const firstAttempt = await ended(await start('flaky', flakyDir), 120_000)
    assert.equal(firstAttempt.state, 'failed', JSON.stringify(firstAttempt))
    assert.equal(firstAttempt.outcome.failureClass, 'check_red', JSON.stringify(firstAttempt))
    type RunListJson = { runs: { id: string; attempt: number; cause: string }[] }
    const retryId = await until('the retry run', 10_000, async () => {
      const { runs } = await api<RunListJson>(`/projects/${PROJECT}/runs?jobType=flaky`)
      return runs.find((r) => r.attempt === 2 && r.cause === 'retry')?.id
    })
    // The default backoff is 30 s after the first attempt ended.
    const secondAttempt = await ended(retryId, 120_000)
    assert.equal(secondAttempt.state, 'finished', JSON.stringify(secondAttempt))
    log(`retry: attempt 1 check_red, attempt 2 finished after ${secondAttempt.durations.totalMs} ms queued → finished`)

    const fired = await until('the schedule to fire', Math.max(0, scheduledAt + 75_000 - Date.now()), lastJob)
    const { jobs } = await api<{ jobs: JobJson[] }>(`/projects/${PROJECT}/jobs`)
    const scheduledRunId = jobs.find((j) => j.id === fired.id)?.lastRun.id ?? assert.fail(`job ${fired.id} not listed`)
    const scheduled = await ended(scheduledRunId, 120_000)
    assert.equal(scheduled.state, 'finished', JSON.stringify(scheduled))
    const firedAfterMs = Date.parse(scheduled.timeline.queuedAt ?? '') - scheduledAt
    assert.ok(firedAfterMs <= 75_000, `the schedule fired ${firedAfterMs} ms after it was set`)
    // Off before the expiry and the idle window, which another fire would disturb.
    await cli('schedule', 'set', ...scheduleArgs, '--disable')
    await until('the swept tree to be gone', 10_000, async () => ((await fixtures()).length === 0 ? true : undefined))
    log(`schedule: fired ${(firedAfterMs / 1000).toFixed(1)} s after it was set, finished; disabled`)

    // expiry: a suspended `run` keeps its session open and answers nothing.
    log(`expiry: run suspended, a pinned synthetic offered to it expires after ${OFFER_TIMEOUT_S} s`)
    const frozen = (await runProcess()) ?? assert.fail('no run process')
    await freeze('NtSuspendProcess', frozen.ProcessId)
    let withdrawn: RunJson
    let requeueId: string
    try {
      // Pinned: the requeue run of the job keeps the pin, so it waits for this machine to come back.
      const out = await cli('run', 'start', 'synthetic', '--machine', machine, '--cwd', tmp)
      const offeredId = /run ([0-9a-f-]{36})/.exec(out)?.[1] ?? assert.fail(out)
      withdrawn = await ended(offeredId, 30_000)
      assert.equal(withdrawn.state, 'stopped', JSON.stringify(withdrawn))
      assert.equal(withdrawn.outcome.failureClass, 'infra', JSON.stringify(withdrawn))
      const offeredFor =
        Date.parse(withdrawn.timeline.finishedAt ?? '') - Date.parse(withdrawn.timeline.offeredAt ?? '')
      assert.ok(offeredFor >= OFFER_TIMEOUT_S * 1000, `withdrawn ${offeredFor} ms after the offer`)
      requeueId =
        /requeued as run ([0-9a-f-]{36})/.exec(withdrawn.outcome.failureSummary ?? '')?.[1] ??
        assert.fail(JSON.stringify(withdrawn))
      const requeue = await view(requeueId)
      assert.deepEqual([requeue.cause, requeue.state], ['requeue', 'queued'], JSON.stringify(requeue))
    } finally {
      await freeze('NtResumeProcess', frozen.ProcessId)
    }
    const requeued = await ended(requeueId, 120_000)
    assert.equal(requeued.state, 'finished', JSON.stringify(requeued))
    const never = await view(withdrawn.id)
    assert.equal(never.timeline.startedAt, null, `the withdrawn run started: ${JSON.stringify(never)}`)
    await until('the swept tree to be gone', 30_000, async () => ((await fixtures()).length === 0 ? true : undefined))
    log(`expiry: offer withdrawn after ${OFFER_TIMEOUT_S} s (${withdrawn.outcome.failureSummary}); requeue finished`)

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

    // gate: one worktree, one running gate; the lock waits, the result cache answers.
    log('gate: lock DR308, --wait-lock, and a full cache hit')
    await cli('queue', 'set', 'gates', '--machine-concurrency', '2')
    const gateDir = join(tmp, 'gate')
    await mkdir(gateDir)
    const mark = `mark-${randomBytes(4).toString('hex')}`
    // JSON is YAML: copies of the fixture with this e2e's cache keys and mark.
    const gateFile = async (name: string, keys: string): Promise<string> => {
      const file = parseGateFile(await readFile(GATE_FILE, 'utf8'))
      for (const check of file.checks) {
        check.cache_key = `${keys}-${check.ref}`
        if (check.env) check.env = { DR_E2E_MARK: mark }
      }
      const path = join(tmp, `gate-${name}.yaml`)
      await writeFile(path, JSON.stringify(file))
      return path
    }
    const firstKeys = `e2e-${randomUUID()}`
    const firstFile = await gateFile('first', firstKeys)
    const secondFile = await gateFile('second', `e2e-${randomUUID()}`)
    const thirdFile = await gateFile('third', firstKeys)
    await cli('jobtype', 'set', join(JOB_TYPES, 'gate-check.yaml'))
    const gateJson = async (id: string) => api<GateJson>(`/projects/${PROJECT}/gates/${id}`)
    const first = JSON.parse(await cli('gate', 'run', firstFile, '--cwd', gateDir, '--json')) as GateJson
    assert.equal(first.state, 'running', JSON.stringify(first))
    const refused = await runCli(['gate', 'run', secondFile, '--cwd', gateDir, '--no-wait-lock'], {
      env: cliEnv,
      configPath: join(tmp, 'cli.json'),
    })
    assert.equal(refused.exitCode, 1, `${refused.stdout}${refused.stderr}`)
    assert.match(`${refused.stdout}${refused.stderr}`, /DR308/)
    assert.ok(`${refused.stdout}${refused.stderr}`.includes(first.id), `DR308 does not name ${first.id}`)
    const second = JSON.parse(
      await cli('gate', 'run', secondFile, '--cwd', gateDir, '--wait-lock', '60', '--wait', '--json'),
    ) as GateJson
    assert.equal(second.state, 'passed', JSON.stringify(second))
    const firstEnded = await gateJson(first.id)
    assert.equal(firstEnded.state, 'passed', JSON.stringify(firstEnded))
    assert.ok(
      (firstEnded.finishedAt ?? '~') <= second.createdAt,
      `gate 2 was created at ${second.createdAt}, before gate 1 ended at ${firstEnded.finishedAt}`,
    )
    // Every check a hit of gate 1's run: the gate passes at submit.
    const third = JSON.parse(await cli('gate', 'run', thirdFile, '--cwd', gateDir, '--json')) as GateJson
    assert.equal(third.state, 'passed', JSON.stringify(third))
    for (const check of third.checks) {
      const source = firstEnded.checks.find((c) => c.ref === check.ref)
      assert.equal(check.cachedFrom, source?.runId, `check ${check.ref} is not a hit: ${JSON.stringify(third)}`)
    }
    const checkA = firstEnded.checks.find((c) => c.ref === 'a') ?? assert.fail(JSON.stringify(firstEnded))
    await until('the mark in the log of check a', 30_000, async () => {
      const out = await cli('run', 'logs', checkA.runId)
      return out.includes(`DR_E2E_MARK=${mark}`) ? out : undefined
    })
    const indicators = await api<{ gates: { passed: number; cacheHitShare: number | null }[] }>(
      `/projects/${PROJECT}/indicators/gates`,
    )
    assert.equal(
      indicators.gates.reduce((sum, row) => sum + row.passed, 0),
      3,
      JSON.stringify(indicators),
    )
    assert.ok(
      indicators.gates.some((row) => (row.cacheHitShare ?? 0) > 0),
      JSON.stringify(indicators),
    )
    // Gates 1 and 2 ran a and b each; gate 3's hits are not runs of the machine.
    const runRows = await api<{ jobType: string; runs: number }[]>(`/projects/${PROJECT}/indicators`)
    const gateCheckRuns = runRows.filter((r) => r.jobType === 'gate-check').reduce((sum, r) => sum + r.runs, 0)
    assert.equal(gateCheckRuns, 4, `cached runs are counted: ${JSON.stringify(runRows)}`)
    log(`gate: DR308 named ${first.id}; gate 2 waited and passed; gate 3 hit gate 1's runs; indicators 3 passed`)

    // conventions: everything through this tenant's CLI and executor env (cliEnv), so a live tenant is never touched.
    log('conventions: version 1 approved and rendered; red, drift and green gates; version 2 reruns the cached green')
    const convDir = join(tmp, 'conventions')
    await mkdir(convDir)
    const agentsMd = join(convDir, 'AGENTS.md')
    // The hand-written part, which the e2e.yaml rule cites as its evidence.
    await writeFile(agentsMd, '# E2E\n\nCode under `src/` never calls eval.\n')
    const convJobType = parseJobTypeFile(await readFile(join(JOB_TYPES, 'conventions-e2e.yaml'), 'utf8'))
    convJobType.command.args[0] = join(ROOT, 'control-plane', 'src', 'cli', 'main.ts')
    const convJobTypeFile = join(tmp, 'conventions-e2e-job-type.yaml')
    await writeFile(convJobTypeFile, JSON.stringify(convJobType))
    await cli('jobtype', 'set', convJobTypeFile)
    const finding = await cli('task', 'open-finding', '--source-key', 'e2e:conventions', '--title', 'E2E conventions')
    const taskKey = /opened (F-\d{4})/.exec(finding)?.[1] ?? assert.fail(finding)
    const approve = async (file: string, version: number) => {
      const proposed = await cli('conventions', 'propose', file, '--cwd', convDir, '--task', taskKey)
      assert.match(proposed, new RegExp(`proposed conventions version ${version} `), proposed)
      await cli('conventions', 'approve', String(version), '--reason', 'e2e')
      await cli('conventions', 'render', '--cwd', convDir)
      const shown = JSON.parse(await cli('conventions', 'show', '--json')) as { version: number; documentSha: string }
      assert.equal(shown.version, version, JSON.stringify(shown))
      return shown.documentSha
    }
    const v1Sha = await approve(join(CONVENTIONS, 'e2e.yaml'), 1)
    // A copy of the fixture gate per diff; the green ones carry the cache key README asks for: the change (here the diff
    // file's content, in a repo its head and base commits) plus the active documentSha.
    const convGate = async (name: string, diff: string, documentSha?: string): Promise<GateJson> => {
      const file = parseGateFile(await readFile(CONVENTIONS_GATE, 'utf8'))
      const changeSha = createHash('sha256')
        .update(await readFile(join(CONVENTIONS, diff)))
        .digest('hex')
        .slice(0, 16)
      for (const check of file.checks) {
        check.args = [join(CONVENTIONS, diff)]
        if (documentSha) check.cache_key = `conventions-${changeSha}-${documentSha}`
      }
      const path = join(tmp, `conventions-gate-${name}.yaml`)
      await writeFile(path, JSON.stringify(file))
      const r = await runCli(['gate', 'run', path, '--cwd', convDir, '--wait', '--json'], {
        env: cliEnv,
        configPath: join(tmp, 'cli.json'),
      })
      try {
        return JSON.parse(r.stdout) as GateJson
      } catch {
        return assert.fail(`gate run ${name} exited ${r.exitCode}\n${r.stdout}${r.stderr}`)
      }
    }
    type CheckRow = { version: number; blocking: number; violations: unknown }
    const checkRow = (runId: string): Promise<CheckRow | undefined> =>
      admin
        .selectFrom('convention_checks as c')
        .innerJoin('convention_sets as s', 's.id', 'c.set_id')
        .select(['s.version', 'c.blocking', 'c.violations'])
        .where('c.run_id', '=', runId)
        .executeTakeFirst()
    const onlyCheck = (gate: GateJson) => gate.checks[0] ?? assert.fail(JSON.stringify(gate))
    const redCheck = async (gate: GateJson, rule: string) => {
      assert.equal(gate.state, 'failed', JSON.stringify(gate))
      const ran = await view(onlyCheck(gate).runId)
      assert.equal(ran.outcome.failureClass, 'check_red', JSON.stringify(ran))
      const row =
        (await checkRow(ran.id)) ??
        assert.fail(`no convention_checks row for run ${ran.id}:\n${await cli('run', 'logs', ran.id)}`)
      assert.equal(row.blocking, 1, JSON.stringify(row))
      assert.deepEqual(
        (row.violations as { rule: string }[]).map((v) => v.rule),
        [rule],
        JSON.stringify(row),
      )
    }

    await redCheck(await convGate('red', 'red.diff'), 'e2e.no-eval')
    const rendered = await readFile(agentsMd, 'utf8')
    const edited = rendered.replace("The e2e's one blocking rule.", 'Edited by hand.')
    assert.notEqual(edited, rendered, `the rule's line is not in the block:\n${rendered}`)
    await writeFile(agentsMd, edited)
    await redCheck(await convGate('drift', 'drift.diff'), 'docs_drift')
    await cli('conventions', 'render', '--cwd', convDir)
    assert.equal(await readFile(agentsMd, 'utf8'), rendered, 'render did not restore the block')

    const greenRan = await convGate('green-1', 'green.diff', v1Sha)
    assert.equal(greenRan.state, 'passed', JSON.stringify(greenRan))
    assert.equal(onlyCheck(greenRan).cachedFrom, null, JSON.stringify(greenRan))
    assert.equal((await checkRow(onlyCheck(greenRan).runId))?.version, 1)
    const greenCached = await convGate('green-2', 'green.diff', v1Sha)
    assert.equal(greenCached.state, 'passed', JSON.stringify(greenCached))
    assert.equal(onlyCheck(greenCached).cachedFrom, onlyCheck(greenRan).runId, JSON.stringify(greenCached))

    const v2File = join(tmp, 'conventions-v2.yaml')
    const v1Text = await readFile(join(CONVENTIONS, 'e2e.yaml'), 'utf8')
    await writeFile(v2File, v1Text.replace("The e2e's one blocking rule.", "The e2e's one blocking rule, version 2."))
    const v2Sha = await approve(v2File, 2)
    assert.notEqual(v2Sha, v1Sha)
    const greenAgain = await convGate('green-3', 'green.diff', v2Sha)
    assert.equal(greenAgain.state, 'passed', JSON.stringify(greenAgain))
    assert.equal(onlyCheck(greenAgain).cachedFrom, null, `version 2 read a cached green: ${JSON.stringify(greenAgain)}`)
    assert.equal((await checkRow(onlyCheck(greenAgain).runId))?.version, 2)
    log('conventions: red check_red and docs_drift recorded; green ran, then cached; version 2 ran it again')

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
    const [served] = await measure([servePid])
    assert.ok(served, 'serve is gone')
    log(`footprint serve alone: ${served.privateBytes} private bytes (early warning ${SERVE_EARLY_WARNING})`)
    assert.ok(served.privateBytes <= SERVE_EARLY_WARNING, 'serve over its early warning')

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
