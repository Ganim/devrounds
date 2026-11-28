import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { sql } from 'kysely'
import type { FlowNodeKind, FlowRunState, RunState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { findJobType } from '../job-types/service.ts'
import { type Ctx, findProject, findTask, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { isUuid } from '../runs/view.ts'
import { validate } from '../validate.ts'
import { type AskSchema, askType, type FlowDocument, findFlowIssue, flowSha, inputNames } from './document.ts'
import { edge, endFlowRun, flowEvent, lockFlowRun, proceed } from './engine.ts'

const Key = Type.String({ minLength: 1, maxLength: 200 })

/** The body of `POST /flows/:flow/runs`. `sourceKey` defaults to the task's own (a finding's, e.g. `linear:FLOWS-1`). */
export const FlowRunInput = Type.Object(
  {
    task: Key,
    input: Type.Optional(
      Type.Record(Type.String({ pattern: '^[A-Za-z0-9_]{1,64}$' }), Type.String({ maxLength: 4096 }), {
        additionalProperties: false,
        maxProperties: 50,
      }),
    ),
    sourceKey: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
)

export type FlowRunInput = Static<typeof FlowRunInput>

export type FlowView = {
  key: string
  version: number
  sha: string
  // False when the document equals the latest version's, which `flow set` then returns instead of a new version.
  created: boolean
  createdAt: Date
  document: FlowDocument
}

export type FlowSummary = { key: string; version: number; sha: string; createdAt: Date; running: number }

export type FlowNodeRunView = {
  node: string
  kind: FlowNodeKind
  visit: number
  // Null while the node waits.
  outcome: string | null
  data: Record<string, unknown>
  // A job node's job and its latest run.
  job: string | null
  run: { id: string; state: RunState } | null
  wakeAt: Date | null
  startedAt: Date
  endedAt: Date | null
}

export type FlowRunView = {
  id: string
  flow: string
  version: number
  task: string
  sourceKey: string | null
  state: FlowRunState
  reason: string | null
  input: Record<string, string>
  startedAt: Date
  endedAt: Date | null
  // Oldest first; the open one (if any) is last.
  nodes: FlowNodeRunView[]
  // Visits per node, for the graph.
  visits: Record<string, number>
}

export type FlowRunSummary = Omit<FlowRunView, 'nodes' | 'visits' | 'input'> & { node: string | null }

async function latestFlow(trx: Trx, projectId: string, key: string) {
  return trx
    .selectFrom('flows')
    .select(['id', 'key', 'version', 'document', 'document_sha', 'created_at'])
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst()
}

type FlowRow = NonNullable<Awaited<ReturnType<typeof latestFlow>>>

const flowView = (row: FlowRow, created: boolean): FlowView => ({
  key: row.key,
  version: row.version,
  sha: row.document_sha,
  created,
  createdAt: row.created_at,
  document: row.document as FlowDocument,
})

/**
 * Stores `document` as the next version of its flow, or returns the latest version when the document is the same
 * (by sha, so key order does not matter). Puts of one flow are serialized by an advisory lock, so two at once make
 * one version; the unique (project, key, version) is the guarantee behind it.
 */
export async function putFlow(ctx: Ctx, projectKey: string, document: unknown): Promise<FlowView> {
  const issue = findFlowIssue(document)
  if (issue) fail('DR101', issue)
  const doc = document as FlowDocument
  const sha = flowSha(doc)
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    await sql`select pg_advisory_xact_lock(hashtextextended(${`devrounds.flow:${project.id}:${doc.key}`}, 0))`.execute(
      trx,
    )
    const latest = await latestFlow(trx, project.id, doc.key)
    if (latest?.document_sha === sha) return flowView(latest, false)
    const row = await trx
      .insertInto('flows')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        key: doc.key,
        version: (latest?.version ?? 0) + 1,
        document: JSON.stringify(doc),
        document_sha: sha,
        created_by: ctx.actor.id,
      })
      .returning(['id', 'key', 'version', 'document', 'document_sha', 'created_at'])
      .executeTakeFirstOrThrow()
    return flowView(row, true)
  })
}

/** Version `version` of flow `key` (the latest when omitted); DR201 when there is none. */
export function getFlow(ctx: TenantCtx, projectKey: string, key: string, version?: number): Promise<FlowView> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const row =
      version === undefined
        ? await latestFlow(trx, project.id, key)
        : await trx
            .selectFrom('flows')
            .select(['id', 'key', 'version', 'document', 'document_sha', 'created_at'])
            .where('project_id', '=', project.id)
            .where('key', '=', key)
            .where('version', '=', version)
            .executeTakeFirst()
    if (!row) fail('DR201', { kind: 'flow', key: version === undefined ? key : `${key}@${version}` })
    return flowView(row, false)
  })
}

