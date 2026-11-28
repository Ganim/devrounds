import assert from 'node:assert/strict'
import { test } from 'node:test'
import { environmentOffer, runEnvironment } from './index.ts'

const WITH = { provider: 'devlanes', mode: 'with' } as const
const command = { program: 'pnpm', args: ['test'] }

test('mode with wraps the command, mode status keeps it, and both send the probe', () => {
  const probe = { program: 'devlanes', args: ['status', '--json'] }
  assert.deepEqual(environmentOffer(WITH, command), {
    command: { program: 'devlanes', args: ['with', '--', 'pnpm', 'test'] },
    probe,
  })
  assert.deepEqual(environmentOffer({ ...WITH, mode: 'status' }, command), { command, probe })
  assert.deepEqual(environmentOffer(null, command), { command })
})

test('a run without a lane says why: no reading, a failed probe, or a cwd outside any lane', () => {
  const none = { provider: 'devlanes', mode: 'with', lane: null }
  assert.deepEqual(runEnvironment(WITH, undefined), {
    ...none,
    probeExitCode: null,
    error: 'the executor read no environment (it predates feature environment)',
  })
  const failed = { output: null, exit_code: null, error: 'devlanes could not start: not found' }
  assert.deepEqual(runEnvironment(WITH, failed), { ...none, probeExitCode: null, error: failed.error })
  // As `devlanes status --json` prints it in a directory without devlanes.yaml.
  const outside = { items: [], here_error: { code: 'no_config', data: { path: 'C:\\work' }, exit_code: 3 } }
  assert.deepEqual(runEnvironment(WITH, { output: outside, exit_code: 0, error: null }), {
    ...none,
    probeExitCode: 0,
    error: 'no lane for this directory (no_config)',
  })
})
