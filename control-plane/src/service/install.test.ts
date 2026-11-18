import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { stopSupervisorScript, unregisterScript } from './install.ts'

const run = promisify(execFile)
const target = (supervisor: string) => ({ node: process.execPath, supervisor, workdir: '.' })

test('uninstall stops the supervisor whether or not the scheduled task exists', () => {
  const fake = target('fake-supervise.ts')
  const lines = unregisterScript(fake).split('\n')
  const kill = stopSupervisorScript(fake).split('\n')
  const start = lines.indexOf(kill[0] as string)
  assert.ok(start > 0, 'supervisor kill is part of the uninstall script')
  // Inside `if ($task) {` the kill would be skipped when the task is gone.
  const before = lines.slice(0, start)
  const open = before.filter((l) => l.endsWith('{')).length
  const closed = before.filter((l) => l === '}').length
  assert.equal(open, closed, 'kill sits outside any if block')
})

test('stopSupervisorScript kills a node process running the supervisor path and leaves others', {
  skip: process.platform !== 'win32',
}, async () => {
  const supervisor = `devrounds-test-${process.pid}-supervise.ts`
  const idle = ['-e', 'setInterval(() => {}, 1000)']
  const orphan = spawn(process.execPath, [...idle, supervisor], { stdio: 'ignore', windowsHide: true })
  const bystander = spawn(process.execPath, [...idle, 'unrelated'], { stdio: 'ignore', windowsHide: true })
  try {
    await Promise.all([once(orphan, 'spawn'), once(bystander, 'spawn')])
    const orphanExit = once(orphan, 'exit')
    const script = `$ErrorActionPreference = 'Stop'\n${stopSupervisorScript(target(supervisor))}`
    const powershell = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    })
    powershell.child.stdin?.end()
    await powershell
    await orphanExit
    assert.equal(bystander.exitCode, null)
  } finally {
    orphan.kill()
    bystander.kill()
  }
})
