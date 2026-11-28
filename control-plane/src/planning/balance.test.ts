import assert from 'node:assert/strict'
import { test } from 'node:test'
import { testDb } from '../test-support/db.ts'
import { type BalanceEvent, computeBalance, getBalance } from './balance.ts'
import { importPlan } from './import.ts'
import { parsePlanFile } from './plan-file.ts'
import { addTask, createProject, transition } from './service.ts'

const timezone = 'America/Sao_Paulo' // UTC-3, no DST
const at = (iso: string) => new Date(iso)
const move = (taskKey: string, when: string, from: string, to: string): BalanceEvent => ({
  kind: 'transition',
  taskKey,
  at: at(when),
  from,
  to,
})

test('interval across local midnight splits', () => {
  // 22:00 -> 02:00 local on 11-16/11-17 is 01:00Z -> 05:00Z on 11-17
  const rows = computeBalance(
    [
      move('T1', '2026-11-17T01:00:00Z', 'todo', 'in_progress'),
      move('T1', '2026-11-17T05:00:00Z', 'in_progress', 'review'),
    ],
    {
      timezone,
      period: 'day',
      from: at('2026-11-16T12:00:00Z'),
      to: at('2026-11-17T12:00:00Z'),
      now: at('2026-11-18T00:00:00Z'),
    },
  )
  assert.deepEqual(
    rows.map((r) => [r.periodStart, r.hoursInProgress]),
    [
      ['2026-11-16', 2],
      ['2026-11-17', 2],
    ],
  )
})

test('week rows start on Monday', () => {
  // 2026-11-16 is a Monday
  const rows = computeBalance([], {
    timezone,
    period: 'week',
    from: at('2026-11-18T12:00:00Z'),
    to: at('2026-11-30T12:00:00Z'),
    now: at('2026-12-01T00:00:00Z'),
  })
  assert.deepEqual(
    rows.map((r) => r.periodStart),
    ['2026-11-16', '2026-11-23', '2026-11-30'],
  )
})

test('open interval counts until now', () => {
  const rows = computeBalance([move('T1', '2026-11-16T15:00:00Z', 'todo', 'in_progress')], {
    timezone,
    period: 'day',
    from: at('2026-11-16T12:00:00Z'),
    to: at('2026-11-16T12:00:00Z'),
    now: at('2026-11-16T18:30:00Z'),
  })
  assert.equal(rows[0]?.hoursInProgress, 3.5)
})

test('avgCycleHours null without done, averaged with done', () => {
  const opts = {
    timezone,
    period: 'day' as const,
    from: at('2026-11-16T12:00:00Z'),
    to: at('2026-11-16T12:00:00Z'),
    now: at('2026-11-17T00:00:00Z'),
  }
  assert.equal(
    computeBalance([move('T1', '2026-11-16T12:00:00Z', 'todo', 'in_progress')], opts)[0]?.avgCycleHours,
    null,
  )
  const row = computeBalance(
    [
      move('T1', '2026-11-16T12:00:00Z', 'todo', 'in_progress'),
      move('T1', '2026-11-16T15:00:00Z', 'in_progress', 'done'),
      move('T2', '2026-11-16T12:00:00Z', 'todo', 'in_progress'),
      move('T2', '2026-11-16T14:00:00Z', 'in_progress', 'cancelled'),
    ],
    opts,
  )[0]
  assert.equal(row?.avgCycleHours, 3)
  assert.equal(row?.done, 1)
  assert.equal(row?.cancelled, 1)
})

test('opened counts add_task', () => {
  const rows = computeBalance(
    [
      { kind: 'add_task', taskKey: 'T1', at: at('2026-11-16T12:00:00Z') },
      { kind: 'add_task', taskKey: 'T2', at: at('2026-11-17T12:00:00Z') },
      { kind: 'add_task', taskKey: 'T3', at: at('2026-11-17T13:00:00Z') },
    ],
    {
      timezone,
      period: 'day',
      from: at('2026-11-16T12:00:00Z'),
      to: at('2026-11-17T12:00:00Z'),
      now: at('2026-11-18T00:00:00Z'),
    },
  )
  assert.deepEqual(
    rows.map((r) => r.opened),
    [1, 2],
  )
})

test('getBalance reads events of the project', async () => {
  const { db, newTenant } = await testDb()
  const tenant = await newTenant()
  const ctx = { db, tenantId: tenant.tenantId, actor: { id: tenant.agent.id, kind: 'agent' as const } }
  await createProject(ctx, { key: 'devrounds', name: 'DevRounds' })
  await addTask(ctx, { projectKey: 'devrounds', key: 'T1', title: 'One' })
  await transition(ctx, { projectKey: 'devrounds', taskKey: 'T1', to: 'in_progress' })
  const now = new Date()
  const rows = await getBalance(ctx, 'devrounds', { period: 'day', from: now, to: now, now })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.opened, 1)
})

