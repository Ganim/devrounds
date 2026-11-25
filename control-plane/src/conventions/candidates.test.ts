import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { removeDir } from '../test-support/remove-dir.ts'
import { findCandidates } from './candidates.ts'

const SCRATCH = join(fileURLToPath(new URL('../../../', import.meta.url)), '.superpowers', 'tmp')
let repo: string

before(async () => {
  await mkdir(SCRATCH, { recursive: true })
  repo = await mkdtemp(join(SCRATCH, 'candidates-'))
  const agents = [
    '# Project',
    '',
    'Free text about the layout.',
    '',
    '## Never',
    '',
    '- call sync fs in the server.',
    '- rerun a flaky test; fix it.',
    '',
    '## Layout',
    '',
    '- control-plane/: the server.',
    '- Always write identifiers in English.',
    '',
  ]
  await writeFile(join(repo, 'AGENTS.md'), agents.join('\r\n'))
  await mkdir(join(repo, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(repo, 'node_modules', 'pkg', 'AGENTS.md'), 'Never vendor this.\n')
  await mkdir(join(repo, 'docs'), { recursive: true })
  await writeFile(join(repo, 'docs', 'style.md'), '# Style\n\nYou MUST use LF.\n')
})

after(() => removeDir(repo))

test('bullets under a Never heading are candidates with their heading', async () => {
  assert.deepEqual(await findCandidates(repo), [
    { path: 'AGENTS.md', line: 7, text: '- call sync fs in the server.', heading: 'Never' },
    { path: 'AGENTS.md', line: 8, text: '- rerun a flaky test; fix it.', heading: 'Never' },
    { path: 'AGENTS.md', line: 13, text: '- Always write identifiers in English.', heading: 'Layout' },
  ])
})

test('node_modules is skipped', async () => {
  const found = await findCandidates(repo, ['**/*.md'])
  assert.ok(!found.some((c) => c.path.startsWith('node_modules/')), JSON.stringify(found))
})

test('a custom glob replaces the defaults', async () => {
  assert.deepEqual(await findCandidates(repo, ['docs/**/*.md']), [
    { path: 'docs/style.md', line: 3, text: 'You MUST use LF.', heading: 'Style' },
  ])
})
