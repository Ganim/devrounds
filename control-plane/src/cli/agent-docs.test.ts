import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import { parseCommand } from './commands.ts'

const AGENTS_MD = new URL('../../../AGENTS.md', import.meta.url)

// Agents follow AGENTS.md literally, so a quoted command the CLI no longer knows is a broken instruction.
test('every devrounds command quoted in AGENTS.md parses', async () => {
  const text = await readFile(AGENTS_MD, 'utf8')
  const quoted = [...text.matchAll(/`devrounds ([^`]+)`/g)].map((m) => m[1])
  assert.ok(quoted.length >= 5, `expected the session commands in AGENTS.md, found ${quoted.length}`)
  for (const command of quoted) {
    // An optional part in brackets must parse too: it is checked with the brackets dropped.
    const words = command.replace(/[[\]]/g, '').split(/\s+/)
    assert.doesNotThrow(() => parseCommand(words), `devrounds ${command}`)
  }
  // The check must be able to fail.
  assert.throws(() => parseCommand(['task', 'finish']), DevRoundsError)
  assert.throws(() => parseCommand(['task', 'start', '--bogus']), DevRoundsError)
})
