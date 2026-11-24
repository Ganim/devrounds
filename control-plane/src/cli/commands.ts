import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import { exitCodeFor } from '../errors/codes.ts'
import { DevRoundsError, explain, fail } from '../errors/error.ts'
import { parseGateFile } from '../gates/file.ts'
import type { CheckIndicatorRow, GateIndicatorRow } from '../gates/indicators.ts'
import { parseJobTypeFile } from '../job-types/file.ts'
import { parseBatchFile } from '../jobs/batch-file.ts'
import { restrictToOwner } from '../owner-only.ts'
import type { ImportResult } from '../planning/import.ts'
import type { EventView, PlanView } from '../planning/view.ts'
import type { ImprovementReport } from '../runs/improvement.ts'
import type { IndicatorRow } from '../runs/indicators.ts'
import type { RunView } from '../runs/view.ts'
import {
  type AgentOutput,
  BODY_BUDGET,
  fitBody,
  fmt,
  type GateJson,
  gateShow,
  improvementShow,
  planShow,
  renderAgent,
  shellArg,
} from './output.ts'

// `devrounds`: the agent CLI. It talks only to the control plane's HTTP API (imports here are types and pure
// modules, never the DB layer), and prints every result in agent output mode (see output.ts).

export type CliConfig = { url: string; token: string; project: string }

export function defaultConfigPath(): string {
  return join(homedir(), '.devrounds', 'config.json')
}

// Config problems send the agent to login, never print a token: the placeholders are filled by a human.
const LOGIN_NEXT = 'devrounds login --url <url> --token <token> --project <key>'

// A DevRoundsError whose fix is `devrounds login` (missing or broken config).
class LoginNeeded extends DevRoundsError {}

const ENV = { url: 'DEVROUNDS_URL', token: 'DEVROUNDS_TOKEN', project: 'DEVROUNDS_PROJECT' } as const

// Env vars override the file field by field; the file is read only when the env leaves a field unset, so agents
// running with all three variables never depend on it.
async function loadCliConfig(env: NodeJS.ProcessEnv, path: string, project?: string): Promise<CliConfig> {
  // --project wins over the env and the file for this invocation only.
  const fromEnv = { url: env[ENV.url], token: env[ENV.token], project: project ?? env[ENV.project] }
  let file: Partial<CliConfig> = {}
  if (!fromEnv.url || !fromEnv.token || !fromEnv.project) {
    const text = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '{}'
      throw err
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new LoginNeeded('DR101', { path, reason: 'is not valid JSON; run devrounds login again' })
    }
    // `null`, a list or a bare value parse fine but hold no fields to read.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new LoginNeeded('DR502', { reason: `${path} must hold a JSON object` })
    }
    file = parsed as Partial<CliConfig>
  }
  const pick = (field: keyof CliConfig): string => {
    const value = fromEnv[field] || file[field]
    if (typeof value !== 'string' || value === '') {
      throw new LoginNeeded('DR101', { path: field, reason: `is not set; run devrounds login or set ${ENV[field]}` })
    }
    return value
  }
  return { url: pick('url').replace(/\/+$/, ''), token: pick('token'), project: pick('project') }
}

// What the server answered with an error body, or no usable answer at all.
class ApiError extends Error {
  code: string
  text: string
  hint: string
  data: Record<string, unknown>

  constructor(code: string, text: string, hint: string, data: Record<string, unknown> = {}) {
    super(`${code} ${text}`)
    this.code = code
    this.text = text
    this.hint = hint
    this.data = data
  }
}

// No answer from the control plane: exit 4, with the next step depending on whether a mutation may have landed.
class Unreachable extends Error {
  next: string
  // A mutation may have committed before the answer was lost (timeout, dropped connection); only then is a retry safe.
  maybeLanded: boolean

  constructor(message: string, next: string, maybeLanded = false) {
    super(message)
    this.next = next
    this.maybeLanded = maybeLanded
  }
}

const START_SERVER_NEXT = 'start the control plane (node control-plane/src/main.ts serve)'
export const DEFAULT_TIMEOUT_MS = 30_000

type Api = {
  get<T>(path: string, query?: Record<string, string | undefined>): Promise<T>
  getText(path: string): Promise<string>
  // Every mutation sends a random Idempotency-Key, one per invocation: running the command again is a new request.
  // A timeout or dropped connection is retried once with the same key, so the server replays instead of applying twice;
  // `retry: false` is for routes exempt from Idempotency-Key, where a second send could apply twice.
  send<T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    contentType?: string,
    options?: { retry?: boolean },
  ): Promise<T>
  // The control plane URL, for next steps run elsewhere (the executor's pair command).
  url: string
  // The same client on paths under `/api/machines` instead of the configured project.
  machines(): Api
}

