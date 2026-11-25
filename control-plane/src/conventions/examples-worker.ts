import { parentPort, workerData } from 'node:worker_threads'
import { patternExamplesIssue } from './examples.ts'
import type { RuleFile } from './file.ts'

// Runs a document's pattern rules against their examples off the control plane's event loop (examples-check.ts). Posts
// one result per rule, in order, and stops at the first issue, so the parent knows which rule a timeout hit.
const { rules } = workerData as { rules: { at: string; rule: RuleFile }[] }

for (const [index, { at, rule }] of rules.entries()) {
  const issue = patternExamplesIssue(at, rule)
  parentPort?.postMessage({ index, issue })
  if (issue) break
}
