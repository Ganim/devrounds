import { type Static, Type } from '@sinclair/typebox'
import { sql } from 'kysely'
import type { ConventionSetState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { requireHuman } from '../machines/pairing.ts'
import { type Ctx, findProject, findTask, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { validate } from '../validate.ts'
import { diffVersions, type VersionDiff } from './diff-versions.ts'
import { findDocumentIssue } from './examples-check.ts'
import { type ConventionsDef, type ConventionsFile, documentSha, withDefaults } from './file.ts'

// The body of `POST /conventions/proposals`. The document is checked by findDocumentIssue rather than by this schema,
// so a problem is named by its own path (e.g. /document/rules/0/examples/bad/0) instead of a failed union.
// headSha is the caller's report of the commit it verified the evidence against; DevRounds never reads the repo.
export const ProposeInput = Type.Object(
  {
    document: Type.Unknown(),
    basedOn: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    headSha: Type.Union([Type.String({ pattern: '^[0-9a-f]{7,64}$' }), Type.Null()]),
    task: Type.String({ minLength: 1, maxLength: 200 }),
    replace: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export type ProposeInput = Static<typeof ProposeInput>

export type VersionSummary = {
  version: number
  state: ConventionSetState
  documentSha: string
  basedOn: number | null
  headSha: string | null
  // The task that asked for it, and the members by name.
  task: string
  proposedBy: string
  proposedAt: Date
  decidedBy: string | null
  decidedAt: Date | null
  reason: string | null
}

export type VersionView = VersionSummary & { document: ConventionsFile }

export type ConventionsSummary = { active: VersionSummary | null; proposal: VersionSummary | null }

const VERSION = /^[1-9][0-9]{0,8}$/

const EMPTY: ConventionsDef = { targets: [], rules: [], facts: [] }

function rowsOf(trx: Trx, projectId: string) {
  return trx
    .selectFrom('convention_sets as c')
    .innerJoin('tasks as t', 't.id', 'c.task_id')
    .innerJoin('members as p', 'p.id', 'c.proposed_by')
    .leftJoin('members as d', 'd.id', 'c.decided_by')
    .select([
      'c.version',
      'c.state',
      'c.document_sha',
      'c.based_on',
      'c.head_sha',
      't.key as task',
      'p.name as proposed_by',
      'c.proposed_at',
      'd.name as decided_by',
      'c.decided_at',
      'c.reason',
    ])
    .where('c.project_id', '=', projectId)
}

type Row = Awaited<ReturnType<ReturnType<typeof rowsOf>['executeTakeFirstOrThrow']>>

const summaryOf = (row: Row): VersionSummary => ({
  version: row.version,
  state: row.state,
  documentSha: row.document_sha,
  basedOn: row.based_on,
  headSha: row.head_sha,
  task: row.task,
  proposedBy: row.proposed_by,
  proposedAt: row.proposed_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  reason: row.reason,
})

// `active` or a version number; anything else names no version.
async function loadVersion(trx: Trx, projectId: string, projectKey: string, version: string): Promise<VersionView> {
  if (version !== 'active' && !VERSION.test(version)) fail('DR201', { kind: 'conventions', key: version })
  const query = rowsOf(trx, projectId).select('c.document')
  const row = await (version === 'active'
    ? query.where('c.state', '=', 'active')
    : query.where('c.version', '=', Number(version))
  ).executeTakeFirst()
  if (!row) fail('DR201', { kind: 'conventions', key: version === 'active' ? projectKey : version })
  return { ...summaryOf(row), document: row.document as ConventionsFile }
}

/** The active version and the open proposal, without their documents. */
export function conventionsSummary(ctx: TenantCtx, projectKey: string): Promise<ConventionsSummary> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const rows = await rowsOf(trx, project.id).where('c.state', 'in', ['active', 'proposed']).execute()
    const of = (state: ConventionSetState) => {
      const row = rows.find((r) => r.state === state)
      return row ? summaryOf(row) : null
    }
    return { active: of('active'), proposal: of('proposed') }
  })
}

/** A version by number, or `active`. A version of another project or tenant answers DR201 kind `conventions`. */
export function versionView(ctx: TenantCtx, projectKey: string, version: string): Promise<VersionView> {
  return run(ctx, async (trx) => loadVersion(trx, (await findProject(trx, projectKey)).id, projectKey, version))
}

/** The active version; none yet is DR201 kind `conventions` (plan call 4: a check without one is a setup error). */
export function activeVersion(ctx: TenantCtx, projectKey: string): Promise<VersionView> {
  return versionView(ctx, projectKey, 'active')
}

/**
 * What `version` changes from `against` (a number or `active`, the default). Against `active` with no active version,
 * the base is an empty document, so a first proposal lists everything as added.
 */
export function versionDiff(
  ctx: TenantCtx,
  projectKey: string,
  version: string,
  against = 'active',
): Promise<VersionDiff & { version: number; against: number | null }> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const view = await loadVersion(trx, project.id, projectKey, version)
    const none = against === 'active' && !(await activeRow(trx, project.id))
    const base = none ? null : await loadVersion(trx, project.id, projectKey, against)
    const diff = diffVersions(base ? withDefaults(base.document) : EMPTY, withDefaults(view.document))
    return { version: view.version, against: base?.version ?? null, ...diff }
  })
}

