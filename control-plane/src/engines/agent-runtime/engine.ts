import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { UsageSource } from '../../db/schema.ts'
import type { Trx } from '../../planning/resolve.ts'
import type { Classification } from '../../runs/classify.ts'
import { type SegmentInput, segmentLines } from '../../runs/log-store.ts'
import { findAgentRuntime } from '../registry.ts'
import { usdPerRun } from './budgets.ts'
import type { AgentCommand, AgentDef, AgentEvent, Tokens } from './contract.ts'
import { renderPrompt } from './prompt.ts'

// The agent-runtime engine's three moments in a run's life (P4 design §2.C 17-22): the command at dispatch, the
// events as the output ships, and the outcome, usage and cost at RunFinished. Everything here reads AgentEvents, never
// a runtime's own format, so a second provider changes none of it.

/** run_results.data's bound (0032), which a text or json answer is cut to fit. */
export const RESULT_DATA_MAX = 65536

/** What dispatch reads of an agent run (runs/dispatch.ts offerRows). */
export type AgentOfferRow = {
  id: string
  project_id: string
  job_type_id: string
  created_by: string
  agent: unknown
  job_args: unknown
  input: unknown
  agent_session_id: string | null
  resumed_from_run_id: string | null
}

/**
 * The provider's command for one agent run: the prompt rendered from the job, the session (the resumed run's, or a
 * new id stored on the run so a re-sent Offer carries the same one) and the lowest per-run budget. Null for a run of a
 * plain command job type.
 */
export async function agentCommand(trx: Trx, row: AgentOfferRow): Promise<AgentCommand | null> {
  const agent = row.agent as AgentDef | null
  if (agent === null) return null
  const provider = findAgentRuntime(agent.runtime)
  // Checked when the job type was put; a provider removed since then leaves the run to fail as a plain command.
  if (!provider) return null
  const values = { args: row.job_args as string[], input: row.input as Record<string, string> }
  const resumed =
    row.resumed_from_run_id === null
      ? undefined
      : await trx
          .selectFrom('runs')
          .select('agent_session_id')
          .where('id', '=', row.resumed_from_run_id)
          .executeTakeFirst()
  const resume = resumed?.agent_session_id != null
  const sessionId = resume ? (resumed?.agent_session_id as string) : (row.agent_session_id ?? randomUUID())
  if (sessionId !== row.agent_session_id) {
    await trx.updateTable('runs').set({ agent_session_id: sessionId }).where('id', '=', row.id).execute()
  }
  const cap = await usdPerRun(trx, row.project_id, row.job_type_id, row.created_by)
  const caps = [agent.max_budget_usd, cap].filter((value) => value !== undefined)
  const command = provider.command({
    prompt: renderPrompt(agent.prompt, values),
    session: { id: sessionId, resume },
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.permission_mode === undefined ? {} : { permissionMode: agent.permission_mode }),
    ...(caps.length === 0 ? {} : { maxBudgetUsd: Math.min(...caps) }),
    ...(agent.system_prompt_append === undefined
      ? {}
      : { systemPromptAppend: renderPrompt(agent.system_prompt_append, values) }),
    ...(agent.result.schema === undefined ? {} : { resultSchema: agent.result.schema }),
  })
  const project = await trx
    .selectFrom('projects')
    .select('key')
    .where('id', '=', row.project_id)
    .executeTakeFirstOrThrow()
  // The agent's own `devrounds` calls (run result) find their project and run without flags.
  return { args: command.args, env: { ...command.env, DEVROUNDS_PROJECT: project.key } }
}

