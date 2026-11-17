import { isBlockerOpen, type TaskState } from '../planning/rules.ts'
import type { CriterionView, PhaseView, PlanView, TaskView } from '../planning/view.ts'

// Agent output mode (AGENTS.md): failures first, then the body cut to a byte budget on a whole line, then the
// command to continue reading, and `next:` always last. Agents read the head and the tail of a long output, so
// both ends carry what they act on.

export type AgentOutput = { failures: string[]; body: string[]; next: string }

export type RenderOptions = { budget: number; cursor: number; moreCommand: (cursor: number) => string }

export const BODY_BUDGET = 16384

export function renderAgent(out: AgentOutput, opts: RenderOptions): string {
  // A title or reason may hold a newline; splitting keeps one body entry = one output line, which --cursor counts.
  const body = out.body.flatMap((line) => line.split('\n'))
  const lines = [...out.failures]
  let used = 0
  let index = opts.cursor
  for (; index < body.length; index++) {
    const size = Buffer.byteLength(body[index]) + 1
    // The first line always goes out, even past the budget, so paging with --cursor always moves forward.
    if (used + size > opts.budget && index > opts.cursor) break
    used += size
    lines.push(body[index])
  }
  if (index < body.length) lines.push(`truncated; more: ${opts.moreCommand(index)}`)
  lines.push(`next: ${out.next}`)
  return lines.join('\n')
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

  const toStart = current.tasks.find(startable)
  if (toStart) return { body, next: `devrounds task start ${toStart.key}` }
  const toFinish = current.tasks.find((t) => t.state === 'in_progress' && allChecked(t))
  if (toFinish) return { body, next: `devrounds task done ${toFinish.key}` }
  const blocked = current.tasks.filter((t) => t.state === 'blocked' || (t.state === 'todo' && !startable(t))).length
  return { body, next: `nothing startable: ${blocked} blocked — devrounds plan show --phase ${current.key}` }
}
