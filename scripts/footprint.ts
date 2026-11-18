#!/usr/bin/env node
// pnpm footprint: the idle private bytes (commit, never working set; spec §16.5) of the control plane and the
// executor against their budgets. Exits 1 when a side is over budget, misses a process, or the machines never go idle.
//
//   pnpm footprint                                     the installed services: both roles of each scheduled task
//   pnpm footprint --control-plane-pids 1,2 --executor-pids 3,4   given processes (scripts/e2e uses this)
//   --idle-ms <n>                                      idle window before measuring (default 60000)
//
// Idle means every connected machine of the tenant reports `running: 0` through GET /api/machines for the whole
// window. The API is reached with DEVROUNDS_URL and DEVROUNDS_TOKEN, else ~/.devrounds/config.json (devrounds login).
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, promisify } from 'node:util'
import { isMain } from '../control-plane/src/is-main.ts'

const run = promisify(execFile)

// Budgets of the P1 exit criteria, with 1 MB = 1 000 000 bytes.
export const EXECUTOR_BUDGET = 50_000_000
export const CONTROL_PLANE_BUDGET = 300_000_000
export const IDLE_MS = 60_000
const POLL_MS = 5_000
// A machine that never goes idle fails the check instead of hanging it.
const IDLE_TIMEOUT_MS = 10 * 60_000

export type Measured = { pid: number; name: string; privateBytes: number }
export type Side = { name: string; budget: number; processes: Measured[]; missing?: string[] }
export type Api = { url: string; token: string }

async function powershellJson<T>(script: string): Promise<T[]> {
  // `@()` and -InputObject keep a single result a JSON list.
  const command = `$ProgressPreference = 'SilentlyContinue'\nConvertTo-Json -Compress -Depth 3 -InputObject @(${script})`
  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
  })
  return stdout.trim() === '' ? [] : (JSON.parse(stdout) as T[])
}

type CimProcess = {
  ProcessId: number
  ParentProcessId: number
  Name: string
  ExecutablePath: string | null
  CommandLine: string | null
}

// What the two scheduled tasks run: the control plane's supervise.ts and the executor's installed copy. A lane, a
// worktree or the e2e runs the same programs from elsewhere, and none of those count.
export type Installed = { supervisor: string | null; executor: string | null }

// From the tasks' action arguments, as written by control-plane/src/service/install.ts and the executor's
// service.rs: `--headless "<node>" "<supervise.ts>"` and `--headless "<exe>" supervise`.
export function installedPaths(args: { controlPlane: string | null; executor: string | null }): Installed {
  return {
    supervisor: args.controlPlane?.match(/"([^"]+supervise\.ts)"/i)?.[1] ?? null,
    executor: args.executor?.match(/"([^"]+\.exe)"\s+supervise/i)?.[1] ?? null,
  }
}

export type Roles = {
  controlPlane: { supervise: number[]; serve: number[] }
  executor: { supervise: number[]; run: number[] }
}

const same = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase()

// The control plane is the installed supervisor and the `main.ts serve` it started; the executor is `supervise` and
// `run` of the installed copy. Their console hosts and helpers are outside the budgets.
export function classify(processes: CimProcess[], installed: Installed): Roles {
  const roles: Roles = { controlPlane: { supervise: [], serve: [] }, executor: { supervise: [], run: [] } }
  const supervisor = installed.supervisor?.toLowerCase() ?? null
  // conhost passes the task's arguments on unquoted, so the path is matched as the line's last argument.
  const runsSupervisor = (line: string) =>
    supervisor !== null &&
    [supervisor, `"${supervisor}"`].some((arg) => line.toLowerCase().trimEnd().endsWith(` ${arg}`))
  for (const p of processes) {
    const line = p.CommandLine ?? ''
    if (p.Name.toLowerCase() === 'node.exe' && runsSupervisor(line)) {
      roles.controlPlane.supervise.push(p.ProcessId)
    } else if (same(p.ExecutablePath, installed.executor)) {
      if (/\ssupervise\s*$/.test(line)) roles.executor.supervise.push(p.ProcessId)
      else if (/\srun(\s+--supervised)?\s*$/.test(line)) roles.executor.run.push(p.ProcessId)
    }
  }
  // serve by parent: the supervisor spawns it directly, so a serve of a lane or of the e2e is never picked.
  for (const p of processes) {
    if (
      p.Name.toLowerCase() === 'node.exe' &&
      /main\.ts"?\s+serve\s*$/.test(p.CommandLine ?? '') &&
      roles.controlPlane.supervise.includes(p.ParentProcessId)
    ) {
      roles.controlPlane.serve.push(p.ProcessId)
    }
  }
  return roles
}

export function missingRoles(roles: Roles): { controlPlane: string[]; executor: string[] } {
  const empty = (side: Record<string, number[]>) => Object.keys(side).filter((role) => side[role].length === 0)
  return { controlPlane: empty(roles.controlPlane), executor: empty(roles.executor) }
}

export async function findServiceProcesses(): Promise<Roles> {
  const actions = await powershellJson<{ TaskName: string; Arguments: string | null }>(
    "Get-ScheduledTask | Where-Object { $_.TaskName -in 'DevRounds', 'DevRoundsExecutor' } | " +
      'ForEach-Object { $name = $_.TaskName; $_.Actions | ForEach-Object { [pscustomobject]@{ TaskName = $name; Arguments = $_.Arguments } } }',
  )
  const args = (task: string) => actions.find((a) => a.TaskName === task)?.Arguments ?? null
  const processes = await powershellJson<CimProcess>(
    `Get-CimInstance Win32_Process -Filter "name='node.exe' or name='devrounds-executor.exe'" | ` +
      'Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine',
  )
  return classify(processes, installedPaths({ controlPlane: args('DevRounds'), executor: args('DevRoundsExecutor') }))
}

