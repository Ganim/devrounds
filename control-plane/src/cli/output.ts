import type { GateView } from '../gates/service.ts'
import { isBlockerOpen, type TaskState } from '../planning/rules.ts'
import type { CriterionView, PhaseView, PlanView, TaskView } from '../planning/view.ts'
import type { ImprovementReport } from '../runs/improvement.ts'

// Agent output mode (AGENTS.md): failures first, then the body cut to a byte budget on a whole line, then the
// command to continue reading, and `next:` always last. Agents read the head and the tail of a long output, so
// both ends carry what they act on.

export type AgentOutput = { failures: string[]; body: string[]; next: string }

export type RenderOptions = { budget: number; cursor: number; moreCommand: (cursor: number) => string }

export const BODY_BUDGET = 16384

const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

// Titles, reasons, error text and keys come from the server (written by any member of the tenant). A raw newline
// in them could forge a `next:` or `DRxxx` line that an agent then acts on, and an ESC sequence could rewrite the
// terminal, so every C0/C1 control, DEL and the Unicode line/paragraph separators print as a visible escape. One
// entry therefore stays exactly one output line, which is also what --cursor counts.
export function oneLine(text: string): string {
  let out = ''
  for (const ch of text.replaceAll('\r\n', '\n')) {
    const cp = ch.codePointAt(0) ?? 0
    const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029
    out += !control ? ch : (ESCAPES[ch] ?? `\\u{${cp.toString(16)}}`)
  }
  return out
}

// Template tag for every line built from server fields: a field the server left out prints as "-", never as the
// word "undefined" (or "null"). Already-formatted strings pass through untouched.
export function fmt(parts: TemplateStringsArray, ...values: unknown[]): string {
  return parts.reduce((out, part, i) => out + part + (i < values.length ? String(values[i] ?? '-') : ''), '')
}

// Index one past the last body line that fits the budget from `cursor`. The first line always fits, even past the
// budget, so paging with --cursor always moves forward.
export function fitBody(body: string[], opts: { budget: number; cursor: number }): number {
  let used = 0
  let index = opts.cursor
  for (; index < body.length; index++) {
    const size = Buffer.byteLength(oneLine(body[index])) + 1
    if (used + size > opts.budget && index > opts.cursor) break
    used += size
  }
  return index
}

export function renderAgent(out: AgentOutput, opts: RenderOptions): string {
  const end = fitBody(out.body, opts)
  const lines = [...out.failures, ...out.body.slice(opts.cursor, end)].map(oneLine)
  if (end < out.body.length) lines.push(`truncated; more: ${oneLine(opts.moreCommand(end))}`)
  lines.push(`next: ${oneLine(out.next)}`)
  return lines.join('\n')
}