function apiFor(config: CliConfig, timeoutMs: number, scope?: string): Api {
  const base = `${config.url}/api${scope ?? `/projects/${encodeURIComponent(config.project)}`}`
  const call = async (path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> => {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${config.token}`, ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } }
      const reason =
        e.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : (e.cause?.code ?? e.cause?.message ?? e.message)
      // Only a refused connection proves the request never arrived. After a timeout or a dropped connection a
      // mutation may have committed, and running it again would apply it twice: check the events first.
      if (init.method !== 'GET' && e.cause?.code !== 'ECONNREFUSED') {
        throw new Unreachable(
          `control plane at ${config.url} did not answer (${reason}); outcome unknown`,
          'devrounds events',
          true,
        )
      }
      throw new Unreachable(`control plane unreachable at ${config.url}: ${reason}`, START_SERVER_NEXT)
    }
    if (res.ok) return res
    const text = await res.text()
    let body: { code?: unknown; text?: unknown; hint?: unknown; data?: Record<string, unknown> } = {}
    try {
      body = JSON.parse(text)
    } catch {
      // Not the control plane answering (a proxy, another service on the port): handled below.
    }
    // A body with a code but no words (an older or foreign server) must not print "undefined".
    if (typeof body.code === 'string') {
      throw new ApiError(
        body.code,
        typeof body.text === 'string' ? body.text : 'The control plane answered with an error and no text.',
        typeof body.hint === 'string' ? body.hint : `Check that ${config.url} is the DevRounds control plane.`,
        body.data ?? {},
      )
    }
    throw new ApiError(
      'DR501',
      `HTTP ${res.status} from ${config.url} without an error code.`,
      `Check that ${config.url} is the DevRounds control plane.`,
    )
  }
  return {
    async get(path, query = {}) {
      const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined))
      const qs = params.size > 0 ? `?${params}` : ''
      return (await call(`${path}${qs}`, { method: 'GET' })).json()
    },
    async getText(path) {
      return (await call(path, { method: 'GET' })).text()
    },
    async send(method, path, body, contentType = 'application/json', options = {}) {
      const headers: Record<string, string> = { 'idempotency-key': randomUUID() }
      if (body !== undefined) headers['content-type'] = contentType
      const payload = body === undefined || typeof body === 'string' ? body : JSON.stringify(body)
      const init = { method, headers, body: payload }
      try {
        return (await call(path, init)).json()
      } catch (err) {
        if (!(err instanceof Unreachable) || !err.maybeLanded || options.retry === false) throw err
        // Same method, path, body and key: if the first request committed, the server answers with the stored response.
        return (await call(path, init)).json()
      }
    },
    url: config.url,
    machines: () => apiFor(config, timeoutMs, '/machines'),
  }
}

type Values = Record<string, string | boolean | string[] | undefined>
type Invocation = { args: string[]; values: Values; cursor: number }
type Deps = { env: NodeJS.ProcessEnv; configPath: string; timeoutMs?: number }
// `nextFor` gets the index one past the last body line printed, for a next step that depends on what was shown.
// `exitCode` is for a command that completes its output but failed part of its work (default 0).
type Result = AgentOutput & { nextFor?: (shownEnd: number) => string; raw?: string; exitCode?: number }

type Spec = {
  path: string[]
  usage: string
  args: number // most positionals accepted; missing ones are checked when the command runs
  // Reads only: --cursor re-runs the command to show the next page, which must not mutate anything again.
  pages?: true
  options: ParseArgsOptionsConfig
  // Login runs without a saved config; everything else gets an API client.
  run: (inv: Invocation, connect: () => Promise<Api>, deps: Deps) => Promise<Result>
}

const str = { type: 'string' } as const
const many = { type: 'string', multiple: true } as const

function arg(inv: Invocation, index: number, name: string): string {
  return inv.args[index] ?? fail('DR101', { path: name, reason: 'is required' })
}

function text(inv: Invocation, name: string): string | undefined {
  const value = inv.values[name]
  return typeof value === 'string' ? value : undefined
}

function list(inv: Invocation, name: string): string[] | undefined {
  const value = inv.values[name]
  return Array.isArray(value) ? value : undefined
}

function integer(inv: Invocation, name: string, min: number): number | undefined {
  const value = text(inv, name)
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) < min)
    fail('DR101', { path: `--${name}`, reason: `must be an integer >= ${min}` })
  return Number(value)
}

function hours(value: string | undefined): number | null | undefined {
  if (value === undefined || value === 'none') return value === 'none' ? null : undefined
  const n = Number(value)
  if (value.trim() === '' || !Number.isFinite(n) || n < 0)
    fail('DR101', { path: '--estimate', reason: 'must be hours >= 0' })
  return n
}

// `none` clears an optional field on edit; the API takes null for that.
const orNull = (value: string | undefined) => (value === 'none' ? null : value)

type Mutation = { eventId: string; delivered?: string | null; openCriteria?: number }

function done(summary: string, result: Mutation, next = 'devrounds plan show'): Result {
  const body = [fmt`${summary} (event ${result.eventId})`]
  if (result.delivered) body.push(`phase ${result.delivered} delivered`)
  return { failures: [], body, next }
}

const path = (...parts: string[]) => `/${parts.map(encodeURIComponent).join('/')}`

// Criteria and links target a task or a phase; the plan says which one a key names.
async function target(
  api: Api,
  key: string,
): Promise<{ plan: PlanView; body: { taskKey?: string; phaseKey?: string } }> {
  const plan = await api.get<PlanView>('/plan')
  return { plan, body: plan.phases.some((p) => p.key === key) ? { phaseKey: key } : { taskKey: key } }
}

function taskTransition(verb: string, to: string, next?: (key: string, result: Mutation) => string): Spec {
  return {
    path: ['task', verb],
    usage: `task ${verb} <task> [--reason <text>]`,
    args: 1,
    options: { reason: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<task>')
      const result = await api.send<Mutation>('POST', path('tasks', key, 'transition'), {
        to,
        reason: text(inv, 'reason'),
      })
      return done(`${key} ${to}`, result, next?.(shellArg(key), result))
    },
  }
}

function dependency(scope: 'phase' | 'task', verb: 'add' | 'rm'): Spec {
  const prefix = scope === 'phase' ? ['phase', 'dep'] : ['dep']
  return {
    path: [...prefix, verb],
    usage: `${prefix.join(' ')} ${verb} <${scope}> --blocked-by <${scope}> [--reason <text>]`,
    args: 1,
    options: { 'blocked-by': str, reason: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, `<${scope}>`)
      const blockedByKey = text(inv, 'blocked-by') ?? fail('DR101', { path: '--blocked-by', reason: 'is required' })
      const result = await api.send<Mutation>(
        verb === 'add' ? 'POST' : 'DELETE',
        path(`${scope}s`, key, 'dependencies'),
        {
          blockedByKey,
          reason: text(inv, 'reason'),
        },
      )
      return done(`${key} ${verb === 'add' ? 'blocked by' : 'no longer blocked by'} ${blockedByKey}`, result)
    },
  }
}

// The criterion of every task the improvement report opens: the agent working it says why it happened or fixes it.
const FINDING_CRITERION = 'explained or fixed, with evidence'

const IMPORT_SAMPLE = 20

// A run as JSON: its dates arrive as ISO strings.
type RunJson = Omit<RunView, 'timeline' | 'steps' | 'delays'> & {
  timeline: Record<keyof RunView['timeline'], string | null>
  steps: { step: number; name: string; startedAt: string; finishedAt: string | null; outcome: string | null }[]
  delays: { at: string; reason: string; needBytes: number; availableBytes: number | null; position: number }[]
}

// GET /runs/:id/logs (runs/log-store.ts LogPage, with the cursor as a number).
type LogPageJson = { lines: { seq: number; text: string }[]; nextCursor: number | null }

const TERMINAL_RUN = ['finished', 'failed', 'stopped', 'orphaned', 'skipped']
// Below the client's 30 s timeout, so a long wait is several requests that each answer in time.
const RUN_WAIT_S = 25

// A gate ends when its last check does; `gate run` waits for a busy worktree at most this long unless told otherwise.
const GATE_LOCK_WAIT_S = 900
const GATE_WAIT_S = RUN_WAIT_S

async function waitGate(api: Api, first: GateJson, wait: boolean): Promise<GateJson> {
  let gate = first
  while (wait && gate.state === 'running') {
    gate = await api.get<GateJson>(path('gates', gate.id), { wait: String(GATE_WAIT_S) })
  }
  return gate
}

// --json prints the gate view as the server answered it, and nothing else.
function gateResult(inv: Invocation, gate: GateJson): Result {
  return inv.values.json === true
    ? { failures: [], body: [], next: '', raw: `${JSON.stringify(gate)}\n` }
    : gateShow(gate)
}

// GET /runs (api/view-routes.ts), dates as ISO strings. The first ask takes the route's largest page.
type RunListJson = {
  runs: {
    id: string
    state: string
    attempt: number
    cause: string
    jobType: string
    queue: string
    machine: string | null
    queuedAt: string
    finishedAt: string | null
    failureClass: string | null
    totalMs: number | null
  }[]
  nextCursor: string | null
}
const RUN_LIST_LIMIT = 100
// The states `run show` reports as failures.
const FAILED_RUN = ['failed', 'stopped', 'orphaned']

const runListLine = (r: RunListJson['runs'][number]) =>
  fmt`${r.id} ${r.state}${r.failureClass ? `: ${r.failureClass}` : ''} · ${r.jobType} · queue ${r.queue} · ` +
  fmt`on ${r.machine ?? 'no machine'} · attempt ${r.attempt} (${r.cause}) · queued ${r.queuedAt}` +
  (r.totalMs == null ? '' : fmt` · total ${r.totalMs} ms`)

const mib = (bytes: number | null) => (bytes == null ? '-' : `${(bytes / 1048576).toFixed(1)} MiB`)
const ms = (value: number | null) => (value == null ? '-' : `${value} ms`)

// Failures first (state, class, summary), then timeline, durations, resources, steps and delays.
function runShow(r: RunJson): Result {
  const failed = FAILED_RUN.includes(r.state)
  const exit = r.outcome.exitCode == null ? '' : fmt` (exit ${r.outcome.exitCode})`
  const failures = failed
    ? [
        fmt`run ${r.id} ${r.state}${r.outcome.failureClass ? `: ${r.outcome.failureClass}` : ''}${exit}`,
        ...(r.outcome.failureSummary ? [fmt`summary: ${r.outcome.failureSummary}`] : []),
      ]
    : []
  const t = r.timeline
  const res = r.resources
  const body = [
    fmt`run ${r.id} ${r.state}${failed ? '' : exit} · ${r.jobType} on ${r.machine} · attempt ${r.attempt}${r.task ? ` · task ${r.task}` : ''}`,
    // A cache hit ran nothing: its outcome, log and resources are the source run's.
    ...(r.cachedFrom ? [fmt`cached from ${r.cachedFrom}`] : []),
    fmt`timeline: queued ${t.queuedAt} · offered ${t.offeredAt} · admitted ${t.admittedAt} · started ${t.startedAt} · finished ${t.finishedAt}`,
    fmt`durations: queue wait ${ms(r.durations.queueWaitMs)} · admission delay ${ms(r.durations.admissionDelayMs)} · run ${ms(r.durations.runTimeMs)} · total ${ms(r.durations.totalMs)}`,
    fmt`resources: peak ${mib(res.peak)} · p95 ${mib(res.p95)} · p50 ${mib(res.p50)} · cpu ${res.cpuSeconds} s · swept ${res.swept} · visible windows ${res.visibleWindows}`,
  ]
  if (r.steps.length > 0) {
    body.push('steps:')
    for (const s of r.steps)
      body.push(fmt`  ${s.step} ${s.name} ${s.outcome ?? 'open'} · ${s.startedAt} → ${s.finishedAt}`)
  }
  if (r.delays.length > 0) {
    body.push('delays:')
    for (const d of r.delays) {
      body.push(
        fmt`  ${d.at} ${d.reason} · position ${d.position} · need ${mib(d.needBytes)} · available ${mib(d.availableBytes)}`,
      )
    }
  }
  const id = shellArg(r.id)
  const next = failed
    ? `devrounds run logs ${id}`
    : r.cachedFrom
      ? `devrounds run show ${shellArg(r.cachedFrom)}`
      : TERMINAL_RUN.includes(r.state)
        ? 'devrounds plan show'
        : `devrounds run show ${id} --wait`
  return { failures, body, next }
}

export const COMMANDS: Spec[] = [
  {
    path: ['login'],
    usage: 'login --url <url> --token <token> --project <key>   save ~/.devrounds/config.json',
    args: 0,
    options: { url: str, token: str, project: str },
    run: async (inv, _connect, deps) => {
      const need = (name: string) => text(inv, name) ?? fail('DR101', { path: `--${name}`, reason: 'is required' })
      const config = { url: need('url').replace(/\/+$/, ''), token: need('token'), project: need('project') }
      // Check the three values together before saving them: a typo shows up now, not in the next session.
      const plan = await apiFor(config, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS).get<PlanView>('/plan')
      await mkdir(dirname(deps.configPath), { recursive: true, mode: 0o700 })
      // The token never sits in a file others can read. The temp file is created empty and restricted first (on
      // Windows the 0600 mode is ignored and the file starts with the inherited ACL), only then gets the token, and
      // is renamed over the config (rename keeps its ACL and mode). Any failure removes it.
      const temp = `${deps.configPath}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, '', { mode: 0o600, flag: 'wx' })
        await restrictToOwner(temp)
        await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`)
        await rename(temp, deps.configPath)
      } catch (err) {
        await rm(temp, { force: true })
        throw err
      }
      return {
        failures: [],
        body: [
          fmt`logged in to ${config.url}, project ${plan.project.key} (${plan.project.name})`,
          `wrote ${deps.configPath}`,
        ],
        next: 'devrounds plan show',
      }
    },
  },
  {
    path: ['plan', 'show'],
    usage: 'plan show [--phase <key>] [--cursor <n>]',
    args: 0,
    pages: true,
    options: { phase: str },
    run: async (inv, connect) => {
      const api = await connect()
      const plan = await api.get<PlanView>('/plan')
      const phase = text(inv, 'phase')
      if (phase !== undefined && !plan.phases.some((p) => p.key === phase)) fail('DR201', { kind: 'phase', key: phase })
      const shown = planShow(plan, { phase })
      return { failures: [], ...shown }
    },
  },
  {
    path: ['plan', 'export'],
    usage: 'plan export [--out <file>]   without --out, prints the raw YAML (for redirecting)',
    args: 0,
    options: { out: str },
    run: async (inv, connect) => {
      const api = await connect()
      const yaml = await api.getText('/export')
      const out = text(inv, 'out')
      // Raw YAML on stdout must stay a valid file, so it skips agent output mode.
      if (out === undefined) return { failures: [], body: [], next: '', raw: yaml }
      await writeFile(out, yaml)
      return { failures: [], body: [`wrote ${out}`], next: `devrounds plan import ${shellArg(out)}` }
    },
  },
  {
    path: ['plan', 'import'],
    usage: 'plan import <file>',
    args: 1,
    options: {},
    run: async (inv, connect) => {
      const api = await connect()
      const file = arg(inv, 0, '<file>')
      const yaml = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) =>
        fail('DR101', { path: file, reason: `cannot be read (${err.code ?? err.message})` }),
      )
      const r = await api.send<ImportResult>('POST', '/import', yaml, 'text/yaml')
      // A mutation cannot page (running it again with --cursor would import again and report different lists), so
      // each list prints a bounded sample: 3 lists x 21 lines of at most ~200-byte keys stay under the body budget.
      const keys = (label: string, items: string[]) => {
        if (items.length === 0) return []
        const rest = items.length - IMPORT_SAMPLE
        const tail = rest > 0 ? [`  … and ${rest} more (devrounds plan show)`] : []
        return [`${label} (${items.length}):`, ...items.slice(0, IMPORT_SAMPLE).map((key) => `  ${key}`), ...tail]
      }
      return {
        failures: [],
        body: [
          ...keys('created', r.created),
          ...keys('updated', r.updated),
          fmt`unchanged: ${r.unchanged}`,
          ...keys('only in DevRounds (missing from the file)', r.onlyInDb),
        ],
        next: 'devrounds plan show',
      }
    },
  },
  {
    path: ['phase', 'add'],
    usage: 'phase add <key> --title <text> [--goal <text>] [--position <n>] [--criterion <text>]...',
    args: 1,
    options: { title: str, goal: str, position: str, criterion: many },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<key>')
      const result = await api.send<Mutation>('POST', '/phases', {
        key,
        title: text(inv, 'title'),
        goal: text(inv, 'goal') ?? '',
        position: integer(inv, 'position', 1),
        criteria: list(inv, 'criterion'),
      })
      return done(`added phase ${key}`, result)
    },
  },
  {
    path: ['phase', 'edit'],
    usage: 'phase edit <key> --reason <text> [--title <text>] [--goal <text>]',
    args: 1,
    options: { title: str, goal: str, reason: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<key>')
      const body = { title: text(inv, 'title'), goal: text(inv, 'goal'), reason: text(inv, 'reason') }
      return done(`edited phase ${key}`, await api.send<Mutation>('PATCH', path('phases', key), body))
    },
  },
  {
    path: ['phase', 'move'],
    usage: 'phase move <key> --position <n> --reason <text>',
    args: 1,
    options: { position: str, reason: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<key>')
      const body = { position: integer(inv, 'position', 1), reason: text(inv, 'reason') }
      return done(`moved phase ${key}`, await api.send<Mutation>('POST', path('phases', key, 'move'), body))
    },
  },
  {
    path: ['phase', 'close'],
    usage: 'phase close <key>',
    args: 1,
    options: {},
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<key>')
      return done(`closed phase ${key}`, await api.send<Mutation>('POST', path('phases', key, 'close')))
    },
  },
  {
    path: ['phase', 'reopen'],
    usage: 'phase reopen <key> --reason <text>',
    args: 1,
    options: { reason: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<key>')
      const body = { reason: text(inv, 'reason') }
      return done(`reopened phase ${key}`, await api.send<Mutation>('POST', path('phases', key, 'reopen'), body))
    },
  },
  dependency('phase', 'add'),
  dependency('phase', 'rm'),
  {
    path: ['task', 'add'],
    usage:
      'task add <key> --title <text> [--phase <key>] [--parent <task>] [--description <text>] [--assignee <name>]\n' +
      '      [--estimate <hours>] [--criterion <text>]... [--blocked-by <task>]...',
    args: 1,
    options: {
      title: str,
      phase: str,
      parent: str,
      description: str,
      assignee: str,
      estimate: str,
      criterion: many,
      'blocked-by': many,
    },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<key>')
      const result = await api.send<Mutation>('POST', '/tasks', {
        key,
        title: text(inv, 'title'),
        phaseKey: text(inv, 'phase'),
        parentKey: text(inv, 'parent'),
        description: text(inv, 'description'),
        assigneeName: text(inv, 'assignee'),
        estimateHours: hours(text(inv, 'estimate')) ?? undefined,
        criteria: list(inv, 'criterion'),
        blockedBy: list(inv, 'blocked-by'),
      })
      return done(`added task ${key}`, result, `devrounds task start ${shellArg(key)}`)
    },
  },
  {
    path: ['task', 'open-finding'],
    usage:
      'task open-finding --source-key <key> --title <text> [--description <text>] [--criterion <text>]...\n' +
      '      opens an F- task, or names the open task of that source key',
    args: 0,
    options: { 'source-key': str, title: str, description: str, criterion: many },
    run: async (inv, connect) => {
      const api = await connect()
      const sourceKey = text(inv, 'source-key') ?? fail('DR101', { path: '--source-key', reason: 'is required' })
      const result = await api.send<{ key: string; created: boolean; eventId: string | null }>('POST', '/findings', {
        sourceKey,
        title: text(inv, 'title'),
        description: text(inv, 'description'),
        criteria: list(inv, 'criterion'),
      })
      // An already open task may be started already, so only a new one points at `task start`.
      if (result.created) {
        return {
          failures: [],
          body: [fmt`opened ${result.key} ${text(inv, 'title')}`],
          next: `devrounds task start ${shellArg(result.key)}`,
        }
      }
      return { failures: [], body: [fmt`already open ${result.key} ${sourceKey}`], next: 'devrounds plan show' }
    },
  },
  {
    path: ['task', 'edit'],
    usage:
      'task edit <task> --reason <text> [--title <text>] [--description <text>] [--phase <key>|none]\n' +
      '      [--assignee <name>|none] [--estimate <hours>|none]',
    args: 1,
    options: { title: str, description: str, phase: str, assignee: str, estimate: str, reason: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<task>')
      const result = await api.send<Mutation>('PATCH', path('tasks', key), {
        title: text(inv, 'title'),
        description: text(inv, 'description'),
        phaseKey: orNull(text(inv, 'phase')),
        assigneeName: orNull(text(inv, 'assignee')),
        estimateHours: hours(text(inv, 'estimate')),
        reason: text(inv, 'reason'),
      })
      return done(`edited task ${key}`, result)
    },
  },
  taskTransition('start', 'in_progress', (key, r) =>
    r.openCriteria ? `devrounds criterion check ${key} --evidence <evidence>` : `devrounds task done ${key}`,
  ),
  taskTransition('done', 'done'),
  taskTransition('block', 'blocked'),
  taskTransition('cancel', 'cancelled'),
  {
    path: ['task', 'reopen'],
    usage: 'task reopen <task> --reason <text>   done or blocked -> in_progress, cancelled -> todo',
    args: 1,
    options: { reason: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<task>')
      const plan = await api.get<PlanView>('/plan')
      const task = [...plan.phases.flatMap((p) => p.tasks), ...plan.unphased].find((t) => t.key === key)
      if (!task) fail('DR201', { kind: 'task', key })
      const to = task.state === 'cancelled' ? 'todo' : 'in_progress'
      const result = await api.send<Mutation>('POST', path('tasks', key, 'transition'), {
        to,
        reason: text(inv, 'reason'),
      })
      return done(`${key} ${to}`, result)
    },
  },
  dependency('task', 'add'),
  dependency('task', 'rm'),
  {
    path: ['criterion', 'add'],
    usage: 'criterion add <task|phase> --text <text>',
    args: 1,
    options: { text: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<task|phase>')
      const { body } = await target(api, key)
      const result = await api.send<Mutation>('POST', '/criteria', { ...body, text: text(inv, 'text') })
      return done(`added a criterion to ${key}`, result)
    },
  },
  {
    path: ['criterion', 'check'],
    usage:
      'criterion check <task|phase> [<n>] --evidence commit:<sha>|gate:<name>|url:<http(s) url>|note:<text>\n' +
      '      without <n>, checks the first open criterion',
    args: 2,
    options: { evidence: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<task|phase>')
      // The service owns the evidence format (planning/service.ts EVIDENCE); the CLI passes it on as given.
      const evidence = text(inv, 'evidence')
      if (inv.args[1] !== undefined && !/^[1-9]\d*$/.test(inv.args[1])) {
        fail('DR101', { path: '<n>', reason: 'must be a criterion number from plan show' })
      }
      const { plan, body } = await target(api, key)
      let position = inv.args[1] === undefined ? undefined : Number(inv.args[1])
      if (position === undefined) {
        const holder = body.phaseKey
          ? plan.phases.find((p) => p.key === key)
          : [...plan.phases.flatMap((p) => p.tasks), ...plan.unphased].find((t) => t.key === key)
        if (!holder) fail('DR201', { kind: 'task', key })
        position =
          holder.criteria.find((c) => !c.checked)?.position ??
          fail('DR101', { path: '<n>', reason: `${key} has no open criterion` })
      }
      const result = await api.send<Mutation>('POST', '/criteria/check', { ...body, position, evidence })
      return done(`checked criterion ${position} of ${key}`, result)
    },
  },
  {
    path: ['link', 'add'],
    usage: 'link add <task|phase> --kind <kind> --ref <ref> [--title <text>]',
    args: 1,
    options: { kind: str, ref: str, title: str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<task|phase>')
      const { body } = await target(api, key)
      const result = await api.send<Mutation>('POST', '/links', {
        ...body,
        kind: text(inv, 'kind'),
        ref: text(inv, 'ref'),
        title: text(inv, 'title'),
      })
      return done(`linked ${key}`, result)
    },
  },
  {
    path: ['events'],
    usage: 'events [--after <id>] [--cursor <n>]',
    args: 0,
    pages: true,
    options: { after: str },
    run: async (inv, connect) => {
      const api = await connect()
      const after = text(inv, 'after')
      const events = await api.get<EventView[]>('/events', { afterId: after })
      const body = events.map((e) => {
        const subject = e.taskKey ?? e.phaseKey ?? ''
        const reason = e.reason ? `  reason: ${e.reason}` : ''
        return fmt`${e.id} ${e.at} ${e.actor} ${e.kind} ${subject}${reason}`.replace(/ +$/, '')
      })
      // Continue after the last event actually printed: when the body is cut, the later events of this page are
      // still unread and must not be skipped.
      const nextAfter = (shownEnd: number) => {
        const last = events[shownEnd - 1]?.id ?? after
        return last === undefined ? 'devrounds events' : `devrounds events --after ${shellArg(last)}`
      }
      return {
        failures: [],
        body: body.length > 0 ? body : ['no events'],
        next: nextAfter(events.length),
        nextFor: nextAfter,
      }
    },
  },
  {
    path: ['balance'],
    usage: 'balance [--week] [--cursor <n>]   per day (default) or per week, in the tenant time zone',
    args: 0,
    pages: true,
    options: { week: { type: 'boolean' } },
    run: async (inv, connect) => {
      const api = await connect()
      const week = inv.values.week === true
      type Row = {
        periodStart: string
        done: number
        opened: number
        cancelled: number
        hoursInProgress: number
        avgCycleHours: number | null
      }
      const rows = await api.get<Row[]>('/balance', { period: week ? 'week' : 'day' })
      const body = rows.map(
        (r) =>
          fmt`${r.periodStart}  done ${r.done} · opened ${r.opened} · cancelled ${r.cancelled} · ` +
          fmt`in progress ${r.hoursInProgress} h · avg cycle ${r.avgCycleHours == null ? '-' : `${r.avgCycleHours} h`}`,
      )
      return { failures: [], body, next: 'devrounds plan show' }
    },
  },
  {
    path: ['indicators'],
    usage:
      'indicators [--gates] [--period day|week] [--from <date>] [--to <date>] [--cursor <n>]   runs per local ' +
      'period and job type, in the tenant time zone; the failure classes of each row with failures first; --gates: ' +
      'pass rate, cache share and wall time per gate, red checks per job type',
    args: 0,
    pages: true,
    options: { gates: { type: 'boolean' }, period: str, from: str, to: str },
    run: async (inv, connect) => {
      const api = await connect()
      const query = { period: text(inv, 'period'), from: text(inv, 'from'), to: text(inv, 'to') }
      if (inv.values.gates === true) {
        const { gates, checks } = await api.get<{ gates: GateIndicatorRow[]; checks: CheckIndicatorRow[] }>(
          '/indicators/gates',
          query,
        )
        const pct = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)} %`)
        const red = checks.filter((c) => c.red > 0)
        return {
          failures: red.map((c) => fmt`${c.period} ${c.jobType} red ${c.red} of ${c.checks} checks`),
          body: [
            ...gates.map(
              (g) =>
                fmt`${g.period} ${g.gate}  gates ${g.gates} · passed ${g.passed} · failed ${g.failed} · ` +
                fmt`cancelled ${g.cancelled} · pass rate ${pct(g.passRate)} · cache hits ${pct(g.cacheHitShare)} · ` +
                `wall p50 ${ms(g.wallP50Ms)} p90 ${ms(g.wallP90Ms)}`,
            ),
            ...checks.map(
              (c) =>
                fmt`${c.period} ${c.jobType}  checks ${c.checks} · red ${c.red} · failed ${c.failed} · ` +
                fmt`cached ${c.cached}`,
            ),
            ...(gates.length === 0 ? ['no gate ended in this window'] : []),
          ],
          next: red.length > 0 ? 'devrounds run list --state failed' : 'devrounds indicators',
        }
      }
      const rows = await api.get<IndicatorRow[]>('/indicators', query)
      const failing = rows.filter((r) => Object.keys(r.failureClasses).length > 0)
      const failures = failing.map(
        (r) =>
          fmt`${r.period} ${r.jobType} failed ${r.failed}: ` +
          Object.entries(r.failureClasses)
            .map(([failureClass, n]) => fmt`${failureClass} ${n}`)
            .join(' · '),
      )
      const body = rows.map(
        (r) =>
          fmt`${r.period} ${r.jobType}  runs ${r.runs} · finished ${r.finished} · failed ${r.failed} · ` +
          fmt`skipped ${r.skipped} · retries ${r.retries} · requeues ${r.requeues} · ` +
          `queue wait p50 ${ms(r.queueWaitP50Ms)} p90 ${ms(r.queueWaitP90Ms)} · ` +
          `admission p50 ${ms(r.admissionDelayP50Ms)} · run p50 ${ms(r.runTimeP50Ms)} p90 ${ms(r.runTimeP90Ms)} · ` +
          fmt`peak p50 ${mib(r.peakP50Bytes)} max ${mib(r.peakMaxBytes)} · cpu ${r.cpuSeconds} s`,
      )
      if (rows.length === 0) body.push('no runs ended in this window')
      return { failures, body, next: failing.length > 0 ? 'devrounds run list --state failed' : 'devrounds queue list' }
    },
  },
  {
    path: ['report', 'improvement'],
    usage:
      'report improvement [--day <date>] [--open-tasks]   one local day (default yesterday) against the 7 days ' +
      'before: findings first; --open-tasks opens an F- task per finding, once while it stays open',
    args: 0,
    options: { day: str, 'open-tasks': { type: 'boolean' } },
    run: async (inv, connect) => {
      const api = await connect()
      const report = await api.get<ImprovementReport>('/reports/improvement', { day: text(inv, 'day') })
      const { failures, body } = improvementShow(report)
      if (inv.values['open-tasks'] !== true) {
        const next =
          report.findings.length > 0
            ? `devrounds report improvement --day ${shellArg(report.day)} --open-tasks`
            : 'devrounds indicators'
        return { failures, body, next }
      }
      // One at a time: openFinding takes the project lock, so parallel calls would only queue on it. A refused finding
      // must not cost the ones after it (unclassified_share is always last), so each is tried; the command exits with
      // the CLI code of the first refusal, which the improvement-report job type classifies.
      const refused: string[] = []
      let exitCode: number | undefined
      for (const f of report.findings) {
        try {
          const opened = await api.send<{ key: string; created: boolean }>('POST', '/findings', {
            sourceKey: f.sourceKey,
            title: f.title,
            description: f.evidence,
            criteria: [FINDING_CRITERION],
          })
          body.push(
            opened.created ? fmt`opened ${opened.key} ${f.title}` : fmt`already open ${opened.key} ${f.sourceKey}`,
          )
        } catch (err) {
          const { output, exitCode: code } = failureOutput(err)
          refused.push(fmt`not opened ${f.sourceKey}: ${output.failures[0]}`)
          exitCode ??= code
        }
      }
      if (refused.length > 0) {
        // Opening again is safe: an open source key answers its task instead of a new one.
        const next = `devrounds report improvement --day ${shellArg(report.day)} --open-tasks`
        return { failures: [...refused, ...failures], body, next, exitCode }
      }
      return { failures, body, next: report.findings.length > 0 ? 'devrounds plan show' : 'devrounds indicators' }
    },
  },
  {
    path: ['machine', 'pair-code'],
    usage: 'machine pair-code --name <machine>   human members only; the code works once, within 10 minutes',
    args: 0,
    options: { name: str },
    run: async (inv, connect) => {
      const api = await connect()
      const name = text(inv, 'name') ?? fail('DR101', { path: '--name', reason: 'is required' })
      const r = await api.machines().send<PairingCode>('POST', '/pairing-codes', { name }, undefined, { retry: false })
      return {
        failures: [],
        body: [fmt`pairing code for machine ${r.machineName}: ${r.code}`, fmt`expires at ${r.expiresAt}`],
        next: `devrounds-executor pair --url ${shellArg(api.url)} --code ${r.code}`,
      }
    },
  },
  {
    path: ['machine', 'list'],
    usage: 'machine list [--cursor <n>]',
    args: 0,
    pages: true,
    options: {},
    run: async (_inv, connect) => {
      const api = await connect()
      const machines = await api.machines().get<MachineView[]>('/')
      const body = machines.map(
        (m) =>
          fmt`${m.name}  ${m.connected ? 'connected' : 'offline'} · ${m.os} · executor ${m.executorVersion} · ` +
          `last seen ${m.lastSeenAt ?? 'never'}`,
      )
      return {
        failures: [],
        body: body.length > 0 ? body : ['no machines'],
        next: body.length > 0 ? 'devrounds plan show' : 'devrounds machine pair-code --name <machine>',
      }
    },
  },
  {
    path: ['machine', 'revoke'],
    usage: 'machine revoke <name>   human members only; closes its live session',
    args: 1,
    options: {},
    run: async (inv, connect) => {
      const api = await connect()
      const name = arg(inv, 0, '<name>')
      await api.machines().send('POST', path(name, 'revoke'))
      return { failures: [], body: [`revoked machine ${name}`], next: 'devrounds machine list' }
    },
  },
  {
    path: ['jobtype', 'set'],
    usage: 'jobtype set <file.yaml>   create or replace the job type the file describes',
    args: 1,
    options: {},
    run: async (inv, connect) => {
      const api = await connect()
      const file = arg(inv, 0, '<file.yaml>')
      const yaml = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) =>
        fail('DR101', { path: file, reason: `cannot be read (${err.code ?? err.message})` }),
      )
      // Parsed here only for its key (the route's path); the server checks the file again.
      const { key } = parseJobTypeFile(yaml)
      await api.send('PUT', path('job-types', key), yaml, 'text/yaml')
      return {
        failures: [],
        body: [`saved job type ${key}`],
        next: `devrounds run start ${shellArg(key)} --cwd <path>`,
      }
    },
  },
  {
    path: ['run', 'start'],
    usage:
      'run start <jobType> --cwd <path> [--machine <name>] [--queue <key>] [--task <key>] [--arg <a>]... ' +
      '[--env NAME=value]...   queue a run; the scheduler offers it to a machine with room, --machine pins it; ' +
      '--arg and --env need a job type that allows them (args_from_job, job_env)',
    args: 1,
    options: { machine: str, cwd: str, queue: str, task: str, arg: many, env: many },
    run: async (inv, connect) => {
      const api = await connect()
      const jobType = arg(inv, 0, '<jobType>')
      const cwd = text(inv, 'cwd') ?? fail('DR101', { path: '--cwd', reason: 'is required' })
      const machine = text(inv, 'machine')
      const pairs = list(inv, 'env')
      const env =
        pairs &&
        Object.fromEntries(
          pairs.map((pair) => {
            const at = pair.indexOf('=')
            if (at === -1) fail('DR101', { path: '--env', reason: `${pair} is not NAME=value` })
            return [pair.slice(0, at), pair.slice(at + 1)]
          }),
        )
      const body = {
        jobType,
        cwd,
        machine,
        queue: text(inv, 'queue'),
        task: text(inv, 'task'),
        args: list(inv, 'arg'),
        env,
      }
      const r = await api.send<RunJson>('POST', '/runs', body)
      // The run is placed later, so the machine printed is the pin, if any.
      const on = machine === undefined ? '' : fmt` on ${machine}`
      return {
        failures: [],
        body: [fmt`run ${r.id} ${r.state} · ${r.jobType}` + on],
        next: `devrounds run show ${shellArg(r.id)} --wait`,
      }
    },
  },
  {
    path: ['run', 'show'],
    usage: 'run show <id> [--wait]   --wait returns once the run ended',
    args: 1,
    options: { wait: { type: 'boolean' } },
    run: async (inv, connect) => {
      const api = await connect()
      const id = arg(inv, 0, '<id>')
      const wait = inv.values.wait === true
      let r = await api.get<RunJson>(path('runs', id), wait ? { wait: String(RUN_WAIT_S) } : {})
      while (wait && !TERMINAL_RUN.includes(r.state)) {
        r = await api.get<RunJson>(path('runs', id), { wait: String(RUN_WAIT_S) })
      }
      return runShow(r)
    },
  },
  {
    path: ['run', 'list'],
    usage:
      'run list [--state <s>] [--job-type <k>] [--cursor <c>]   newest first, failed, stopped and orphaned runs ' +
      'of the page first; --cursor is the one a cut output prints',
    args: 0,
    // Not `pages`: the cursor is the server's keyset cursor (api/view-routes.ts), not a body line index.
    options: { state: str, 'job-type': str, cursor: str },
    run: async (inv, connect) => {
      const api = await connect()
      const query = { state: text(inv, 'state'), jobType: text(inv, 'job-type'), cursor: text(inv, 'cursor') }
      // A page is one contiguous stretch of runs, so its cursor continues exactly. When the lines of a page pass the
      // budget, the same page is asked again with as many runs as fit; that answer is printed whole, with its own
      // cursor, so a run queued meanwhile can never be skipped. The limit only shrinks, and one run always fits.
      let limit = RUN_LIST_LIMIT
      let page: RunListJson
      for (;;) {
        page = await api.get<RunListJson>('/runs', { ...query, limit: String(limit) })
        const fits = fitBody(page.runs.map(runListLine), { budget: BODY_BUDGET, cursor: 0 })
        if (fits === page.runs.length) break
        limit = fits
      }
      const failed = page.runs.filter((r) => FAILED_RUN.includes(r.state))
      const body = page.runs.filter((r) => !failed.includes(r)).map(runListLine)
      if (page.runs.length === 0) body.push(query.cursor === undefined ? 'no runs' : 'no runs after this cursor')
      if (page.nextCursor !== null) {
        const args = [
          ...(query.state === undefined ? [] : ['--state', shellArg(query.state)]),
          ...(query.jobType === undefined ? [] : ['--job-type', shellArg(query.jobType)]),
        ]
        body.push(`truncated; more: ${['devrounds run list', ...args, '--cursor', page.nextCursor].join(' ')}`)
      }
      return {
        failures: failed.map(runListLine),
        body,
        next:
          failed.length > 0
            ? `devrounds run show ${shellArg(failed[0].id)}`
            : page.runs.length > 0
              ? `devrounds run show ${shellArg(page.runs[0].id)}`
              : 'devrounds queue list',
      }
    },
  },
  {
    path: ['run', 'logs'],
    usage: 'run logs <id> [--cursor <n>]   the run output, 16384 bytes a page; --cursor is a line seq',
    args: 1,
    // Not `pages`: the cursor is the seq of a log line, which the server pages by, not a body line index.
    options: { cursor: str },
    run: async (inv, connect) => {
      const api = await connect()
      const id = arg(inv, 0, '<id>')
      const cursor = text(inv, 'cursor')
      if (cursor !== undefined && !/^\d{1,19}$/.test(cursor)) {
        fail('DR101', { path: '--cursor', reason: 'must be a line seq (an integer >= 0)' })
      }
      const page = await api.get<LogPageJson>(path('runs', id, 'logs'), { cursor })
      const lines = page.lines.map((line) => line.text)
      // The server counts raw text; printed lines are escaped (oneLine) and may be longer, so the budget is checked
      // again here and a cut continues at the first line not printed.
      const end = fitBody(lines, { budget: BODY_BUDGET, cursor: 0 })
      const nextCursor = end < lines.length ? page.lines[end].seq : page.nextCursor
      const body = lines.slice(0, end)
      if (body.length === 0) body.push(cursor === undefined ? 'no output yet' : 'no output after this cursor')
      if (nextCursor !== null) {
        body.push(`truncated; more: devrounds run logs ${shellArg(id)} --cursor ${nextCursor}`)
      }
      return { failures: [], body, next: `devrounds run show ${shellArg(id)}` }
    },
  },
  {
    path: ['run', 'stop'],
    usage: 'run stop <id>   the executor stops the process tree; the run ends as stopped',
    args: 1,
    options: {},
    run: async (inv, connect) => {
      const api = await connect()
      const id = arg(inv, 0, '<id>')
      await api.send('POST', path('runs', id, 'stop'))
      return {
        failures: [],
        body: [`asked the executor to stop run ${id}`],
        next: `devrounds run show ${shellArg(id)} --wait`,
      }
    },
  },
  {
    path: ['queue', 'set'],
    usage:
      'queue set <key> [--priority <n>] [--concurrency <n>|none] [--machine-concurrency <n>|none] ' +
      '[--job-types <a,b>|none]   create or change a queue; none removes a cap or lets every job type in',
    args: 1,
    options: { priority: str, concurrency: str, 'machine-concurrency': str, 'job-types': str },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<key>')
      const priority = text(inv, 'priority')
      if (priority !== undefined && !/^-?\d{1,10}$/.test(priority)) {
        fail('DR101', { path: '--priority', reason: 'must be an integer' })
      }
      const concurrency = orNull(text(inv, 'concurrency'))
      const machineConcurrency = orNull(text(inv, 'machine-concurrency'))
      const jobTypes = orNull(text(inv, 'job-types'))
      const listed = jobTypes
        ?.split(',')
        .map((jobType) => jobType.trim())
        .filter(Boolean)
      // An empty list lets every job type in; only the literal `none` says so, never a stray "," or blank.
      if (listed?.length === 0) {
        fail('DR101', { path: '--job-types', reason: 'lists no job type; use none to let every job type in' })
      }
      const body = {
        priority: priority === undefined ? undefined : Number(priority),
        concurrency: concurrency == null ? concurrency : (integer(inv, 'concurrency', 1) as number),
        machineConcurrency:
          machineConcurrency == null ? machineConcurrency : (integer(inv, 'machine-concurrency', 1) as number),
        jobTypes: jobTypes === null ? [] : listed,
      }
      const q = await api.send<QueueJson>('PUT', path('queues', key), body)
      return { failures: [], body: [queueLine(q)], next: 'devrounds queue list' }
    },
  },
  {
    path: ['queue', 'list'],
    usage: 'queue list [--cursor <n>]   depth = runs queued, in flight = offered, admitted or running',
    args: 0,
    pages: true,
    options: {},
    run: async (_inv, connect) => {
      const api = await connect()
      const queues = await api.get<QueueJson[]>('/queues')
      return {
        failures: [],
        body: queues.length > 0 ? queues.map(queueLine) : ['no queues'],
        next: queues.length > 0 ? 'devrounds batch submit <file.yaml>' : 'devrounds queue set <key>',
      }
    },
  },
  {
    path: ['schedule', 'set'],
    usage:
      'schedule set <key> --job-type <jt> --cwd <path> (--daily HH:MM | --every <seconds>) [--queue <key>] ' +
      '[--machine <name>] [--disable]   create or replace a schedule; --daily is the tenant time zone, --every >= 60',
    args: 1,
    options: {
      'job-type': str,
      cwd: str,
      daily: str,
      every: str,
      queue: str,
      machine: str,
      disable: { type: 'boolean' },
    },
    run: async (inv, connect) => {
      const api = await connect()
      const key = arg(inv, 0, '<key>')
      const body = {
        jobType: text(inv, 'job-type') ?? fail('DR101', { path: '--job-type', reason: 'is required' }),
        cwd: text(inv, 'cwd') ?? fail('DR101', { path: '--cwd', reason: 'is required' }),
        queue: text(inv, 'queue'),
        machine: text(inv, 'machine'),
        everyS: integer(inv, 'every', 1),
        dailyAt: text(inv, 'daily'),
        enabled: inv.values.disable === true ? false : undefined,
      }
      const s = await api.send<ScheduleJson>('PUT', path('schedules', key), body)
      return { failures: [], body: [scheduleLine(s)], next: 'devrounds schedule list' }
    },
  },
  {
    path: ['schedule', 'list'],
    usage: 'schedule list [--cursor <n>]   next due is shown in the tenant time zone',
    args: 0,
    pages: true,
    options: {},
    run: async (_inv, connect) => {
      const api = await connect()
      const schedules = await api.get<ScheduleJson[]>('/schedules')
      return {
        failures: [],
        body: schedules.length > 0 ? schedules.map(scheduleLine) : ['no schedules'],
        next:
          schedules.length > 0 ? 'devrounds queue list' : 'devrounds schedule set <key> --job-type <jt> --cwd <path>',
      }
    },
  },
  {
    path: ['batch', 'submit'],
    usage: 'batch submit <file.yaml>   queue the jobs of the file with their depends_on edges, all or nothing',
    args: 1,
    options: {},
    run: async (inv, connect) => {
      const api = await connect()
      const file = arg(inv, 0, '<file.yaml>')
      const yaml = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) =>
        fail('DR101', { path: file, reason: `cannot be read (${err.code ?? err.message})` }),
      )
      // Parsed here so a problem points at its line in the file; the server checks the jobs again.
      const b = await api.send<BatchJson>('POST', '/batches', parseBatchFile(yaml))
      return { failures: [], body: b.jobs.map(batchJobLine), next: `devrounds batch show ${shellArg(b.id)}` }
    },
  },
  {
    path: ['batch', 'show'],
    usage: 'batch show <id>   failed and skipped jobs first, then the rest',
    args: 1,
    options: {},
    run: async (inv, connect) => {
      const api = await connect()
      const b = await api.get<BatchJson>(path('batches', arg(inv, 0, '<id>')))
      const failed = b.jobs.filter((j) => j.state === 'failed' || j.state === 'skipped')
      const next =
        failed.length > 0
          ? `devrounds run show ${shellArg(failed[0].runId)}`
          : b.jobs.some((j) => j.state === 'open')
            ? `devrounds batch show ${shellArg(b.id)}`
            : 'devrounds plan show'
      return {
        failures: failed.map(batchJobLine),
        body: [
          fmt`batch ${b.id} · ${b.jobs.length} jobs`,
          ...b.jobs.filter((j) => !failed.includes(j)).map(batchJobLine),
        ],
        next,
      }
    },
  },
  {
    path: ['gate', 'run'],
    usage:
      'gate run <file.yaml> --cwd <path> [--machine <name>] [--head-sha <sha>] [--dirty] [--wait] ' +
      '[--wait-lock <s>|--no-wait-lock] [--json]   run the repo checks of the file on one worktree; one gate runs per ' +
      `worktree, so a busy one is waited for up to ${GATE_LOCK_WAIT_S} s (--wait-lock) or refused with DR308 ` +
      '(--no-wait-lock); --wait returns once the gate ended; --json prints the gate view',
    args: 1,
    options: {
      cwd: str,
      machine: str,
      'head-sha': str,
      dirty: { type: 'boolean' },
      wait: { type: 'boolean' },
      'wait-lock': str,
      'no-wait-lock': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    run: async (inv, connect) => {
      const api = await connect()
      const file = arg(inv, 0, '<file.yaml>')
      const cwd = text(inv, 'cwd') ?? fail('DR101', { path: '--cwd', reason: 'is required' })
      const waitLock = integer(inv, 'wait-lock', 0)
      if (inv.values['no-wait-lock'] === true && waitLock !== undefined) {
        fail('DR101', { path: '--no-wait-lock', reason: 'cannot be combined with --wait-lock' })
      }
      const lockS = inv.values['no-wait-lock'] === true ? 0 : (waitLock ?? GATE_LOCK_WAIT_S)
      const yaml = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) =>
        fail('DR101', { path: file, reason: `cannot be read (${err.code ?? err.message})` }),
      )
      // Parsed here so a problem points at its line in the file; the server checks the file again.
      const body = {
        file: parseGateFile(yaml),
        cwd,
        machine: text(inv, 'machine'),
        headSha: text(inv, 'head-sha'),
        dirty: inv.values.dirty === true ? true : undefined,
      }
      // The server never holds a submit for the lock: it names the holder (DR308), this waits on the holder and
      // submits again with a new Idempotency-Key (each send makes one), until the deadline.
      const deadline = Date.now() + lockS * 1000
      let gate: GateJson | undefined
      while (gate === undefined) {
        try {
          gate = await api.send<GateJson>('POST', '/gates', body)
        } catch (err) {
          const left = deadline - Date.now()
          if (!(err instanceof ApiError) || err.code !== 'DR308' || left <= 0) throw err
          const holder = err.data.gate
          if (typeof holder !== 'string') throw err
          await api.get(path('gates', holder), { wait: String(Math.min(GATE_WAIT_S, Math.ceil(left / 1000))) })
        }
      }
      return gateResult(inv, await waitGate(api, gate, inv.values.wait === true))
    },
  },
  {
    path: ['gate', 'show'],
    usage: 'gate show <id> [--wait] [--json]   failed, skipped and stopped checks first; --wait returns once it ended',
    args: 1,
    options: { wait: { type: 'boolean' }, json: { type: 'boolean' } },
    run: async (inv, connect) => {
      const api = await connect()
      const id = arg(inv, 0, '<id>')
      const wait = inv.values.wait === true
      const gate = await api.get<GateJson>(path('gates', id), wait ? { wait: String(GATE_WAIT_S) } : {})
      return gateResult(inv, await waitGate(api, gate, wait))
    },
  },
]