/** The latest version of every flow of the project, by key, with its running runs. */
export function listFlows(ctx: TenantCtx, projectKey: string): Promise<FlowSummary[]> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const rows = await trx
      .selectFrom('flows as f')
      .select(['f.key', 'f.version', 'f.document_sha', 'f.created_at'])
      .select((eb) =>
        eb
          .selectFrom('flow_runs as r')
          .select((e) => e.fn.countAll<string>().as('n'))
          .whereRef('r.project_id', '=', 'f.project_id')
          .whereRef('r.flow_key', '=', 'f.key')
          .where('r.state', '=', 'running')
          .as('running'),
      )
      .where('f.project_id', '=', project.id)
      .where(({ eb, selectFrom }) =>
        eb(
          'f.version',
          '=',
          selectFrom('flows as l')
            .select(({ fn }) => fn.max('l.version').as('v'))
            .whereRef('l.project_id', '=', 'f.project_id')
            .whereRef('l.key', '=', 'f.key'),
        ),
      )
      .orderBy('f.key')
      .execute()
    return rows.map((r) => ({
      key: r.key,
      version: r.version,
      sha: r.document_sha,
      createdAt: r.created_at,
      running: Number(r.running ?? 0),
    }))
  })
}

// DR314 while a run of `flowKey` with `sourceKey` is running. Every path that makes such a run running (a start, a
// resume) takes this lock before reading the holder, so two at once see each other; flow_runs_live_source (0029) is
// the guarantee behind it. A run without a source key is never refused.
async function requireFreeSource(trx: Trx, projectId: string, flowKey: string, sourceKey: string | null) {
  if (sourceKey === null) return
  await sql`select pg_advisory_xact_lock(hashtextextended(${`devrounds.flow-run:${projectId}:${flowKey}:${sourceKey}`}, 0))`.execute(
    trx,
  )
  const holder = await trx
    .selectFrom('flow_runs')
    .select('id')
    .where('project_id', '=', projectId)
    .where('flow_key', '=', flowKey)
    .where('source_key', '=', sourceKey)
    .where('state', '=', 'running')
    .executeTakeFirst()
  if (holder) fail('DR314', { flow: flowKey, source: sourceKey, run: holder.id })
}

/**
 * Starts the latest version of flow `flowKey` for task `i.task` and moves it until its first wait. Every input name
 * the document's templates use must be set (DR101), and every job type it runs must exist (DR201), so a typo fails
 * here rather than parking the run later. One run per (flow, source key) is running at a time: a start while another
 * runs answers DR314 naming it. Starts of one key are serialized by an advisory lock taken before the holder is read;
 * flow_runs_live_source (0029) is the guarantee behind it. The start is a plan event of the task.
 */
export async function startFlowRun(
  ctx: Ctx,
  projectKey: string,
  flowKey: string,
  i: FlowRunInput,
): Promise<FlowRunView> {
  validate(FlowRunInput, i)
  const input = i.input ?? {}
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const flow = (await latestFlow(trx, project.id, flowKey)) ?? fail('DR201', { kind: 'flow', key: flowKey })
    const doc = flow.document as FlowDocument
    for (const [name, path] of inputNames(doc)) {
      if (!(name in input)) fail('DR101', { path: `/input/${name}`, reason: `is required by ${path}` })
    }
    for (const node of Object.values(doc.nodes)) {
      if (node.kind === 'job') await findJobType(trx, project.id, node.job_type)
    }
    const task = await findTask(trx, project.id, i.task)
    const sourceKey = i.sourceKey ?? task.source_key
    await requireFreeSource(trx, project.id, flowKey, sourceKey)
    const { id } = await trx
      .insertInto('flow_runs')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        flow_id: flow.id,
        flow_key: flowKey,
        task_id: task.id,
        source_key: sourceKey,
        input: JSON.stringify(input),
        created_by: ctx.actor.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const fr = (await lockFlowRun(trx, id)) as NonNullable<Awaited<ReturnType<typeof lockFlowRun>>>
    await flowEvent(trx, fr, ctx.actor.id, 'flow_run_start', {
      flow: flowKey,
      version: flow.version,
      run: id,
      source_key: sourceKey,
    })
    await proceed(trx, fr, doc.start, { outcome: null, data: {} })
    return loadFlowRunView(trx, project.id, id)
  })
}