async function activeRow(trx: Trx, projectId: string) {
  return trx
    .selectFrom('convention_sets')
    .select(['id', 'version'])
    .where('project_id', '=', projectId)
    .where('state', '=', 'active')
    .executeTakeFirst()
}

/**
 * DR101 unless the proposal is valid, its examples checked off the event loop (findDocumentIssue). The route runs it
 * before opening the idempotency transaction: the check can take up to the examples budget, and inside a
 * transaction it would hold a pooled connection that long.
 */
export async function checkProposal(input: ProposeInput): Promise<void> {
  validate(ProposeInput, input)
  const issue = await findDocumentIssue(input.document)
  if (issue) fail('DR101', { path: `/document${issue.path === '/' ? '' : issue.path}`, reason: issue.reason })
}

/** checkProposal, then recordProposal. */
export async function propose(ctx: Ctx, projectKey: string, input: ProposeInput): Promise<{ version: number }> {
  await checkProposal(input)
  return recordProposal(ctx, projectKey, input)
}

/**
 * Records a checked proposal as the next version. Serialized per project on the project row: one proposal is open at
 * a time (DR311; `replace` withdraws it), and `basedOn` must be the active version (null for none), else DR310.
 */
export async function recordProposal(ctx: Ctx, projectKey: string, input: ProposeInput): Promise<{ version: number }> {
  const document = input.document as ConventionsFile
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey, { lock: true })
    const task = await findTask(trx, project.id, input.task)
    const { last } = await trx
      .selectFrom('convention_sets')
      .select(({ fn }) => fn.max('version').as('last'))
      .where('project_id', '=', project.id)
      .executeTakeFirstOrThrow()
    const version = (last ?? 0) + 1
    const open = await trx
      .selectFrom('convention_sets')
      .select(['id', 'version'])
      .where('project_id', '=', project.id)
      .where('state', '=', 'proposed')
      .executeTakeFirst()
    if (open && !input.replace) fail('DR311', { version: open.version, project: projectKey })
    const active = await activeRow(trx, project.id)
    if (input.basedOn !== (active?.version ?? null)) {
      fail('DR310', { version, basedOn: input.basedOn ?? 'none', active: active?.version ?? 'none' })
    }
    if (open) await trx.updateTable('convention_sets').set({ state: 'withdrawn' }).where('id', '=', open.id).execute()
    await trx
      .insertInto('convention_sets')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        version,
        document: JSON.stringify(document),
        document_sha: documentSha(withDefaults(document)),
        based_on: input.basedOn,
        head_sha: input.headSha,
        task_id: task.id,
        proposed_by: ctx.actor.id,
      })
      .execute()
    return { version }
  })
}

/**
 * Approves or rejects a proposal; human members only (DR453), and a rejection needs a reason (DR104). Serialized per
 * project on the project row, so of two concurrent approvals the second reads the version as active and answers DR313.
 * Approve checks `basedOn` against the active version again (DR310), then supersedes it, in one transaction.
 */
export async function decide(
  ctx: Ctx,
  projectKey: string,
  version: number,
  decision: 'approve' | 'reject',
  reason: string | undefined,
): Promise<VersionSummary> {
  requireHuman(ctx, `${decision} conventions`)
  const why = reason?.trim() ? reason : null
  if (decision === 'reject' && why === null) fail('DR104')
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey, { lock: true })
    const row = await trx
      .selectFrom('convention_sets')
      .select(['id', 'state', 'based_on'])
      .where('project_id', '=', project.id)
      .where('version', '=', version)
      .executeTakeFirst()
    if (!row) return fail('DR201', { kind: 'conventions', key: String(version) })
    if (row.state !== 'proposed') fail('DR313', { version, state: row.state })
    const decided = { decided_by: ctx.actor.id, decided_at: sql<Date>`now()`, reason: why }
    if (decision === 'approve') {
      const active = await activeRow(trx, project.id)
      if (row.based_on !== (active?.version ?? null)) {
        fail('DR310', { version, basedOn: row.based_on ?? 'none', active: active?.version ?? 'none' })
      }
      // Superseded first: the partial unique index allows one active row per project at any moment.
      if (active) {
        await trx.updateTable('convention_sets').set({ state: 'superseded' }).where('id', '=', active.id).execute()
      }
    }
    await trx
      .updateTable('convention_sets')
      .set({ state: decision === 'approve' ? 'active' : 'rejected', ...decided })
      .where('id', '=', row.id)
      .execute()
    return summaryOf(await rowsOf(trx, project.id).where('c.version', '=', version).executeTakeFirstOrThrow())
  })
}