// GET /queues (queues/service.ts QueueView) and GET /batches/:id (jobs/enqueue.ts BatchView) as JSON.
type QueueJson = {
  key: string
  priority: number
  concurrency: number | null
  machineConcurrency: number | null
  jobTypes: string[]
  depth: number
  inFlight: number
  oldestQueuedAt: string | null
}
type BatchJson = {
  id: string
  jobs: { ref: string; jobId: string; runId: string; jobType: string; state: string; cachedFrom: string | null }[]
}

const queueLine = (q: QueueJson) =>
  fmt`${q.key}  priority ${q.priority} · concurrency ${q.concurrency ?? 'none'} · ` +
  fmt`per machine ${q.machineConcurrency ?? 'none'} · ` +
  fmt`job types ${q.jobTypes?.length ? q.jobTypes.join(', ') : 'any'} · depth ${q.depth} · in flight ${q.inFlight} · ` +
  fmt`oldest queued ${q.oldestQueuedAt}`

// GET /schedules (scheduler/schedules.ts ScheduleView) as JSON.
type ScheduleJson = {
  key: string
  jobType: string
  every: number | null
  dailyAt: string | null
  enabled: boolean
  nextDueAt: string
  timeZone: string
  lastJob: { id: string; state: string } | null
}

const scheduleLine = (s: ScheduleJson) => {
  const next = new Intl.DateTimeFormat('sv-SE', {
    timeZone: s.timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(s.nextDueAt))
  return (
    fmt`${s.key}  ${s.jobType} · ${s.dailyAt === null ? `every ${s.every} s` : `daily ${s.dailyAt}`} · ` +
    fmt`${s.enabled ? `next due ${next} ${s.timeZone}` : 'disabled'} · last job ${s.lastJob?.id ?? 'none'} ${s.lastJob?.state ?? ''}`
  ).trimEnd()
}

const batchJobLine = (j: BatchJson['jobs'][number]) =>
  fmt`${j.ref}  ${j.state}${j.cachedFrom ? ' (cached)' : ''} · ${j.jobType} · run ${j.runId}`

type PairingCode = { code: string; expiresAt: string; machineName: string }
type MachineView = { name: string; os: string; executorVersion: string; lastSeenAt: string | null; connected: boolean }

const usageLine = (c: Spec) => `devrounds ${c.usage}`

export function usage(): string {
  const lines = COMMANDS.map((c) => `  ${usageLine(c)}`)
  return [
    'usage: devrounds <command> [options]',
    '',
    ...lines,
    '',
    'Every command except login takes --project <key> to use that project instead of the configured one.',
    'Reads (plan show, events, balance, machine list) take --cursor <n> to continue an output cut at 16384 bytes.',
    'Config: ~/.devrounds/config.json from `devrounds login`, or DEVROUNDS_URL, DEVROUNDS_TOKEN, DEVROUNDS_PROJECT.',
    'Exit codes: 0 ok, 1 state conflict, 2 input/usage, 3 not found, 4 control plane unreachable, 5 auth, 6 internal.',
  ].join('\n')
}

// The longest word path that matches the start of argv.
function findSpec(argv: string[]): Spec | undefined {
  return COMMANDS.filter((c) => c.path.every((word, i) => argv[i] === word)).sort(
    (a, b) => b.path.length - a.path.length,
  )[0]
}

// --cursor on every read command, so `more:` is always the same command with --cursor N. Mutations reject it.
// --project on every command that connects (login has its own, required one).
function optionsOf(spec: Spec): ParseArgsOptionsConfig {
  const base = spec.path[0] === 'login' ? spec.options : { ...spec.options, project: str }
  return spec.pages ? { ...base, cursor: str } : base
}

// parseArgs rejects `--title -h` as ambiguous (it wants `--title=-h`). A value that starts with one dash (-h, -5) is
// still a value after an option that takes one, so glue the pair. A `--` word stays a flag: `--title --help`
// is a missing title plus a help request, not a title.
function valuesWithDash(args: string[], options: ParseArgsOptionsConfig): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const name = /^--([^=]+)$/.exec(args[i])?.[1]
    const next = args[i + 1]
    if (name !== undefined && options[name]?.type === 'string' && /^-[^-]/.test(next ?? '')) {
      out.push(`${args[i]}=${next}`)
      i++
    } else out.push(args[i])
  }
  return out
}

