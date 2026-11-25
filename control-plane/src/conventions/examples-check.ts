import { Worker } from 'node:worker_threads'
import type { Issue } from '../yaml-file.ts'
import { type ConventionsFile, findConventionsShapeIssue } from './file.ts'

// For the whole document: a sane one runs every example of 500 rules in a few milliseconds.
export const EXAMPLES_BUDGET_MS = 1000

/**
 * findConventionsIssue for the control plane: the shape on this thread, the examples in a worker under one budget.
 * Why a worker: a member-written pattern can backtrack for minutes on one example, and on the main thread that would
 * stall every tenant (as log patterns, runs/classify.ts). Out of budget, the rule the worker was on is DR101's issue at
 * its forbid. The budget starts once the worker is online, so a slow thread start does not eat it.
 */
export async function findDocumentIssue(value: unknown, budgetMs = EXAMPLES_BUDGET_MS): Promise<Issue | null> {
  const shape = findConventionsShapeIssue(value)
  if (shape) return shape
  const rules = (value as ConventionsFile).rules
    .map((rule, i) => ({ at: `/rules/${i}`, rule }))
    .filter(({ rule }) => rule.check.kind === 'pattern')
  if (rules.length === 0) return null
  return new Promise((resolve) => {
    // A worker that cannot start (ERR_WORKER_INIT_FAILED) throws here, which rejects: an unchecked document is refused.
    const worker = new Worker(new URL('./examples-worker.ts', import.meta.url), { workerData: { rules } })
    let evaluated = 0
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (issue: Issue | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(issue)
    }
    // Out of budget, or a worker that died mid-rule (a regex can overflow the stack): the rule it was on is at fault.
    const stalled = (reason = `the pattern took over ${budgetMs} ms on the examples; make it simpler`) =>
      finish({ path: `${rules[Math.min(evaluated, rules.length - 1)].at}/check/forbid`, reason })
    worker.on('online', () => {
      timer = setTimeout(() => stalled(), budgetMs)
    })
    worker.on('message', ({ index, issue }: { index: number; issue: Issue | null }) => {
      evaluated = index + 1
      if (issue) finish(issue)
      else if (evaluated === rules.length) finish(null)
    })
    worker.on('error', (err) => stalled(`the pattern failed on the examples (${err.message})`))
    worker.on('exit', () => stalled())
  })
}
