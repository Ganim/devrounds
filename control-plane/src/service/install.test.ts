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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

test('stopSupervisorScript stops a node process running the supervisor path, and its serve, before returning', {
  skip: process.platform !== 'win32',
}, async () => {
  const supervisor = `devrounds-test-${process.pid}-supervise.ts`
  const idle = 'setInterval(() => {}, 1000)'
  // Stands in for supervise: starts a child (its serve) and prints that child's pid.
  const startsServe = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); console.log(c.pid); ${idle}`
  const orphan = spawn(process.execPath, ['-e', startsServe, supervisor], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  const bystander = spawn(process.execPath, ['-e', idle, 'unrelated'], { stdio: 'ignore', windowsHide: true })
  try {
    const [[line]] = (await Promise.all([once(orphan.stdout, 'data'), once(bystander, 'spawn')])) as [[Buffer], unknown]
    const serve = Number(line.toString().trim())
    const script = `$ErrorActionPreference = 'Stop'\n${stopSupervisorScript(target(supervisor))}`
    const powershell = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    })
    powershell.child.stdin?.end()
    await powershell
    // Gone when the script returns, not later: install starts the new task right after it, and its serve needs the port.
    assert.equal(alive(orphan.pid as number), false, 'supervisor still running')
    assert.equal(alive(serve), false, 'its serve still running')
    assert.equal(bystander.exitCode, null)
  } finally {
    orphan.kill()
    bystander.kill()
  }
})
