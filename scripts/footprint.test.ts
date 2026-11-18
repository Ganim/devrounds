import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  apiFromEnv,
  CONTROL_PLANE_BUDGET,
  classify,
  EXECUTOR_BUDGET,
  installedPaths,
  missingRoles,
  verdict,
} from './footprint.ts'

const SUPERVISOR = 'C:\\r\\control-plane\\src\\service\\supervise.ts'
const EXE = 'C:\\h\\bin\\devrounds-executor.exe'

test('classify picks the installed services by role, and no lane or e2e process', () => {
  const p = (
    ProcessId: number,
    ParentProcessId: number,
    Name: string,
    ExecutablePath: string,
    CommandLine: string | null,
  ) => ({
    ProcessId,
    ParentProcessId,
    Name,
    ExecutablePath,
    CommandLine,
  })
  const node = 'C:\\node.exe'
  const found = classify(
    [
      // conhost --headless passes the task's arguments on without quotes.
      p(1, 900, 'node.exe', node, `${node} ${SUPERVISOR}`),
      p(11, 900, 'node.exe', node, `"${node}" "${SUPERVISOR}"`),
      p(2, 1, 'node.exe', node, `"${node}" C:\\r\\control-plane\\src\\main.ts serve`),
      p(3, 1, 'node.exe', node, `"${node}" C:\\r\\control-plane\\src\\cli\\main.ts plan show`),
      // A lane's or the e2e's serve, not under the installed supervisor.
      p(8, 700, 'node.exe', node, `"${node}" C:\\wt\\control-plane\\src\\main.ts serve`),
      // A supervisor of another checkout.
      p(9, 900, 'node.exe', node, `"${node}" "C:\\wt\\control-plane\\src\\service\\supervise.ts"`),
      p(4, 901, 'devrounds-executor.exe', EXE, `"${EXE}" supervise`),
      p(5, 4, 'devrounds-executor.exe', EXE, `"${EXE}" run --supervised`),
      p(6, 5, 'devrounds-executor.exe', EXE, `"${EXE}" __console-ctrl 42 c`),
      // The e2e's executor, run from target/release.
      p(10, 1, 'devrounds-executor.exe', 'C:\\r\\target\\release\\devrounds-executor.exe', '"x" supervise'),
      p(7, 1, 'node.exe', node, null),
    ],
    { supervisor: SUPERVISOR.toUpperCase(), executor: EXE },
  )
  assert.deepEqual(found, {
    controlPlane: { supervise: [1, 11], serve: [2] },
    executor: { supervise: [4], run: [5] },
  })
})

test('installed paths come from the two scheduled tasks, null when a task is missing', () => {
  assert.deepEqual(
    installedPaths({
      controlPlane: `--headless "C:\\node.exe" "${SUPERVISOR}"`,
      executor: `--headless "${EXE}" supervise`,
    }),
    { supervisor: SUPERVISOR, executor: EXE },
  )
  assert.deepEqual(installedPaths({ controlPlane: null, executor: null }), { supervisor: null, executor: null })
})

test('a missing role is named, and fails its side', () => {
  const missing = missingRoles({
    controlPlane: { supervise: [1], serve: [] },
    executor: { supervise: [], run: [] },
  })
  assert.deepEqual(missing, {
    controlPlane: ['serve'],
    executor: ['supervise', 'run'],
  })
  const result = verdict([
    { name: 'executor', budget: EXECUTOR_BUDGET, processes: [], missing: missing.executor },
    {
      name: 'control plane',
      budget: CONTROL_PLANE_BUDGET,
      processes: [{ pid: 1, name: 'node', privateBytes: 1 }],
      missing: missing.controlPlane,
    },
  ])
  assert.equal(result.ok, false)
  assert.match(result.lines[0], /missing supervise, run/)
  assert.match(result.lines[1], /FAIL .*missing serve/)
})

test('verdict sums each side, fails over budget and fails a side with no process', () => {
  const at = (privateBytes: number) => [{ pid: 1, name: 'x', privateBytes }]
  const sides = (executor: number | null, controlPlane: number) => [
    { name: 'executor', budget: EXECUTOR_BUDGET, processes: executor === null ? [] : at(executor) },
    { name: 'control plane', budget: CONTROL_PLANE_BUDGET, processes: at(controlPlane) },
  ]
  assert.equal(verdict(sides(EXECUTOR_BUDGET, CONTROL_PLANE_BUDGET)).ok, true)
  assert.equal(verdict(sides(EXECUTOR_BUDGET + 1, 1)).ok, false)
  assert.equal(verdict(sides(1, CONTROL_PLANE_BUDGET + 1)).ok, false)
  const missing = verdict(sides(null, 1))
  assert.equal(missing.ok, false)
  assert.match(missing.lines[0], /no process found/)
})

test('without a login or DEVROUNDS_URL the error says how to give one', async () => {
  await assert.rejects(
    apiFromEnv({}, join(import.meta.dirname, 'no-such-home')),
    /no-such-home.*config\.json.*DEVROUNDS_URL and DEVROUNDS_TOKEN/s,
  )
})