// Keys and paths go into `next:` and `more:` commands an agent may run as is. Plain keys print bare; anything else
// is single-quoted for a POSIX shell, so a key like `x; rm -rf ~` stays one argument.
export function shellArg(value: string): string {
  return /^[A-Za-z0-9._\-/:=@]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

const BAR_CELLS = 6

function bar(percent: number): string {
  const filled = Math.round((percent * BAR_CELLS) / 100)
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}`
}

function phaseLine(phase: PhaseView): string {
  const p = phase.progress
  const counts = `done ${p.done} · doing ${p.inProgress} · todo ${p.todo} · blocked ${p.blocked} · cancelled ${p.cancelled}`
  const blockedBy = phase.blockedBy.length > 0 ? `  blocked by: ${phase.blockedBy.join(', ')}` : ''
  const delivered = phase.state === 'delivered' ? '  delivered' : ''
  return `${phase.key} ${phase.title}  ${bar(p.percent)} ${p.percent}%  ${counts}${blockedBy}${delivered}`
}

function criterionLine(c: CriterionView): string {
  return `[${c.checked ? 'x' : ' '}] ${c.position} ${c.text}`
}

const allChecked = (task: TaskView) => task.criteria.every((c) => c.checked)

export function planShow(plan: PlanView, opts: { phase?: string }): { body: string[]; next: string } {
  const body = [`${plan.project.key} ${plan.project.name}`, ...plan.phases.map(phaseLine)]
  const current = opts.phase
    ? plan.phases.find((p) => p.key === opts.phase)
    : plan.phases.find((p) => p.state !== 'delivered')
  if (!current) {
    body.push(plan.phases.length === 0 ? 'no phases yet' : 'every phase is delivered')
    return { body, next: 'devrounds phase add <key> --title <title> --goal <goal>' }
  }

  const taskStates = new Map<string, TaskState>()
  for (const task of [...plan.phases.flatMap((p) => p.tasks), ...plan.unphased]) taskStates.set(task.key, task.state)
  const phaseStates = new Map(plan.phases.map((p) => [p.key, p.state]))
  const openPhaseBlockers = current.blockedBy.filter((key) => phaseStates.get(key) !== 'delivered')
  // An unknown blocker key cannot happen (same project), but counting it as open is the safe reading.
  const openBlockers = (task: TaskView) => task.blockedBy.filter((key) => isBlockerOpen(taskStates.get(key) ?? 'todo'))
  const startable = (task: TaskView) =>
    task.state === 'todo' && openBlockers(task).length === 0 && openPhaseBlockers.length === 0

  body.push('', `${current.key} ${current.title}${current.goal ? `: ${current.goal}` : ''}`)
  if (openPhaseBlockers.length > 0) body.push(`waiting for phases: ${openPhaseBlockers.join(', ')}`)
  for (const task of current.tasks) {
    const blockers = openBlockers(task)
    const assignee = task.assignee ? `  @${task.assignee}` : ''
    body.push(
      `  ${task.key} ${task.state}  ${task.title}${assignee}${blockers.length > 0 ? `  blocked by: ${blockers.join(', ')}` : ''}`,
    )
    if (task.state === 'done' || task.state === 'cancelled') continue
    for (const c of task.criteria.filter((c) => !c.checked)) body.push(`    ${criterionLine(c)}`)
  }
  const openPhaseCriteria = current.criteria.filter((c) => !c.checked)
  if (openPhaseCriteria.length > 0) {
    body.push(`  ${current.key} criteria:`)
    for (const c of openPhaseCriteria) body.push(`    ${criterionLine(c)}`)
  }

  const openUnphased = plan.unphased.filter((t) => t.state !== 'done' && t.state !== 'cancelled')
  if (openUnphased.length > 0) {
    body.push('unphased:')
    for (const task of openUnphased) {
      body.push(`  ${task.key} ${task.state}  ${task.title}`)
      for (const c of task.criteria.filter((c) => !c.checked)) body.push(`    ${criterionLine(c)}`)
    }
  }

  const toStart = current.tasks.find(startable)
  if (toStart) return { body, next: `devrounds task start ${shellArg(toStart.key)}` }
  const toFinish = current.tasks.find((t) => t.state === 'in_progress' && allChecked(t))
  if (toFinish) return { body, next: `devrounds task done ${shellArg(toFinish.key)}` }
  // An in-progress task left here still has open criteria; a phase with every task closed waits only on its own.
  const checkNext = (key: string) => ({
    body,
    next: `devrounds criterion check ${shellArg(key)} --evidence <evidence>`,
  })
  const doing = current.tasks.find((t) => t.state === 'in_progress')
  if (doing) return checkNext(doing.key)
  if (openPhaseCriteria.length > 0 && !current.tasks.some((t) => isBlockerOpen(t.state))) return checkNext(current.key)
  const blocked = current.tasks.filter((t) => t.state === 'blocked' || (t.state === 'todo' && !startable(t))).length
  return { body, next: `nothing startable: ${blocked} blocked — devrounds plan show --phase ${shellArg(current.key)}` }
}

// GET /gates/:id (gates/service.ts GateView) as JSON: its dates arrive as ISO strings.
export type GateJson = Omit<GateView, 'createdAt' | 'finishedAt'> & { createdAt: string; finishedAt: string | null }

const seconds = (ms: number | null) => (ms === null ? null : `${(ms / 1000).toFixed(1)} s`)

// A check that did not end well, in the order it is printed: failed, then stopped, then skipped (a skip's cause is
// printed above it).
const BAD_CHECK_STATES = ['failed', 'stopped', 'skipped']
const isBadCheck = (check: GateJson['checks'][number]) => BAD_CHECK_STATES.includes(check.state)

function gateCheckLine(check: GateJson['checks'][number]): string {
  if (check.cachedFrom !== null) return fmt`${check.ref} cached from ${check.cachedFrom}`
  if (check.runState === 'finished') return fmt`${check.ref} finished ${seconds(check.durationMs)}`
  return fmt`${check.ref} ${check.runState}`
}

/**
 * Failed, stopped and skipped checks first (state, class, duration, summary, log command), then the others. A skipped
 * check never started, so it has no log line and `next` reads the first failed or stopped check's log instead.
 */
export function gateShow(g: GateJson): { failures: string[]; body: string[]; next: string } {
  // Stable sort: the server's ref order holds within each state.
  const bad = g.checks
    .filter(isBadCheck)
    .sort((x, y) => BAD_CHECK_STATES.indexOf(x.state) - BAD_CHECK_STATES.indexOf(y.state))
  const failures = bad.flatMap((c) => [
    fmt`${c.ref} ${c.runState} ${c.failureClass} ${seconds(c.durationMs)} ${c.failureSummary}`,
    ...(c.state === 'skipped' ? [] : [`  log: devrounds run logs ${shellArg(c.runId)}`]),
  ])
  const logged = bad.find((c) => c.state !== 'skipped')
  const wall = seconds(g.wallMs)
  const body = [
    fmt`gate ${g.id} ${g.state} · ${g.key}${wall === null ? '' : ` · ${wall}`}`,
    ...g.checks.filter((c) => !bad.includes(c)).map(gateCheckLine),
  ]
  const next =
    logged !== undefined
      ? `devrounds run logs ${shellArg(logged.runId)}`
      : g.state === 'running'
        ? `devrounds gate show ${shellArg(g.id)} --wait`
        : 'devrounds plan show'
  return { failures, body, next }
}

const share = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)} %`)

/**
 * GET /reports/improvement: each finding is a failure (title, source key, evidence); the body is the day, the slowest
 * steps and the retries of the day.
 */
export function improvementShow(r: ImprovementReport): { failures: string[]; body: string[] } {
  return {
    failures: r.findings.map((f) => fmt`${f.title} (${f.sourceKey}): ${f.evidence}`),
    body: [
      fmt`improvement ${r.day} (${r.timeZone}) · findings ${r.findings.length} · ` +
        `unclassified share ${share(r.unclassifiedShare)}`,
      ...r.slowestSteps.map((s) => fmt`slow step ${s.jobType} ${s.step} p50 ${seconds(s.p50Ms)} over ${s.runs} runs`),
      ...r.retries.map(
        (x) => fmt`retries ${x.jobType} ${x.retries}, daily mean before ${x.baselineDailyMean.toFixed(1)}`,
      ),
    ],
  }
}
