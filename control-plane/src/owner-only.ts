import { execFile } from 'node:child_process'
import { chmod } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

// For files holding secrets (passwords, API tokens). POSIX gets mode 600; on Windows mode bits do nothing, so icacls
// drops inherited entries and grants only the current user.
export async function restrictToOwner(path: string): Promise<void> {
  if (process.platform !== 'win32') return chmod(path, 0o600)
  const domain = process.env.USERDOMAIN
  const user = domain ? `${domain}\\${userInfo().username}` : userInfo().username
  await run('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`])
}
