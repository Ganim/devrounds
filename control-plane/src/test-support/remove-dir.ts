import { rm } from 'node:fs/promises'

// Removes a test's scratch directory. On Windows a file whose access list icacls just changed (`restrictToOwner`)
// is opened by another process right after (on the dev machine, the antivirus); unlinking it while that handle is
// open leaves it delete-pending for about a millisecond, so the rmdir of its parent fails with ENOTEMPTY. By then
// this process holds no handle to it and icacls has exited. The retries (Node waits 100 ms, then 200 ms, ...) let
// that outside handle go.
export function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 5 })
}