// What agent_events.data keeps of each event: never a tool's input or output, never message text (contract.ts).
function eventData(event: AgentEvent, keepText: boolean): Record<string, unknown> {
  const { kind: _kind, ...data } = event
  if (event.kind !== 'result') return data
  return {
    ...data,
    text: keepText && event.text !== null ? fitText(event.text, RESULT_DATA_MAX - 1024) : null,
    structured: keepText && jsonBytes(event.structured ?? null) <= RESULT_DATA_MAX - 1024 ? event.structured : null,
  }
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null')

// `text` cut until it serializes within `max` bytes: escapes can make JSON several times longer than the text.
function fitText(text: string, max: number): string {
  let fitted = text
  while (jsonBytes(fitted) > max) fitted = fitted.slice(0, Math.floor(fitted.length * (max / jsonBytes(fitted)) * 0.9))
  return fitted
}

/**
 * Reads one shipped segment of run `runId` into agent_events, after storeSegment stored it, in the event's
 * transaction. A tool result gets its call's name and duration, from this segment or an earlier one. A resent segment
 * adds nothing (the line keys are unique). A run of a plain command job type is skipped.
 */
export async function ingestAgentSegment(trx: Trx, tenantId: string, runId: string, segment: SegmentInput) {
  const row = await trx
    .selectFrom('runs')
    .innerJoin('job_types', 'job_types.id', 'runs.job_type_id')
    .select('job_types.agent')
    .where('runs.id', '=', runId)
    .executeTakeFirst()
  const agent = (row?.agent ?? null) as AgentDef | null
  const provider = agent === null ? undefined : findAgentRuntime(agent.runtime)
  if (!agent || !provider) return
  const calls = new Map<string, { name: string; at: number }>()
  const values = []
  let lines: Awaited<ReturnType<typeof segmentLines>>
  try {
    lines = await segmentLines(segment.zstd_base64)
  } catch {
    // Stored all the same: reading it is the log reader's DR503. Throwing here would refuse the event for good.
    return
  }
  for (const line of lines) {
    const events = provider.parseLine(line.text)
    for (const [position, event] of events.entries()) {
      let data = eventData(event, agent.result.kind !== 'reported')
      if (event.kind === 'tool_call') calls.set(event.call, { name: event.name, at: line.timestampMs })
      if (event.kind === 'tool_result') {
        const call = calls.get(event.call) ?? (await earlierCall(trx, runId, event.call))
        data = { ...data, name: call?.name ?? null, duration_ms: call ? Math.max(0, line.timestampMs - call.at) : null }
      }
      values.push({
        tenant_id: tenantId,
        run_id: runId,
        line_seq: line.seq,
        position,
        at: new Date(line.timestampMs),
        kind: event.kind,
        data: JSON.stringify(data),
      })
    }
  }
  if (values.length === 0) return
  await trx
    .insertInto('agent_events')
    .values(values)
    .onConflict((oc) => oc.columns(['run_id', 'line_seq', 'position']).doNothing())
    .execute()
}

async function earlierCall(trx: Trx, runId: string, call: string) {
  const row = await trx
    .selectFrom('agent_events')
    .select(['at', sql<string>`data->>'name'`.as('name')])
    .where('run_id', '=', runId)
    .where('kind', '=', 'tool_call')
    .where(sql<string>`data->>'call'`, '=', call)
    .executeTakeFirst()
  return row ? { name: row.name, at: row.at.getTime() } : undefined
}

type StoredEvent = { kind: AgentEvent['kind']; data: Record<string, unknown> }
type ResultEvent = Extract<AgentEvent, { kind: 'result' }>

// The run's usage: the runtime's own total when its result has one, else each message's usage once (a message's
// usage repeats on every line of it), else nothing.
function usageOf(
  events: StoredEvent[],
  result: ResultEvent | undefined,
): { tokens: Tokens | null; source: UsageSource } {
  if (result?.usage) return { tokens: result.usage, source: 'result' }
  const byMessage = new Map<string, Tokens>()
  let unkeyed = 0
  for (const event of events) {
    if (event.kind !== 'usage') continue
    const { message, ...tokens } = event.data as { message: string | null } & Tokens
    byMessage.set(message ?? `unkeyed-${unkeyed++}`, tokens)
  }
  if (byMessage.size === 0) return { tokens: null, source: 'missing' }
  const sum: Tokens = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 }
  for (const tokens of byMessage.values()) {
    sum.tokensIn += tokens.tokensIn
    sum.tokensOut += tokens.tokensOut
    sum.cacheRead += tokens.cacheRead
    sum.cacheWrite += tokens.cacheWrite
  }
  return { tokens: sum, source: 'transcript' }
}

const failed = (failureClass: Classification['failureClass'], failureSummary: string): Classification => ({
  state: 'failed',
  failureClass,
  failureSummary,
})

/**
 * At RunFinished of an agent run, inside applyRunEvent's transaction, before the run's end is written: records usage,
 * cost and session from the run's agent_events and returns the classification the run ends with. Null for a plain
 * command job type, which keeps classifyRun's.
 *
 * - An end the executor caused (stopped, timeout, stalled, spawn failure, infra) keeps its class; stalled names the
 *   last thing the agent did.
 * - The runtime stopping at its own budget or turn limit: limit.
 * - reported: the run's run_results row decides, whatever the exit code; a `done` label finishes it, a `park` label
 *   fails it as parked, any other label fails it; no row is no_outcome.
 * - text and json: the runtime's final answer becomes the run's result (reported_by null); none, or json that does not
 *   parse, is no_outcome.
 */
