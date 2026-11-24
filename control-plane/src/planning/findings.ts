import { fail } from '../errors/error.ts'
import { type Ctx, findProject, run } from './resolve.ts'
import { addTask, lockSourceKey } from './service.ts'

// A finding task is an unphased task keyed `F-` plus 4 digits, opened for something a tool found (a lint rule, a
// flaky test, a failing gate check) and named by the caller's source key.
export const FINDING_KEY_PREFIX = 'F-'
const FINDING_KEY = /^F-\d{4}$/

export type OpenedFinding = { key: string; created: boolean; eventId: string | null }

// Idempotent per source key: while a task of the key is open it is returned as is (no event), so a tool may report
// the same finding on every run. Once that task is done or cancelled the key opens a new task. The project lock
// serializes opens, so the next key is read and taken by one call at a time.
export function openFinding(
  ctx: Ctx,
  projectKey: string,
  i: { sourceKey: string; title: string; description?: string; criteria?: string[] },
): Promise<OpenedFinding> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey, { lock: true })
    const holder = await lockSourceKey(trx, project.id, i.sourceKey)
    if (holder) return { key: holder, created: false, eventId: null }
    // After the highest key, not the count: a key added by hand or by import would make the count collide.
    const keys = await trx
      .selectFrom('tasks')
      .select('key')
      .where('project_id', '=', project.id)
      .where('key', 'like', `${FINDING_KEY_PREFIX}%`)
      .execute()
    const highest = Math.max(0, ...keys.filter((k) => FINDING_KEY.test(k.key)).map((k) => Number(k.key.slice(2))))
    if (highest >= 9999) fail('DR101', { path: '/sourceKey', reason: `${projectKey} has no free finding key left` })
    const key = `${FINDING_KEY_PREFIX}${String(highest + 1).padStart(4, '0')}`
    const { eventId } = await addTask({ ...ctx, trx }, { projectKey, key, ...i })
    return { key, created: true, eventId }
  })
}
