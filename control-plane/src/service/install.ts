import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { fail } from '../errors/error.ts'

const run = promisify(execFile)

export const TASK_NAME = 'DevRounds'

// PowerShell single-quoted string: nothing expands inside, a quote is written twice.
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`

export type ServiceTarget = { node: string; supervisor: string; workdir: string }

// realpath for both: a version manager can put node on PATH through a per-shell link that is deleted later, and the
// task must keep pointing at a file that exists. Changing the Node install means running `service install` again.
export async function serviceTarget(): Promise<ServiceTarget> {
  const supervisor = await realpath(fileURLToPath(new URL('./supervise.ts', import.meta.url)))
  return {
    node: await realpath(process.execPath),
    supervisor,
    workdir: join(supervisor, '..', '..', '..', '..'),
  }
}

// Filtered rather than -TaskName: a missing name is a terminating error under ErrorActionPreference Stop, even with
// -ErrorAction SilentlyContinue, and uninstalling twice should be a no-op.
const findTask = `$task = Get-ScheduledTask | Where-Object TaskName -eq ${ps(TASK_NAME)}`

// Stopping the task ends only conhost; the supervisor under it keeps running. It is stopped by its command line, and
// serve follows it (see main.ts), so a reinstall or uninstall never leaves an old pair holding the port.
function stopRunning(t: ServiceTarget): string[] {
  return [
    `Stop-ScheduledTask -TaskName ${ps(TASK_NAME)}`,
    `Get-CimInstance Win32_Process -Filter "name='node.exe'" |`,
    `  Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${ps(t.supervisor)}) } |`,
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ]
}

// At logon, plus a repeating trigger every 5 minutes as a safety net: with IgnoreNew it starts the supervisor only
// when no instance is running. No execution time limit, since the supervisor runs for good. `conhost --headless`
// keeps the console of the node process hidden.
export function registerScript(t: ServiceTarget): string {
  const user = '"$env:USERDOMAIN\\$env:USERNAME"'
  const argument = `--headless "${t.node}" "${t.supervisor}"`
  return [
    findTask,
    'if ($task) {',
    ...stopRunning(t),
    '}',
    `$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\conhost.exe" -Argument ${ps(argument)} ` +
      `-WorkingDirectory ${ps(t.workdir)}`,
    `$logon = New-ScheduledTaskTrigger -AtLogOn -User ${user}`,
    '$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)',
    '$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) ' +
      '-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable',
    `$principal = New-ScheduledTaskPrincipal -UserId ${user} -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName ${ps(TASK_NAME)} -Action $action -Trigger $logon,$repeat ` +
      '-Settings $settings -Principal $principal -Force | Out-Null',
    `Start-ScheduledTask -TaskName ${ps(TASK_NAME)}`,
  ].join('\n')
}

export function unregisterScript(t: ServiceTarget): string {
  return [
    findTask,
    'if ($task) {',
    ...stopRunning(t),
    `Unregister-ScheduledTask -TaskName ${ps(TASK_NAME)} -Confirm:$false`,
    '}',
  ].join('\n')
}

async function powershell(script: string): Promise<void> {
  if (process.platform !== 'win32') fail('DR101', { path: 'service', reason: 'service install needs Windows' })
  const args = ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'\n${script}`]
  try {
    await run('powershell', args, { windowsHide: true })
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim()
    throw new Error(stderr || (err as Error).message)
  }
}

export async function installService(): Promise<ServiceTarget> {
  const target = await serviceTarget()
  await powershell(registerScript(target))
  return target
}

export async function uninstallService(): Promise<void> {
  await powershell(unregisterScript(await serviceTarget()))
}