// -h and --help ask for usage only where they are a flag: `--title -h` gives the title "-h". Telling the two apart
// needs the command's option table, so the scan reuses parseArgs instead of looking at raw words.
function wantsHelp(argv: string[]): boolean {
  const spec = findSpec(argv)
  try {
    const { tokens = [] } = parseArgs({
      args: spec ? valuesWithDash(argv.slice(spec.path.length), optionsOf(spec)) : argv,
      options: spec ? optionsOf(spec) : {},
      allowPositionals: true,
      strict: false,
      tokens: true,
    })
    return tokens.some((t) => t.kind === 'option' && (t.name === 'help' || t.name === 'h'))
  } catch {
    return false
  }
}

// Resolves the command (longest matching word path) and parses its flags strictly. Missing positionals and flag
// values are reported when the command runs, so `devrounds task start` alone parses (AGENTS.md quotes it so).
export function parseCommand(argv: string[]): { spec: Spec; inv: Invocation } {
  const spec = findSpec(argv)
  if (!spec) fail('DR101', { path: 'command', reason: `unknown command "${argv.join(' ')}"; see devrounds --help` })
  const options = optionsOf(spec)
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: valuesWithDash(argv.slice(spec.path.length), options),
      options,
      allowPositionals: true,
      strict: true,
    })
  } catch (err) {
    return fail('DR101', { path: spec.path.join(' '), reason: (err as Error).message })
  }
  if (parsed.positionals.length > spec.args) {
    fail('DR101', { path: spec.path.join(' '), reason: `unexpected argument "${parsed.positionals[spec.args]}"` })
  }
  const inv: Invocation = { args: parsed.positionals, values: parsed.values as Values, cursor: 0 }
  // Only paged commands read --cursor as a body line index; `run logs` reads its own.
  if (spec.pages) inv.cursor = integer(inv, 'cursor', 0) ?? 0
  return { spec, inv }
}