// PrivateMemorySize64 is the process's commit (private bytes). A PID that is gone is left out, which shows up as a
// missing process in the report.
export async function measure(pids: number[]): Promise<Measured[]> {
  if (pids.length === 0) return []
  const rows = await powershellJson<{ Id: number; ProcessName: string; PrivateMemorySize64: number }>(
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, PrivateMemorySize64`,
  )
  return rows.map((r) => ({ pid: r.Id, name: r.ProcessName, privateBytes: r.PrivateMemorySize64 }))
}

type MachineJson = { name: string; connected: boolean; lastReport: { running?: number } | null }

// Resolves once every connected machine has reported `running: 0` for `idleMs` without a break.
export async function waitIdle(api: Api, idleMs: number, timeoutMs = IDLE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let idleSince: number | null = null
  for (;;) {
    const res = await fetch(`${api.url}/api/machines`, { headers: { authorization: `Bearer ${api.token}` } })
    if (!res.ok) throw new Error(`GET /api/machines answered ${res.status}: ${await res.text()}`)
    const machines = (await res.json()) as MachineJson[]
    const busy = machines.filter((m) => m.connected && (m.lastReport?.running ?? 0) > 0)
    const now = Date.now()
    idleSince = busy.length === 0 ? (idleSince ?? now) : null
    if (idleSince !== null && now - idleSince >= idleMs) return
    if (now > deadline) {
      throw new Error(`machines still running jobs after ${timeoutMs / 1000} s: ${busy.map((m) => m.name).join(', ')}`)
    }
    await sleep(Math.min(POLL_MS, idleMs))
  }
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

// `missing` names the roles found without a process (discovery only): half a service is not an idle service.
export function verdict(sides: Side[]): { ok: boolean; lines: string[] } {
  let ok = true
  const lines: string[] = []
  for (const side of sides) {
    const missing = side.missing ?? []
    const total = side.processes.reduce((sum, p) => sum + p.privateBytes, 0)
    const pass = side.processes.length > 0 && missing.length === 0 && total <= side.budget
    ok &&= pass
    const each = side.processes.map((p) => `${p.name} ${p.pid} ${mb(p.privateBytes)}`).join(', ')
    const found = side.processes.length === 0 && missing.length === 0 ? 'no process found' : each
    lines.push(
      `${side.name}: ${mb(total)} private bytes (budget ${mb(side.budget)}) ${pass ? 'PASS' : 'FAIL'}` +
        ` · ${[found, missing.length > 0 ? `missing ${missing.join(', ')}` : ''].filter((s) => s !== '').join(' · ')}`,
    )
  }
  return { ok, lines }
}

export async function footprint(opts: {
  api: Api
  idleMs?: number
  pids?: { controlPlane: number[]; executor: number[] }
}): Promise<{ ok: boolean; lines: string[] }> {
  await waitIdle(opts.api, opts.idleMs ?? IDLE_MS)
  // Looked up after the idle window: a supervisor may have restarted a process meanwhile.
  const roles = opts.pids ? null : await findServiceProcesses()
  const pids = opts.pids ?? {
    controlPlane: Object.values(roles?.controlPlane ?? {}).flat(),
    executor: Object.values(roles?.executor ?? {}).flat(),
  }
  const missing = roles === null ? { controlPlane: [], executor: [] } : missingRoles(roles)
  const [controlPlane, executor] = await Promise.all([measure(pids.controlPlane), measure(pids.executor)])
  return verdict([
    { name: 'executor', budget: EXECUTOR_BUDGET, processes: executor, missing: missing.executor },
    { name: 'control plane', budget: CONTROL_PLANE_BUDGET, processes: controlPlane, missing: missing.controlPlane },
  ])
}

export async function apiFromEnv(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<Api> {
  let url = env.DEVROUNDS_URL
  let token = env.DEVROUNDS_TOKEN
  const hint = 'set DEVROUNDS_URL and DEVROUNDS_TOKEN or run devrounds login'
  if (!url || !token) {
    const path = join(home, '.devrounds', 'config.json')
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      throw new Error(`no ${path}: ${hint}`)
    }
    const file = JSON.parse(text) as Partial<Api>
    url ||= file.url
    token ||= file.token
  }
  if (!url || !token) throw new Error(hint)
  return { url, token }
}

const pidList = (text: string | undefined): number[] =>
  (text ?? '')
    .split(',')
    .filter((s) => s !== '')
    .map((s) => {
      const pid = Number(s)
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${s}`)
      return pid
    })

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'control-plane-pids': { type: 'string' },
      'executor-pids': { type: 'string' },
      'idle-ms': { type: 'string' },
    },
  })
  const given = values['control-plane-pids'] !== undefined || values['executor-pids'] !== undefined
  const pids = given
    ? { controlPlane: pidList(values['control-plane-pids']), executor: pidList(values['executor-pids']) }
    : undefined
  const idleMs = values['idle-ms'] === undefined ? IDLE_MS : Number(values['idle-ms'])
  if (!Number.isInteger(idleMs) || idleMs < 0) throw new Error('--idle-ms must be a whole number of ms')
  console.log(`waiting for ${idleMs / 1000} s with no job running`)
  const { ok, lines } = await footprint({ api: await apiFromEnv(), idleMs, pids })
  for (const line of lines) console.log(line)
  return ok ? 0 : 1
}

if (await isMain(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (err) {
    console.error(`footprint: ${(err as Error).message}`)
    process.exitCode = 1
  }
}