/**
 * Cancels running flow run `id`: its open node closes with outcome cancelled and the run ends cancelled, a plan event
 * of the task. Returns the view and the live run of the job the node waited on, which the caller stops after the
 * commit (the route, as `run stop` does); a run that is not stopped ends later and moves nothing. A run that already
 * ended is returned as it is.
 */
export async function cancelFlowRun(
  ctx: Ctx,
  projectKey: string,
  id: string,
): Promise<{ view: FlowRunView; liveRun: string | null }> {
  if (!isUuid(id)) fail('DR201', { kind: 'flow run', key: id })
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const fr = await lockFlowRun(trx, id)
    if (!fr || fr.project_id !== project.id) return fail('DR201', { kind: 'flow run', key: id })
    let liveRun: string | null = null
    if (fr.state === 'running') {
      const open = await trx
        .updateTable('flow_node_runs')
        .set({ outcome: 'cancelled', ended_at: sql<Date>`now()` })
        .where('flow_run_id', '=', id)
        .where('ended_at', 'is', null)
        .returning('job_id')
        .executeTakeFirst()
      if (open?.job_id) {
        const last = await trx
          .selectFrom('runs')
          .select(['id', 'state'])
          .where('job_id', '=', open.job_id)
          .orderBy('attempt', 'desc')
          .limit(1)
          .executeTakeFirstOrThrow()
        if (!['finished', 'failed', 'stopped', 'orphaned', 'skipped'].includes(last.state)) liveRun = last.id
      }
      // Who cancelled is the plan event's actor.
      await endFlowRun(trx, fr, 'cancelled', null, ctx.actor.id)
    }
    return { view: await loadFlowRunView(trx, project.id, id), liveRun }
  })
}

/** The body of `POST /flow-runs/:id/resume`: the answer to the park node's `ask`. */
export const FlowResumeInput = Type.Object(
  { answer: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { maxProperties: 50 })) },
  { additionalProperties: false },
)

export type FlowResumeInput = Static<typeof FlowResumeInput>

/**
 * Resumes flow run `id`, parked at a park node with a `resumed` (or `default`) edge, with a human's `answer`; human
 * members only (DR453). The answer is checked against the `ask_schema` the park recorded (DR101 at `/answer/<field>`;
 * no ask takes an empty answer), stored on the park's node run and passed to the next node as its data. A run parked
 * any other way (max_visits, a label with no edge), or not parked, has nowhere to resume (DR203). The run is running
 * again, so the live-run lock applies (DR314). The resume is a plan event of the task.
 */
export async function resumeFlowRun(
  ctx: Ctx,
  projectKey: string,
  id: string,
  i: FlowResumeInput,
): Promise<FlowRunView> {
  if (ctx.actor.kind !== 'human') fail('DR453', { action: 'resume a flow run' })
  validate(FlowResumeInput, i)
  if (!isUuid(id)) fail('DR201', { kind: 'flow run', key: id })
  const answer = i.answer ?? {}
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const fr = await lockFlowRun(trx, id)
    if (!fr || fr.project_id !== project.id) return fail('DR201', { kind: 'flow run', key: id })
    const park = await trx
      .selectFrom('flow_node_runs')
      .select(['id', 'node', 'kind', 'data'])
      .where('flow_run_id', '=', id)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst()
    const node = park && fr.document.nodes[park.node]
    const target = node && edge(node, 'resumed')
    if (fr.state !== 'parked' || park?.kind !== 'park' || target === undefined) {
      return fail('DR203', { run: id, state: fr.state })
    }
    const data = park.data as { ask_schema?: AskSchema }
    const issue = Value.Errors(askType(data.ask_schema), answer).First()
    if (issue) fail('DR101', { path: `/answer${issue.path}`, reason: issue.message })
    const source = await trx.selectFrom('flow_runs').select('source_key').where('id', '=', id).executeTakeFirstOrThrow()
    await requireFreeSource(trx, project.id, fr.flow_key, source.source_key)
    await trx
      .updateTable('flow_runs')
      .set({ state: 'running', reason: null, ended_at: null })
      .where('id', '=', id)
      .execute()
    fr.state = 'running'
    await trx
      .updateTable('flow_node_runs')
      .set({ data: JSON.stringify({ ...data, answer }) })
      .where('id', '=', park.id)
      .execute()
    await flowEvent(trx, fr, ctx.actor.id, 'flow_run_resume', { flow: fr.flow_key, run: id, node: park.node })
    await proceed(trx, fr, target, { outcome: 'resumed', data: answer })
    return loadFlowRunView(trx, project.id, id)
  })
}

