import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import { exitCodeFor } from '../errors/codes.ts'
import { DevRoundsError, explain, fail } from '../errors/error.ts'
import { parseJobTypeFile } from '../job-types/file.ts'
import { restrictToOwner } from '../owner-only.ts'
import type { ImportResult } from '../planning/import.ts'
import type { EventView, PlanView } from '../planning/view.ts'
import type { RunView } from '../runs/view.ts'
import { type AgentOutput, BODY_BUDGET, fitBody, planShow, renderAgent, shellArg } from './output.ts'

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
async function loadCliConfig(env: NodeJS.ProcessEnv, path: string): Promise<CliConfig> {
  const fromEnv = { url: env[ENV.url], token: env[ENV.token], project: env[ENV.project] }
  let file: Partial<CliConfig> = {}
  if (!fromEnv.url || !fromEnv.token || !fromEnv.project) {
    const text = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '{}'
      throw err
    })
    try {
      file = JSON.parse(text) as Partial<CliConfig>
    } catch {
      throw new LoginNeeded('DR101', { path, reason: 'is not valid JSON; run devrounds login again' })
    }
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

  constructor(message: string, next: string) {
    super(message)
    this.next = next
  }
}

const START_SERVER_NEXT = 'start the control plane (node control-plane/src/main.ts serve)'
export const DEFAULT_TIMEOUT_MS = 30_000

type Api = {
  get<T>(path: string, query?: Record<string, string | undefined>): Promise<T>
  getText(path: string): Promise<string>
  // Every mutation sends a random Idempotency-Key, one per invocation: running the command again is a new request.
  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, contentType?: string): Promise<T>
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
    if (typeof body.code === 'string')
      throw new ApiError(body.code, String(body.text), String(body.hint), body.data ?? {})
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
    async send(method, path, body, contentType = 'application/json') {
      const headers: Record<string, string> = { 'idempotency-key': randomUUID() }
      if (body !== undefined) headers['content-type'] = contentType
      const payload = body === undefined || typeof body === 'string' ? body : JSON.stringify(body)
      return (await call(path, { method, headers, body: payload })).json()
    },
    url: config.url,
    machines: () => apiFor(config, timeoutMs, '/machines'),
  }
}

type Values = Record<string, string | boolean | string[] | undefined>
type Invocation = { args: string[]; values: Values; cursor: number }
type Deps = { env: NodeJS.ProcessEnv; configPath: string; timeoutMs?: number }
// `nextFor` gets the index one past the last body line printed, for a next step that depends on what was shown.
type Result = AgentOutput & { nextFor?: (shownEnd: number) => string; raw?: string }

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

type Mutation = { eventId: string; delivered?: string | null }

