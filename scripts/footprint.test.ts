import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTROL_PLANE_BUDGET, classify, EXECUTOR_BUDGET, verdict } from './footprint.ts'

test('classify picks the two service pairs by command line and nothing else', () => {
  const p = (ProcessId: number, Name: string, CommandLine: string | null) => ({ ProcessId, Name, CommandLine })
  const found = classify([
    p(1, 'node.exe', '"C:\\node.exe" "C:\\r\\control-plane\\src\\service\\supervise.ts"'),
    p(2, 'node.exe', '"C:\\node.exe" C:\\r\\control-plane\\src\\main.ts serve'),
    p(3, 'node.exe', '"C:\\node.exe" C:\\r\\control-plane\\src\\cli\\main.ts plan show'),
    p(4, 'devrounds-executor.exe', '"C:\\h\\bin\\devrounds-executor.exe" supervise'),
    p(5, 'devrounds-executor.exe', '"C:\\h\\bin\\devrounds-executor.exe" run --supervised'),
    p(6, 'devrounds-executor.exe', '"C:\\h\\bin\\devrounds-executor.exe" __console-ctrl 42 c'),
    p(7, 'node.exe', null),
  ])
  assert.deepEqual(found, { controlPlane: [1, 2], executor: [4, 5] })
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