// The exact command that was run, with --cursor N in place of any cursor it had. Arguments are quoted (shellArg).
export function moreCommandFor(argv: string[]): (cursor: number) => string {
  const kept: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cursor') i++
    else if (!argv[i].startsWith('--cursor=')) kept.push(argv[i])
  }
  return (cursor) => ['devrounds', ...kept.map(shellArg), '--cursor', String(cursor)].join(' ')
}

function failureOutput(err: unknown): { output: AgentOutput; exitCode: number } {
  if (err instanceof Unreachable) {
    return { output: { failures: [err.message], body: [], next: err.next }, exitCode: 4 }
  }
  let code: string
  let words: { text: string; hint: string }
  if (err instanceof ApiError) {
    code = err.code
    words = err
  } else if (err instanceof DevRoundsError) {
    code = err.code
    words = explain(err.code, err.data)
  } else {
    // A bug in the CLI itself: say what broke instead of a bare "internal error".
    code = 'DR501'
    words = { text: `Internal error: ${(err as Error)?.message ?? String(err)}.`, hint: explain('DR501').hint }
  }
  const exitCode = exitCodeFor(code)
  // The configured project itself not found (wrong key, or a key of another tenant) is a config problem too.
  const projectMissing = err instanceof ApiError && code === 'DR201' && err.data.kind === 'project'
  const next =
    exitCode === 5 || projectMissing || err instanceof LoginNeeded
      ? LOGIN_NEXT
      : exitCode === 2
        ? 'devrounds --help'
        : 'devrounds plan show'
  return { output: { failures: [`${code} ${words.text}`, `hint: ${words.hint}`], body: [], next }, exitCode }
}

