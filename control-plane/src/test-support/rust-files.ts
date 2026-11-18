import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXECUTOR = fileURLToPath(new URL('../../../executor/', import.meta.url))

// Every .rs file under dir, skipping Cargo's target directory.
export async function rustFiles(dir: string = EXECUTOR): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'target' ? [] : rustFiles(path)
      return entry.name.endsWith('.rs') ? [path] : []
    }),
  )
  return nested.flat()
}
