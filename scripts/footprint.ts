#!/usr/bin/env node
// pnpm footprint: the idle private bytes (commit, never working set; spec §16.5) of the control plane and the
// executor against their budgets. Exits 1 when a side is over budget, has no process, or the machines never go idle.
//
//   pnpm footprint                                     the installed services, found by command line
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
export type Side = { name: string; budget: number; processes: Measured[] }
export type Api = { url: string; token: string }

async function powershellJson<T>(script: string): Promise<T[]> {
  // `@()` and -InputObject keep a single result a JSON list.
  const command = `$ProgressPreference = 'SilentlyContinue'\nConvertTo-Json -Compress -Depth 3 -InputObject @(${script})`
  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
  })
  return stdout.trim() === '' ? [] : (JSON.parse(stdout) as T[])
}

type CimProcess = { ProcessId: number; Name: string; CommandLine: string | null }

// The control plane is its supervisor (service/supervise.ts) and `main.ts serve`; the executor is `supervise` and
// `run` of devrounds-executor.exe. Their console hosts and helpers are outside the budgets.
export function classify(processes: CimProcess[]): { controlPlane: number[]; executor: number[] } {
  const controlPlane: number[] = []
  const executor: number[] = []
  for (const p of processes) {
    const line = p.CommandLine ?? ''
    const name = p.Name.toLowerCase()
    if (
      name === 'node.exe' &&
      (/[\\/]service[\\/]supervise\.ts"?(\s|$)/.test(line) || /main\.ts"?\s+serve\s*$/.test(line))
    ) {
      controlPlane.push(p.ProcessId)
    } else if (name === 'devrounds-executor.exe' && /\s(supervise|run(\s+--supervised)?)\s*$/.test(line)) {
      executor.push(p.ProcessId)
    }
  }
  return { controlPlane, executor }
}

export async function findServiceProcesses(): Promise<{ controlPlane: number[]; executor: number[] }> {
  const processes = await powershellJson<CimProcess>(
    `Get-CimInstance Win32_Process -Filter "name='node.exe' or name='devrounds-executor.exe'" | ` +
      'Select-Object ProcessId, Name, CommandLine',
  )
  return classify(processes)
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

export function verdict(sides: Side[]): { ok: boolean; lines: string[] } {
  let ok = true
  const lines: string[] = []
  for (const side of sides) {
    const total = side.processes.reduce((sum, p) => sum + p.privateBytes, 0)
    const pass = side.processes.length > 0 && total <= side.budget
    ok &&= pass
    const each = side.processes.map((p) => `${p.name} ${p.pid} ${mb(p.privateBytes)}`).join(', ')
    lines.push(
      `${side.name}: ${mb(total)} private bytes (budget ${mb(side.budget)}) ${pass ? 'PASS' : 'FAIL'}` +
        ` · ${side.processes.length === 0 ? 'no process found' : each}`,
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
  const pids = opts.pids ?? (await findServiceProcesses())
  const [controlPlane, executor] = await Promise.all([measure(pids.controlPlane), measure(pids.executor)])
  return verdict([
    { name: 'executor', budget: EXECUTOR_BUDGET, processes: executor },
    { name: 'control plane', budget: CONTROL_PLANE_BUDGET, processes: controlPlane },
  ])
}

async function apiFromEnv(): Promise<Api> {
  let url = process.env.DEVROUNDS_URL
  let token = process.env.DEVROUNDS_TOKEN
  if (!url || !token) {
    const path = join(homedir(), '.devrounds', 'config.json')
    const file = JSON.parse(await readFile(path, 'utf8')) as Partial<Api>
    url ||= file.url
    token ||= file.token
  }
  if (!url || !token) throw new Error('set DEVROUNDS_URL and DEVROUNDS_TOKEN or run devrounds login')
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
