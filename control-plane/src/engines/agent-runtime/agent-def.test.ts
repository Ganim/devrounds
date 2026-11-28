import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevRoundsError } from '../../errors/error.ts'
import { parseJobTypeFile } from '../../job-types/file.ts'
import { claudeCode } from '../../providers/claude-code/provider.ts'
import { checkManifest } from '../manifest.ts'
import { AGENT_RUNTIME_CONTRACT, AGENT_RUNTIME_ENGINE } from './contract.ts'
import { renderPrompt } from './prompt.ts'

const issueAt = (path: string) => (err: unknown) =>
  err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === path

const file = (agent: string) => `key: work\nagent:\n${agent.replace(/^/gm, '  ')}\n`

test('an agent block gets its defaults and its program from the runtime; what the schema cannot say is DR101', () => {
  const def = parseJobTypeFile(file('runtime: claude-code\nprompt: "Do {{job.args.0}}"\nresult: { kind: text }'))
  assert.equal(def.command.program, 'claude')
  assert.equal(def.orphan_policy, 'let_finish')
  assert.deepEqual(def.agent?.resume, { max: 2 })

  const bad: [string, string][] = [
    ['runtime: nope\nprompt: x\nresult: { kind: text }', '/agent/runtime'],
    ['runtime: claude-code\nprompt: "{{job.cwd}}"\nresult: { kind: text }', '/agent/prompt'],
    ['runtime: claude-code\nprompt: x\nresult: { kind: reported }', '/agent/result/done'],
    ['runtime: claude-code\nprompt: x\nresult: { kind: text, done: [ok] }', '/agent/result'],
    ['runtime: claude-code\nprompt: x\nresult: { kind: reported, done: [ok], park: [ok] }', '/agent/result/park'],
    ['runtime: claude-code\nprompt: x\npermission_mode: yolo\nresult: { kind: text }', '/agent/permission_mode'],
  ]
  for (const [agent, path] of bad) assert.throws(() => parseJobTypeFile(file(agent)), issueAt(path), agent)
  // Neither a command nor an agent.
  assert.throws(
    () => parseJobTypeFile('key: work\n'),
    (err: unknown) => err instanceof DevRoundsError,
  )
})

test('a prompt renders job args and input, and refuses a missing value', () => {
  const values = { args: ['FLOWS-1'], input: { goal: 'ship' } }
  assert.equal(renderPrompt('{{ job.args.0 }} to {{input.goal}}', values), 'FLOWS-1 to ship')
  assert.throws(() => renderPrompt('{{input.other}}', values), issueAt('/input'))
  assert.throws(() => renderPrompt('{{job.args.1}}', values, '/jobs/0'), issueAt('/jobs/0/args'))
})

test('a provider manifest for another engine or contract is DR501', () => {
  assert.equal(checkManifest(claudeCode.manifest, AGENT_RUNTIME_ENGINE, AGENT_RUNTIME_CONTRACT).id, 'claude-code')
  const dr501 = (err: unknown) => err instanceof DevRoundsError && err.code === 'DR501'
  assert.throws(() => checkManifest(claudeCode.manifest, 'browser', AGENT_RUNTIME_CONTRACT), dr501)
  assert.throws(() => checkManifest(claudeCode.manifest, AGENT_RUNTIME_ENGINE, 2), dr501)
  assert.throws(() => checkManifest({ ...claudeCode.manifest, tools: [{ name: 'X' }] }, AGENT_RUNTIME_ENGINE, 1), dr501)
})
