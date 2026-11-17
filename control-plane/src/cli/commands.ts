import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import { exitCodeFor } from '../errors/codes.ts'
import { DevRoundsError, explain, fail } from '../errors/error.ts'
import { restrictToOwner } from '../owner-only.ts'
import type { ImportResult } from '../planning/import.ts'
import type { EventView, PlanView } from '../planning/view.ts'
import { type AgentOutput, BODY_BUDGET, planShow, renderAgent } from './output.ts'

// `devrounds`: the agent CLI. It talks only to the control plane's HTTP API (imports here are types and pure
// modules, never the DB layer), and prints every result in agent output mode (see output.ts).

export type CliConfig = { url: string; token: string; project: string }

export function defaultConfigPath(): string {
  return join(homedir(), '.devrounds', 'config.json')
}

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
      fail('DR101', { path, reason: 'is not valid JSON; run devrounds login again' })
    }
  }
  const pick = (field: keyof CliConfig): string => {
    const value = fromEnv[field] || file[field]
    if (typeof value !== 'string' || value === '') {
      fail('DR101', { path: field, reason: `is not set; run devrounds login or set ${ENV[field]}` })
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

  constructor(code: string, text: string, hint: string) {
    super(`${code} ${text}`)
    this.code = code
    this.text = text
    this.hint = hint
  }
}

class Unreachable extends Error {
  constructor(url: string, reason: string) {
    super(`control plane unreachable at ${url}: ${reason}`)
  }
}

const TIMEOUT_MS = 30_000

type Api = {
  get<T>(path: string, query?: Record<string, string | undefined>): Promise<T>
  getText(path: string): Promise<string>
  // Every mutation sends a random Idempotency-Key, one per invocation: running the command again is a new request.
  send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, contentType?: string): Promise<T>
}

function apiFor(config: CliConfig): Api {
  const base = `${config.url}/api/projects/${encodeURIComponent(config.project)}`
  const call = async (path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> => {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${config.token}`, ...init.headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } }
      throw new Unreachable(config.url, e.cause?.code ?? e.cause?.message ?? e.message)
    }
    if (res.ok) return res
    const text = await res.text()
    let body: { code?: unknown; text?: unknown; hint?: unknown } = {}
    try {
      body = JSON.parse(text)
    } catch {
      // Not the control plane answering (a proxy, another service on the port): handled below.
    }
    if (typeof body.code === 'string') throw new ApiError(body.code, String(body.text), String(body.hint))
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
  }
}

type Values = Record<string, string | boolean | string[] | undefined>
type Invocation = { args: string[]; values: Values; cursor: number }
type Deps = { env: NodeJS.ProcessEnv; configPath: string }
type Result = AgentOutput & { more?: (cursor: number) => string; raw?: string }

type Spec = {
  path: string[]
  usage: string
  args: number // most positionals accepted; missing ones are checked when the command runs
  options: ParseArgsOptionsConfig
  // Login runs without a saved config; everything else gets an API client.
  run: (inv: Invocation, connect: () => Promise<Api>, deps: Deps) => Promise<Result>
}

const str = { type: 'string' } as const
const many = { type: 'string', multiple: true } as const
const cursorOption = { cursor: str }

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
      return done(`${key} ${to}`, result, next?.(key))
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
      const plan = await apiFor(config).get<PlanView>('/plan')
      await mkdir(dirname(deps.configPath), { recursive: true, mode: 0o700 })
      await writeFile(deps.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
      await restrictToOwner(deps.configPath)
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
    options: { phase: str, ...cursorOption },
    run: async (inv, connect) => {
      const api = await connect()
      const plan = await api.get<PlanView>('/plan')
      const phase = text(inv, 'phase')
      if (phase !== undefined && !plan.phases.some((p) => p.key === phase)) fail('DR201', { kind: 'phase', key: phase })
      const shown = planShow(plan, { phase })
      const phaseFlag = phase === undefined ? '' : ` --phase ${phase}`
      return { failures: [], ...shown, more: (n) => `devrounds plan show${phaseFlag} --cursor ${n}` }
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
      return { failures: [], body: [`wrote ${out}`], next: `devrounds plan import ${out}` }
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
      const keys = (label: string, items: string[]) => (items.length > 0 ? [`${label}: ${items.join(', ')}`] : [])
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
      return done(`added task ${key}`, result, `devrounds task start ${key}`)
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
    options: { after: str, ...cursorOption },
    run: async (inv, connect) => {
      const api = await connect()
      const after = text(inv, 'after')
      const events = await api.get<EventView[]>('/events', { afterId: after })
      const body = events.map((e) => {
        const subject = e.taskKey ?? e.phaseKey ?? ''
        const reason = e.reason ? `  reason: ${e.reason}` : ''
        return `${e.id} ${e.at} ${e.actor} ${e.kind} ${subject}${reason}`.replace(/ +$/, '')
      })
      const last = events.at(-1)?.id ?? after
      const afterFlag = after === undefined ? '' : ` --after ${after}`
      return {
        failures: [],
        body: body.length > 0 ? body : ['no events'],
        next: last === undefined ? 'devrounds events' : `devrounds events --after ${last}`,
        more: (n) => `devrounds events${afterFlag} --cursor ${n}`,
      }
    },
  },
  {
    path: ['balance'],
    usage: 'balance [--week] [--cursor <n>]   per day (default) or per week, in the tenant time zone',
    args: 0,
    options: { week: { type: 'boolean' }, ...cursorOption },
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
      return {
        failures: [],
        body,
        next: 'devrounds plan show',
        more: (n) => `devrounds balance${week ? ' --week' : ''} --cursor ${n}`,
      }
    },
  },
]

export function usage(): string {
  const lines = COMMANDS.map((c) => `  devrounds ${c.usage}`)
  return [
    'usage: devrounds <command> [options]',
    '',
    ...lines,
    '',
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
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv.slice(spec.path.length),
      options: spec.options,
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

const UNREACHABLE_NEXT = 'start the control plane (node control-plane/src/main.ts serve)'

function failureOutput(err: unknown): { output: AgentOutput; exitCode: number } {
  if (err instanceof Unreachable) {
    return { output: { failures: [err.message], body: [], next: UNREACHABLE_NEXT }, exitCode: 4 }
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
  const next =
    exitCode === 5
      ? 'devrounds login --url <url> --token <token> --project <key>'
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
    return argv.length === 0
      ? { exitCode: 2, stdout: '', stderr: `${usage()}\n` }
      : { exitCode: 0, stdout: `${usage()}\n`, stderr: '' }
  }
  try {
    const { spec, inv } = parseCommand(argv)
    let connected: Promise<Api> | undefined
    const connect = () => {
      connected ??= loadCliConfig(deps.env, deps.configPath).then(apiFor)
      return connected
    }
    const result = await spec.run(inv, connect, deps)
    if (result.raw !== undefined) return { exitCode: 0, stdout: result.raw, stderr: '' }
    const more = result.more ?? (() => 'devrounds plan show')
    const text = renderAgent(result, { budget: BODY_BUDGET, cursor: inv.cursor, moreCommand: more })
    return { exitCode: 0, stdout: `${text}\n`, stderr: '' }
  } catch (err) {
    const { output, exitCode } = failureOutput(err)
    const text = renderAgent(output, { budget: BODY_BUDGET, cursor: 0, moreCommand: () => '' })
    return { exitCode, stdout: '', stderr: `${text}\n` }
  }
}