function done(summary: string, result: Mutation, next = 'devrounds plan show'): Result {
  const body = [`${summary} (event ${result.eventId})`]
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

function taskTransition(verb: string, to: string, next?: (key: string) => string): Spec {
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
      return done(`${key} ${to}`, result, next?.(shellArg(key)))
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

const IMPORT_SAMPLE = 20

// A run as JSON: its dates arrive as ISO strings.
type RunJson = Omit<RunView, 'timeline' | 'steps' | 'delays'> & {
  timeline: Record<keyof RunView['timeline'], string | null>
  steps: { step: number; name: string; startedAt: string; finishedAt: string | null; outcome: string | null }[]
  delays: { at: string; reason: string; needBytes: number; availableBytes: number | null; position: number }[]
}

const TERMINAL_RUN = ['finished', 'failed', 'stopped', 'orphaned']
// Below the client's 30 s timeout, so a long wait is several requests that each answer in time.
const RUN_WAIT_S = 25

const mib = (bytes: number | null) => (bytes === null ? '-' : `${(bytes / 1048576).toFixed(1)} MiB`)
const ms = (value: number | null) => (value === null ? '-' : `${value} ms`)

// Failures first (state, class, summary), then timeline, durations, resources, steps and delays.
function runShow(r: RunJson): Result {
  const failed = r.state === 'failed' || r.state === 'stopped' || r.state === 'orphaned'
  const exit = r.outcome.exitCode === null ? '' : ` (exit ${r.outcome.exitCode})`
  const failures = failed
    ? [
        `run ${r.id} ${r.state}${r.outcome.failureClass ? `: ${r.outcome.failureClass}` : ''}${exit}`,
        ...(r.outcome.failureSummary ? [`summary: ${r.outcome.failureSummary}`] : []),
      ]
    : []
  const t = r.timeline
  const res = r.resources
  const body = [
    `run ${r.id} ${r.state}${failed ? '' : exit} · ${r.jobType} on ${r.machine} · attempt ${r.attempt}${r.task ? ` · task ${r.task}` : ''}`,
    `timeline: queued ${t.queuedAt} · offered ${t.offeredAt ?? '-'} · admitted ${t.admittedAt ?? '-'} · started ${t.startedAt ?? '-'} · finished ${t.finishedAt ?? '-'}`,
    `durations: queue wait ${ms(r.durations.queueWaitMs)} · admission delay ${ms(r.durations.admissionDelayMs)} · run ${ms(r.durations.runTimeMs)} · total ${ms(r.durations.totalMs)}`,
    `resources: peak ${mib(res.peak)} · p95 ${mib(res.p95)} · p50 ${mib(res.p50)} · cpu ${res.cpuSeconds ?? '-'} s · swept ${res.swept ?? '-'} · visible windows ${res.visibleWindows ?? '-'}`,
  ]
  if (r.steps.length > 0) {
    body.push('steps:')
    for (const s of r.steps)
      body.push(`  ${s.step} ${s.name} ${s.outcome ?? 'open'} · ${s.startedAt} → ${s.finishedAt ?? '-'}`)
  }
  if (r.delays.length > 0) {
    body.push('delays:')
    for (const d of r.delays) {
      body.push(
        `  ${d.at} ${d.reason} · position ${d.position} · need ${mib(d.needBytes)} · available ${mib(d.availableBytes)}`,
      )
    }
  }
  const id = shellArg(r.id)
  const next = failed
    ? `devrounds run show ${id}`
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
          `logged in to ${config.url}, project ${plan.project.key} (${plan.project.name})`,
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
          `unchanged: ${r.unchanged}`,
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
  taskTransition('start', 'in_progress', (key) => `devrounds task done ${key}`),
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
        return `${e.id} ${e.at} ${e.actor} ${e.kind} ${subject}${reason}`.replace(/ +$/, '')
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
          `${r.periodStart}  done ${r.done} · opened ${r.opened} · cancelled ${r.cancelled} · ` +
          `in progress ${r.hoursInProgress} h · avg cycle ${r.avgCycleHours === null ? '-' : `${r.avgCycleHours} h`}`,
      )
      return { failures: [], body, next: 'devrounds plan show' }
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
      const r = await api.machines().send<PairingCode>('POST', '/pairing-codes', { name })
      return {
        failures: [],
        body: [`pairing code for machine ${r.machineName}: ${r.code}`, `expires at ${r.expiresAt}`],
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
          `${m.name}  ${m.connected ? 'connected' : 'offline'} · ${m.os} · executor ${m.executorVersion} · ` +
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
        next: `devrounds run start ${shellArg(key)} --machine <name> --cwd <path>`,
      }
    },
  },
  {
    path: ['run', 'start'],
    usage: 'run start <jobType> --machine <name> --cwd <path> [--task <key>]',
    args: 1,
    options: { machine: str, cwd: str, task: str },
    run: async (inv, connect) => {
      const api = await connect()
      const jobType = arg(inv, 0, '<jobType>')
      const need = (name: string) => text(inv, name) ?? fail('DR101', { path: `--${name}`, reason: 'is required' })
      const body = { jobType, machine: need('machine'), cwd: need('cwd'), task: text(inv, 'task') }
      const r = await api.send<RunJson>('POST', '/runs', body)
      return {
        failures: [],
        body: [`run ${r.id} ${r.state} · ${r.jobType} on ${r.machine}`],
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
]

type PairingCode = { code: string; expiresAt: string; machineName: string }
type MachineView = { name: string; os: string; executorVersion: string; lastSeenAt: string | null; connected: boolean }

export function usage(): string {
  const lines = COMMANDS.map((c) => `  devrounds ${c.usage}`)
  return [
    'usage: devrounds <command> [options]',
    '',
    ...lines,
    '',
    'Reads (plan show, events, balance, machine list) take --cursor <n> to continue an output cut at 16384 bytes.',
    'Config: ~/.devrounds/config.json from `devrounds login`, or DEVROUNDS_URL, DEVROUNDS_TOKEN, DEVROUNDS_PROJECT.',
    'Exit codes: 0 ok, 1 state conflict, 2 input/usage, 3 not found, 4 control plane unreachable, 5 auth, 6 internal.',
  ].join('\n')
}

// Resolves the command (longest matching word path) and parses its flags strictly. Missing positionals and flag
// values are reported when the command runs, so `devrounds task start` alone parses (AGENTS.md quotes it so).
export function parseCommand(argv: string[]): { spec: Spec; inv: Invocation } {
  const spec = COMMANDS.filter((c) => c.path.every((word, i) => argv[i] === word)).sort(
    (a, b) => b.path.length - a.path.length,
  )[0]
  if (!spec) fail('DR101', { path: 'command', reason: `unknown command "${argv.join(' ')}"; see devrounds --help` })
  // --cursor on every read command, so `more:` is always the same command with --cursor N. Mutations reject it.
  const options: ParseArgsOptionsConfig = spec.pages ? { ...spec.options, cursor: str } : spec.options
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv.slice(spec.path.length),
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
  inv.cursor = integer(inv, 'cursor', 0) ?? 0
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
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    const text = `${usage()}\n`
    return argv.length === 0 ? { exitCode: 2, stdout: '', stderr: text } : { exitCode: 0, stdout: text, stderr: '' }
  }
  try {
    const { spec, inv } = parseCommand(argv)
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let connected: Promise<Api> | undefined
    const connect = () => {
      connected ??= loadCliConfig(deps.env, deps.configPath).then((config) => apiFor(config, timeoutMs))
      return connected
    }
    const result = await spec.run(inv, connect, deps)
    if (result.raw !== undefined) return { exitCode: 0, stdout: result.raw, stderr: '' }
    // Other commands print bounded bodies (a summary line, or import's capped samples), so they are never cut and
    // never offer a `more:` that would run a mutation again.
    const budget = spec.pages ? BODY_BUDGET : Number.POSITIVE_INFINITY
    const opts = { budget, cursor: inv.cursor, moreCommand: moreCommandFor(argv) }
    const next = result.nextFor?.(fitBody(result.body, opts)) ?? result.next
    return { exitCode: 0, stdout: `${renderAgent({ ...result, next }, opts)}\n`, stderr: '' }
  } catch (err) {
    const { output, exitCode } = failureOutput(err)
    const text = renderAgent(output, { budget: BODY_BUDGET, cursor: 0, moreCommand: () => '' })
    return { exitCode, stdout: '', stderr: `${text}\n` }
  }
}
