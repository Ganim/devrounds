import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// True when the file at `moduleUrl` is the script node was started with. Both sides go through realpath: the
// `npm link` bins run the file through a symlinked folder, and on Windows `c:\…` and `C:\…` name the same file
// while import.meta.url keeps whatever case the caller typed.
export async function isMain(moduleUrl: string): Promise<boolean> {
  const script = process.argv[1]
  if (!script) return false
  const [self, started] = await Promise.all([realpath(fileURLToPath(moduleUrl)), realpath(script)])
  return self === started
}
