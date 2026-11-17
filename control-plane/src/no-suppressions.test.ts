import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SKIP = new Set(['node_modules', '.git', '.superpowers', 'dist'])
const SOURCE = /\.(ts|tsx|js|jsx|json|jsonc|css)$/
// Built by concatenation so this file does not match itself.
const MARKER = `biome-${'ignore'}`

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (SKIP.has(entry.name)) return []
      const path = join(dir, entry.name)
      return entry.isDirectory() ? walk(path) : SOURCE.test(entry.name) ? [path] : []
    }),
  )
  return nested.flat()
}

test('no inline lint suppressions anywhere in the repo', async () => {
  const offenders: string[] = []
  for (const file of await walk(REPO)) {
    if ((await readFile(file, 'utf8')).includes(MARKER)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], 'fix the code instead of suppressing the rule')
})