export async function settleAgentRun(
  trx: Trx,
  tenantId: string,
  runId: string,
  reason: string,
  classified: Classification,
): Promise<Classification | null> {
  const run = await trx
    .selectFrom('runs')
    .innerJoin('job_types', 'job_types.id', 'runs.job_type_id')
    .select(['job_types.agent', 'runs.agent_session_id'])
    .where('runs.id', '=', runId)
    .executeTakeFirstOrThrow()
  const agent = run.agent as AgentDef | null
  if (agent === null) return null
  const events = (await trx
    .selectFrom('agent_events')
    .select(['kind', 'data'])
    .where('run_id', '=', runId)
    .orderBy('line_seq')
    .orderBy('position')
    .execute()) as StoredEvent[]
  const resultEvent = events.findLast((event) => event.kind === 'result')
  const result = resultEvent ? ({ kind: 'result', ...resultEvent.data } as ResultEvent) : undefined
  const usage = usageOf(events, result)
  await trx
    .updateTable('runs')
    .set({
      tokens_in: usage.tokens?.tokensIn ?? null,
      tokens_out: usage.tokens?.tokensOut ?? null,
      tokens_cache_read: usage.tokens?.cacheRead ?? null,
      tokens_cache_write: usage.tokens?.cacheWrite ?? null,
      cost_usd: result?.costUsd ?? null,
      usage_source: usage.source,
      agent_session_id: result?.sessionId ?? run.agent_session_id,
    })
    .where('id', '=', runId)
    .execute()

  if (reason !== 'exited') {
    const last = events.at(-1)
    if (classified.failureClass !== 'stalled' || last === undefined) return classified
    const what = typeof last.data.name === 'string' ? `${last.kind} ${last.data.name}` : last.kind
    return { ...classified, failureSummary: `${classified.failureSummary ?? ''}\nlast agent event: ${what}`.trim() }
  }
  if (result?.outcome === 'limit') return failed('limit', 'the agent runtime stopped at its budget or turn limit')
  if (agent.result.kind === 'reported') {
    const reported = await trx.selectFrom('run_results').select('label').where('run_id', '=', runId).executeTakeFirst()
    if (!reported) return failed('no_outcome', 'the agent ended without reporting a result (devrounds run result)')
    if (agent.result.done.includes(reported.label))
      return { state: 'finished', failureClass: null, failureSummary: null }
    if (agent.result.park.includes(reported.label)) return failed('unclassified', `parked: ${reported.label}`)
    return failed('unclassified', `reported ${reported.label}, which is not a done label`)
  }
  if (result?.outcome !== 'success' || (result.text === null && result.structured == null)) {
    return failed('no_outcome', 'the agent ended without a final answer')
  }
  let data: Record<string, unknown>
  if (agent.result.kind === 'text') data = { text: result.text }
  else if (result.structured != null) data = { value: result.structured }
  else {
    try {
      data = { value: JSON.parse(result.text as string) }
    } catch {
      return failed('no_outcome', 'the final answer is not JSON')
    }
  }
  await trx
    .insertInto('run_results')
    .values({ tenant_id: tenantId, run_id: runId, label: agent.result.kind, data: JSON.stringify(data) })
    .onConflict((oc) => oc.column('run_id').doNothing())
    .execute()
  return { state: 'finished', failureClass: null, failureSummary: null }
}

/**
 * What a retry of an agent job carries to resume the session its last run left: that run, and its machine, where the
 * session lives. Empty for a requeue (the run never started), a plain command job type, a run with no session or a job
 * that already resumed `resume.max` times.
 */
export async function resumeOf(
  trx: Trx,
  jobId: string,
  cause: 'retry' | 'requeue',
): Promise<{ resumed_from_run_id?: string; pinned_machine_id?: string }> {
  if (cause !== 'retry') return {}
  const last = await trx
    .selectFrom('runs')
    .innerJoin('job_types', 'job_types.id', 'runs.job_type_id')
    .select(['runs.id', 'runs.machine_id', 'runs.agent_session_id', 'job_types.agent'])
    .where('runs.job_id', '=', jobId)
    .orderBy('runs.attempt', 'desc')
    .limit(1)
    .executeTakeFirst()
  const agent = (last?.agent ?? null) as AgentDef | null
  if (!last || agent === null || last.agent_session_id === null || last.machine_id === null) return {}
  const { resumes } = await trx
    .selectFrom('runs')
    .select((eb) => eb.fn.countAll<string>().as('resumes'))
    .where('job_id', '=', jobId)
    .where('resumed_from_run_id', 'is not', null)
    .executeTakeFirstOrThrow()
  if (Number(resumes) >= agent.resume.max) return {}
  return { resumed_from_run_id: last.id, pinned_machine_id: last.machine_id }
}