/** A flow run of another project or tenant answers DR201 as if it did not exist. */
export async function flowRunView(ctx: TenantCtx, projectKey: string, id: string): Promise<FlowRunView> {
  if (!isUuid(id)) fail('DR201', { kind: 'flow run', key: id })
  return run(ctx, async (trx) => loadFlowRunView(trx, (await findProject(trx, projectKey)).id, id))
}

const runColumns = [
  'r.id',
  'r.flow_key',
  'f.version',
  't.key as task',
  'r.source_key',
  'r.state',
  'r.reason',
  'r.input',
  'r.started_at',
  'r.ended_at',
] as const

function flowRuns(trx: Trx, projectId: string) {
  return trx
    .selectFrom('flow_runs as r')
    .innerJoin('flows as f', 'f.id', 'r.flow_id')
    .innerJoin('tasks as t', 't.id', 'r.task_id')
    .select(runColumns)
    .where('r.project_id', '=', projectId)
}

type RunRow = Awaited<ReturnType<ReturnType<typeof flowRuns>['executeTakeFirstOrThrow']>>

const summaryOf = (r: RunRow) => ({
  id: r.id,
  flow: r.flow_key,
  version: r.version,
  task: r.task,
  sourceKey: r.source_key,
  state: r.state,
  reason: r.reason,
  startedAt: r.started_at,
  endedAt: r.ended_at,
})

async function loadFlowRunView(trx: Trx, projectId: string, id: string): Promise<FlowRunView> {
  const r = await flowRuns(trx, projectId).where('r.id', '=', id).executeTakeFirst()
  if (!r) fail('DR201', { kind: 'flow run', key: id })
  const nodes = await trx
    .selectFrom('flow_node_runs as n')
    .leftJoin('runs as run', (join) =>
      join.onRef('run.job_id', '=', 'n.job_id').on(({ eb, selectFrom }) =>
        eb(
          'run.attempt',
          '=',
          selectFrom('runs as last')
            .select(({ fn }) => fn.max('last.attempt').as('a'))
            .whereRef('last.job_id', '=', 'n.job_id'),
        ),
      ),
    )
    .select([
      'n.node',
      'n.kind',
      'n.visit',
      'n.outcome',
      'n.data',
      'n.job_id',
      'run.id as run_id',
      'run.state as run_state',
      'n.wake_at',
      'n.started_at',
      'n.ended_at',
    ])
    .where('n.flow_run_id', '=', id)
    .orderBy('n.seq')
    .execute()
  const visits: Record<string, number> = {}
  for (const n of nodes) visits[n.node] = Math.max(visits[n.node] ?? 0, n.visit)
  return {
    ...summaryOf(r),
    input: r.input as Record<string, string>,
    nodes: nodes.map((n) => ({
      node: n.node,
      kind: n.kind,
      visit: n.visit,
      outcome: n.outcome,
      data: n.data as Record<string, unknown>,
      job: n.job_id,
      run: n.run_id === null ? null : { id: n.run_id, state: n.run_state as RunState },
      wakeAt: n.wake_at,
      startedAt: n.started_at,
      endedAt: n.ended_at,
    })),
    visits,
  }
}

/** Flow runs of the project, newest first, optionally of one state or flow; `limit` at most 200. */
export function listFlowRuns(
  ctx: TenantCtx,
  projectKey: string,
  o: { state?: FlowRunState; flow?: string; limit?: number } = {},
): Promise<FlowRunSummary[]> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    let query = flowRuns(trx, project.id)
      .select((eb) =>
        eb
          .selectFrom('flow_node_runs as n')
          .select('n.node')
          .whereRef('n.flow_run_id', '=', 'r.id')
          .where('n.ended_at', 'is', null)
          .as('open_node'),
      )
      .orderBy('r.started_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(Math.min(o.limit ?? 50, 200))
    if (o.state !== undefined) query = query.where('r.state', '=', o.state)
    if (o.flow !== undefined) query = query.where('r.flow_key', '=', o.flow)
    const rows = await query.execute()
    return rows.map((r) => ({ ...summaryOf(r), node: r.open_node }))
  })
}
