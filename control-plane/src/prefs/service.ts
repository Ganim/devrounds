import { sql } from 'kysely'
import { fail } from '../errors/error.ts'
import { type Ctx, findProject, run } from '../planning/resolve.ts'

/** A pref name: lowercase, dotted by feature (`sessions.order`, `board.columns`); the table checks it too. */
export const PREF_NAME = '^[a-z][a-z0-9.-]{0,99}$'

// Enough for the order and names of a few thousand items; a larger value is a feature storing data, not a preference.
export const MAX_PREF_BYTES = 64 * 1024

export type Pref = { name: string; value: unknown; updatedAt: Date | null }

// Prefs belong to the calling member (ctx.actor) inside one project of its tenant: RLS keeps the tenant and the
// member_id filter keeps the member, so another member's order never shows up.

export function listPrefs(ctx: Ctx, projectKey: string): Promise<{ prefs: Pref[] }> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const rows = await trx
      .selectFrom('member_prefs')
      .select(['name', 'value', 'updated_at'])
      .where('member_id', '=', ctx.actor.id)
      .where('project_id', '=', project.id)
      .orderBy('name')
      .execute()
    return { prefs: rows.map((row) => ({ name: row.name, value: row.value, updatedAt: row.updated_at })) }
  })
}

// An unset pref reads as null rather than DR201: a new device asks before anything was saved, and the feature falls
// back to its default.
export function getPref(ctx: Ctx, projectKey: string, name: string): Promise<Pref> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const row = await trx
      .selectFrom('member_prefs')
      .select(['value', 'updated_at'])
      .where('member_id', '=', ctx.actor.id)
      .where('project_id', '=', project.id)
      .where('name', '=', name)
      .executeTakeFirst()
    return { name, value: row?.value ?? null, updatedAt: row?.updated_at ?? null }
  })
}

// Last write wins: two devices saving at once is one person reordering twice, and the later order is the one meant.
export function setPref(ctx: Ctx, projectKey: string, name: string, value: unknown): Promise<Pref> {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > MAX_PREF_BYTES) {
    fail('DR101', { path: '/value', reason: `is over ${MAX_PREF_BYTES} bytes of JSON` })
  }
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const row = await trx
      .insertInto('member_prefs')
      .values({ tenant_id: ctx.tenantId, member_id: ctx.actor.id, project_id: project.id, name, value: json })
      .onConflict((oc) =>
        oc
          .columns(['tenant_id', 'member_id', 'project_id', 'name'])
          .doUpdateSet({ value: json, updated_at: sql<Date>`now()` }),
      )
      .returning(['value', 'updated_at'])
      .executeTakeFirstOrThrow()
    return { name, value: row.value, updatedAt: row.updated_at }
  })
}