export async function runCli(
  argv: string[],
  deps: Deps,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (argv.length === 0 || wantsHelp(argv)) {
    // A full command path gets its own line; anything else (no command, a prefix like `task`) gets the list.
    const spec = findSpec(argv)
    const text = `${spec ? `usage: ${usageLine(spec)}` : usage()}\n`
    return argv.length === 0 ? { exitCode: 2, stdout: '', stderr: text } : { exitCode: 0, stdout: text, stderr: '' }
  }
  try {
    const { spec, inv } = parseCommand(argv)
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let connected: Promise<Api> | undefined
    const connect = () => {
      connected ??= loadCliConfig(deps.env, deps.configPath, text(inv, 'project')).then((config) =>
        apiFor(config, timeoutMs),
      )
      return connected
    }
    const result = await spec.run(inv, connect, deps)
    if (result.raw !== undefined) return { exitCode: 0, stdout: result.raw, stderr: '' }
    // Other commands print bounded bodies (a summary line, or import's capped samples), so they are never cut and
    // never offer a `more:` that would run a mutation again.
    const budget = spec.pages ? BODY_BUDGET : Number.POSITIVE_INFINITY
    const opts = { budget, cursor: inv.cursor, moreCommand: moreCommandFor(argv) }
    const next = result.nextFor?.(fitBody(result.body, opts)) ?? result.next
    return { exitCode: result.exitCode ?? 0, stdout: `${renderAgent({ ...result, next }, opts)}\n`, stderr: '' }
  } catch (err) {
    const { output, exitCode } = failureOutput(err)
    const text = renderAgent(output, { budget: BODY_BUDGET, cursor: 0, moreCommand: () => '' })
    return { exitCode, stdout: '', stderr: `${text}\n` }
  }
}
