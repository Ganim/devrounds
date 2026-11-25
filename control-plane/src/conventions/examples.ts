import type { Issue } from '../yaml-file.ts'
import type { RuleFile } from './file.ts'

// Kept out of file.ts and free of run-time imports so examples-worker.ts starts in milliseconds: the worker's
// budget runs from the moment it is online, and loading TypeBox and the YAML parser there would eat into it.

/**
 * A pattern rule tests itself (design call 11): every bad example is a violation and no good one is. Runs the
 * document's own regexes, which can backtrack for minutes: the control plane calls it through examples-check.ts, off
 * its event loop. Expects a rule that passed findConventionsShapeIssue (file.ts).
 */
export function patternExamplesIssue(at: string, rule: RuleFile): Issue | null {
  if (rule.check.kind !== 'pattern') return null
  const flags = rule.check.flags ?? ''
  const forbid = new RegExp(rule.check.forbid, flags)
  const unless = rule.check.unless === undefined ? null : new RegExp(rule.check.unless, flags)
  for (const [j, line] of (rule.examples?.bad ?? []).entries()) {
    if (!forbid.test(line)) return { path: `${at}/examples/bad/${j}`, reason: 'does not match forbid' }
    if (unless?.test(line)) return { path: `${at}/examples/bad/${j}`, reason: 'matches unless' }
  }
  for (const [j, line] of (rule.examples?.good ?? []).entries()) {
    if (forbid.test(line) && !unless?.test(line)) {
      return { path: `${at}/examples/good/${j}`, reason: 'matches forbid' }
    }
  }
  return null
}
