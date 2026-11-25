import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import type { Ctx } from '../planning/resolve.ts'
import { addTask, createProject } from '../planning/service.ts'
import { testDb } from '../test-support/db.ts'
import type { ConventionsFile } from './file.ts'
import { decide, propose, versionView } from './service.ts'

const projectKey = 'devrounds'

const failsWith =
  (code: string, data: Record<string, unknown> = {}) =>
  (err: unknown) =>
    err instanceof DevRoundsError &&
    err.code === code &&
    Object.entries(data).every(([key, value]) => err.data[key] === value)

function document(severity: 'warn' | 'block' = 'warn'): ConventionsFile {
  return {
    targets: [{ path: 'AGENTS.md' }],
    rules: [
      {
        key: 'engine.no-tool-names',
        section: 'Never',
        title: 'Never put a tool name in engine code',
        why: 'Providers are adapters.',
        paths: ['control-plane/src/**/*.ts'],
        check: { kind: 'pattern', forbid: '\\bdevlanes\\b' },
        severity,
        examples: { bad: ['// devlanes default'] },
        evidence: [{ path: 'AGENTS.md', excerpt: 'Never put a vendor', role: 'source' }],
      },
    ],
  }
}

// A tenant with project `devrounds` and task P3-T06; `human` and `agent` act as the tenant's two members.
async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  const human: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  const agent: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.agent.id, kind: 'agent' } }
  await createProject(human, { key: projectKey, name: 'DevRounds' })
  await addTask(human, { projectKey, key: 'P3-T06', title: 'Conventions' })
  const proposeAs = (ctx: Ctx, basedOn: number | null, opts: { replace?: boolean; severity?: 'warn' | 'block' } = {}) =>
    propose(ctx, projectKey, {
      document: document(opts.severity),
      basedOn,
      headSha: null,
      task: 'P3-T06',
      replace: opts.replace,
    })
  return { t, human, agent, proposeAs }
}

test('the first proposal is version 1 based on null', async () => {
  const { human, agent, proposeAs } = await setup()
  assert.deepEqual(await proposeAs(agent, null), { version: 1 })
  const view = await versionView(human, projectKey, '1')
  assert.equal(view.state, 'proposed')
  assert.equal(view.basedOn, null)
  assert.equal(view.task, 'P3-T06')
  assert.equal(view.proposedBy, 'agent')
  assert.match(view.documentSha, /^[0-9a-f]{64}$/)
})

test('approve by an agent answers DR453', async () => {
  const { agent, proposeAs } = await setup()
  await proposeAs(agent, null)
  await assert.rejects(
    decide(agent, projectKey, 1, 'approve', undefined),
    failsWith('DR453', { action: 'approve conventions' }),
  )
  await assert.rejects(
    decide(agent, projectKey, 1, 'reject', 'no'),
    failsWith('DR453', { action: 'reject conventions' }),
  )
})

test('approve makes it active and the previous active superseded', async () => {
  const { human, agent, proposeAs } = await setup()
  await proposeAs(agent, null)
  await decide(human, projectKey, 1, 'approve', undefined)
  await proposeAs(agent, 1, { severity: 'block' })
  await decide(human, projectKey, 2, 'approve', 'stricter')
  assert.equal((await versionView(human, projectKey, '1')).state, 'superseded')
  const active = await versionView(human, projectKey, 'active')
  assert.equal(active.version, 2)
  assert.equal(active.state, 'active')
  assert.equal(active.decidedBy, 'human')
  assert.equal(active.reason, 'stricter')
})

test('a proposal based on version 1 answers DR310 on approve after version 2 became active', async () => {
  const { t, human, agent, proposeAs } = await setup()
  await proposeAs(agent, null)
  await decide(human, projectKey, 1, 'approve', undefined)
  await proposeAs(agent, 1)
  await decide(human, projectKey, 2, 'approve', undefined)
  await proposeAs(agent, 2)
  // One proposal is open at a time and propose checks basedOn, so a stale proposal cannot be made through the API;
  // the approve check guards the row itself. Rewrite version 3 as one made before version 2 was approved.
  await t.admin
    .updateTable('convention_sets')
    .set({ based_on: 1 })
    .where('tenant_id', '=', human.tenantId)
    .where('version', '=', 3)
    .execute()
  await assert.rejects(
    decide(human, projectKey, 3, 'approve', undefined),
    failsWith('DR310', { version: 3, basedOn: 1, active: 2 }),
  )
  // Propose checks it too.
  await decide(human, projectKey, 3, 'reject', 'stale')
  await assert.rejects(proposeAs(agent, 1), failsWith('DR310', { basedOn: 1, active: 2 }))
})

test('a second propose answers DR311; --replace withdraws the first', async () => {
  const { human, agent, proposeAs } = await setup()
  await proposeAs(agent, null)
  await assert.rejects(proposeAs(agent, null), failsWith('DR311', { version: 1, project: projectKey }))
  assert.deepEqual(await proposeAs(agent, null, { replace: true }), { version: 2 })
  assert.equal((await versionView(human, projectKey, '1')).state, 'withdrawn')
  assert.equal((await versionView(human, projectKey, '2')).state, 'proposed')
})

test('two concurrent approvals of one proposal: one active, the other DR313', async () => {
  const { human, agent, proposeAs } = await setup()
  await proposeAs(agent, null)
  const results = await Promise.allSettled([
    decide(human, projectKey, 1, 'approve', undefined),
    decide(human, projectKey, 1, 'approve', undefined),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  const loser = results.find((r) => r.status === 'rejected')
  assert.ok(loser && failsWith('DR313', { version: 1, state: 'active' })(loser.reason), String(loser?.reason))
  assert.equal((await versionView(human, projectKey, 'active')).version, 1)
})

test("another tenant's version is DR201", async () => {
  const { agent, proposeAs } = await setup()
  await proposeAs(agent, null)
  const other = await setup()
  await assert.rejects(versionView(other.human, projectKey, '1'), failsWith('DR201', { kind: 'conventions', key: '1' }))
  await assert.rejects(
    decide(other.human, projectKey, 1, 'approve', undefined),
    failsWith('DR201', { kind: 'conventions', key: '1' }),
  )
})