test('tasks moved to done by plan import do not count as done', async () => {
  const { db, newTenant } = await testDb()
  const tenant = await newTenant()
  const ctx = { db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' as const } }
  await importPlan(
    ctx,
    parsePlanFile(`
project: { key: devrounds, name: DevRounds }
phases:
  - key: P0
    title: Foundation
    goal: Plan
    tasks:
      - { key: P0-T01, title: Imported, state: done }
      - { key: P0-T02, title: Worked, state: in_progress }
`),
  )
  await transition(ctx, { projectKey: 'devrounds', taskKey: 'P0-T02', to: 'done' })

  const now = new Date()
  const [row] = await getBalance(ctx, 'devrounds', { period: 'day', from: now, to: now, now })
  // Only the done of P0-T02 counts; its start came from the import, so it has no measured cycle or hours.
  assert.deepEqual([row?.done, row?.avgCycleHours, row?.hoursInProgress], [1, null, 0])
})

test('getBalance splits DST days in the tenant time zone', async () => {
  const { db, admin, newTenant } = await testDb()
  const tenant = await newTenant()
  // Not the default zone, and one with DST: 2026-03-08 is 23 h long in New York, 2026-11-01 is 25 h.
  await admin.updateTable('tenants').set({ timezone: 'America/New_York' }).where('id', '=', tenant.tenantId).execute()
  const ctx = { db, tenantId: tenant.tenantId, actor: { id: tenant.agent.id, kind: 'agent' as const } }
  await createProject(ctx, { key: 'devrounds', name: 'DevRounds' })
  await addTask(ctx, { projectKey: 'devrounds', key: 'T1', title: 'Spring' })
  await transition(ctx, { projectKey: 'devrounds', taskKey: 'T1', to: 'in_progress' })
  await transition(ctx, { projectKey: 'devrounds', taskKey: 'T1', to: 'todo' })
  await addTask(ctx, { projectKey: 'devrounds', key: 'T2', title: 'Fall' })
  await transition(ctx, { projectKey: 'devrounds', taskKey: 'T2', to: 'in_progress' })
  await transition(ctx, { projectKey: 'devrounds', taskKey: 'T2', to: 'done' })
  // Events carry the time they were written; place them on the DST days. Each stretch runs local midnight to midnight.
  const times = [
    '2026-03-08T04:30:00Z', // 23:30 EST on 03-07; 01:30 on 03-08 in Sao Paulo
    '2026-03-08T05:00:00Z', // 00:00 EST 03-08
    '2026-03-09T04:00:00Z', // 00:00 EDT 03-09
    '2026-10-31T12:00:00Z',
    '2026-11-01T04:00:00Z', // 00:00 EDT 11-01
    '2026-11-02T05:00:00Z', // 00:00 EST 11-02
  ]
  const events = await admin
    .selectFrom('plan_events')
    .select('id')
    .where('tenant_id', '=', tenant.tenantId)
    .where('kind', 'in', ['add_task', 'transition'])
    .orderBy('id')
    .execute()
  assert.equal(events.length, times.length)
  for (const [i, { id }] of events.entries()) {
    await admin
      .updateTable('plan_events')
      .set({ at: at(times[i] as string) })
      .where('id', '=', id)
      .execute()
  }

  const day = (from: string, to: string) =>
    getBalance(ctx, 'devrounds', { period: 'day', from: at(from), to: at(to), now: at('2026-12-01T00:00:00Z') })
  const spring = await day('2026-03-07T12:00:00Z', '2026-03-09T12:00:00Z')
  assert.deepEqual(
    spring.map((r) => [r.periodStart, r.opened, r.hoursInProgress]),
    [
      ['2026-03-07', 1, 0],
      ['2026-03-08', 0, 23],
      ['2026-03-09', 0, 0],
    ],
  )
  const fall = await day('2026-10-31T12:00:00Z', '2026-11-02T12:00:00Z')
  assert.deepEqual(
    fall.map((r) => [r.periodStart, r.opened, r.hoursInProgress, r.done, r.avgCycleHours]),
    [
      ['2026-10-31', 1, 0, 0, null],
      ['2026-11-01', 0, 25, 0, null],
      ['2026-11-02', 0, 0, 1, 25],
    ],
  )
})
