import { Worker } from 'node:worker_threads'
import type { FailureClass } from '../db/schema.ts'

// Classes a job type rule may name. The others only come from the run itself: cancelled (a person stopped it),
// unclassified (no rule matched), and for agent runs stalled (the executor's stall stop), no_outcome (no result
// reported) and limit (the runtime's budget or turn limit; engines/agent-runtime).
export const RULE_CLASSES = ['check_red', 'environment', 'timeout', 'memory', 'infra'] as const
export type RuleClass = (typeof RULE_CLASSES)[number]
export const FAILURE_CLASSES = [
  ...RULE_CLASSES,
  'cancelled',
  'unclassified',
  'stalled',
  'no_outcome',
  'limit',
] as const satisfies FailureClass[]

/** One job type rule; with both conditions given, both must match. */
export type ClassifyRule = { class: RuleClass; exit_codes?: number[]; log_pattern?: string }

export type ClassifyInput = {
  reason: 'exited' | 'stopped' | 'timeout' | 'spawn_failed' | 'infra' | 'stalled'
  exitCode: number | null
  tail: string[]
  // Set by the executor when it knows the cause better than the output does (a spawn failure names the missing piece).
  summary: string | null
}

export type Classification = {
  state: 'finished' | 'failed' | 'stopped'
  failureClass: FailureClass | null
  failureSummary: string | null
}

// Windows NTSTATUS exit codes of a process that ran out of memory or commit, as unsigned 32-bit values.
const STATUS_NO_MEMORY = 3221225495
const STATUS_COMMITMENT_LIMIT = 3221225773
const SUMMARY_LINES = 20
export const SUMMARY_MAX_BYTES = 4096
export const PATTERN_BUDGET_MS = 250
// Lines are cut before matching: backtracking cost grows with line length.
const PATTERN_LINE_MAX_CHARS = 4096

/** Called with the rule index when the pattern budget ran out (or the worker failed) on that rule. */
export type ClassifyOptions = { onPatternTimeout?: (ruleIndex: number) => void }

export async function classifyRun(
  input: ClassifyInput,
  rules: ClassifyRule[],
  options: ClassifyOptions = {},
): Promise<Classification> {
  const failed = (failureClass: FailureClass, matchedLines?: string[]): Classification => ({
    state: failureClass === 'cancelled' ? 'stopped' : 'failed',
    failureClass,
    failureSummary: summarize(input, matchedLines),
  })
  if (input.reason === 'stopped') return failed('cancelled')
  if (input.reason === 'timeout') return failed('timeout')
  if (input.reason === 'stalled') return failed('stalled')
  if (input.reason === 'spawn_failed') return failed('environment')
  if (input.reason === 'infra') return failed('infra')
  if (input.exitCode === 0) return { state: 'finished', failureClass: null, failureSummary: null }
  if (input.exitCode === STATUS_NO_MEMORY || input.exitCode === STATUS_COMMITMENT_LIMIT) return failed('memory')
  const rule = await findRule(input, rules, options)
  return rule ? failed(rule.class, rule.lines) : failed('unclassified')
}

// The first rule whose exit codes match and whose pattern (if any) matches a tail line. The patterns before the first
// rule without one go to a single worker under one budget; when it runs out, the rule it was on and the patterns after
// it count as not matching, and the search goes on with the first rule without a pattern.
async function findRule(
  input: ClassifyInput,
  rules: ClassifyRule[],
  options: ClassifyOptions,
): Promise<{ class: RuleClass; lines?: string[] } | null> {
  const candidates = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => !rule.exit_codes || (input.exitCode !== null && rule.exit_codes.includes(input.exitCode)))
  const firstPlain = candidates.findIndex(({ rule }) => rule.log_pattern === undefined)
  const patterned = firstPlain === -1 ? candidates : candidates.slice(0, firstPlain)
  if (patterned.length > 0) {
    const lines = input.tail.map((line) => line.slice(0, PATTERN_LINE_MAX_CHARS))
    const result = await matchPatterns(
      patterned.map(({ rule }) => rule.log_pattern as string),
      lines,
    )
    if (result.match) return { class: patterned[result.match.index].rule.class, lines: result.match.lines }
    if (result.stoppedAt !== null) options.onPatternTimeout?.(patterned[result.stoppedAt].index)
  }
  return firstPlain === -1 ? null : { class: candidates[firstPlain].rule.class }
}

type PatternResult = { match: { index: number; lines: string[] } | null; stoppedAt: number | null }

// Why a worker: a tenant-written pattern can backtrack for minutes on one line, and on the main thread that would stall
// every tenant. terminate() interrupts the worker mid-match. The budget starts once the worker is online, so a slow
// thread start does not eat it.
function matchPatterns(patterns: string[], lines: string[]): Promise<PatternResult> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./pattern-worker.ts', import.meta.url), {
        workerData: { patterns, lines, limit: SUMMARY_LINES },
      })
    } catch {
      // No thread to start (ERR_WORKER_INIT_FAILED under memory pressure): a worker that failed on the first pattern.
      resolve({ match: null, stoppedAt: 0 })
      return
    }
    let evaluated = 0
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (result: PatternResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(result)
    }
    worker.on('online', () => {
      timer = setTimeout(() => finish({ match: null, stoppedAt: evaluated }), PATTERN_BUDGET_MS)
    })
    worker.on('message', ({ index, matched }: { index: number; matched: string[] }) => {
      evaluated = index + 1
      if (matched.length > 0) finish({ match: { index, lines: matched }, stoppedAt: null })
      else if (evaluated === patterns.length) finish({ match: null, stoppedAt: null })
    })
    // A worker that dies before reporting every pattern is treated like a timeout on the pattern it was on.
    worker.on('error', () => finish({ match: null, stoppedAt: Math.min(evaluated, patterns.length - 1) }))
    worker.on('exit', () => finish({ match: null, stoppedAt: Math.min(evaluated, patterns.length - 1) }))
  })
}

// The matched rule's lines first (the cause, as the job type author knows it), else the executor's summary, else the
// end of the output. Tail lines are cut from the front so the last lines, where failures usually print, survive.
function summarize(input: ClassifyInput, matchedLines: string[] | undefined): string | null {
  if (matchedLines !== undefined) return fit(matchedLines, 'head')
  if (input.summary) return fit(input.summary.split('\n'), 'head')
  return fit(input.tail.slice(-SUMMARY_LINES), 'tail')
}

// Whole lines up to SUMMARY_MAX_BYTES; a single line longer than that is cut at a character boundary.
function fit(lines: string[], keep: 'head' | 'tail'): string | null {
  const ordered = keep === 'head' ? lines : [...lines].reverse()
  const kept: string[] = []
  let bytes = 0
  for (const line of ordered) {
    const size = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0)
    if (bytes + size > SUMMARY_MAX_BYTES) break
    kept.push(line)
    bytes += size
  }
  if (kept.length === 0 && ordered.length > 0) kept.push(cutLine(ordered[0]))
  if (keep === 'tail') kept.reverse()
  return kept.length > 0 ? kept.join('\n') : null
}

function cutLine(line: string): string {
  let out = ''
  let bytes = 0
  for (const char of line) {
    bytes += Buffer.byteLength(char)
    if (bytes > SUMMARY_MAX_BYTES) break
    out += char
  }
  return out
}
