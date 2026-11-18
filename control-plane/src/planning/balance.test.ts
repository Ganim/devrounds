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
