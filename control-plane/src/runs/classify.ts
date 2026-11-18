import type { FailureClass } from '../db/schema.ts'

// Classes a job type rule may name. cancelled and unclassified only come from the run itself.
export const RULE_CLASSES = ['check_red', 'environment', 'timeout', 'memory', 'infra'] as const
export type RuleClass = (typeof RULE_CLASSES)[number]

/** One job type rule; with both conditions given, both must match. */
export type ClassifyRule = { class: RuleClass; exit_codes?: number[]; log_pattern?: string }

export type ClassifyInput = {
  reason: 'exited' | 'stopped' | 'timeout' | 'spawn_failed' | 'infra'
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

export function classifyRun(input: ClassifyInput, rules: ClassifyRule[]): Classification {
  const failed = (failureClass: FailureClass, rule?: ClassifyRule): Classification => ({
    state: failureClass === 'cancelled' ? 'stopped' : 'failed',
    failureClass,
    failureSummary: summarize(input, rule?.log_pattern),
  })
  if (input.reason === 'stopped') return failed('cancelled')
  if (input.reason === 'timeout') return failed('timeout')
  if (input.reason === 'spawn_failed') return failed('environment')
  if (input.reason === 'infra') return failed('infra')
  if (input.exitCode === 0) return { state: 'finished', failureClass: null, failureSummary: null }
  if (input.exitCode === STATUS_NO_MEMORY || input.exitCode === STATUS_COMMITMENT_LIMIT) return failed('memory')
  const rule = rules.find((r) => matches(r, input))
  return rule ? failed(rule.class, rule) : failed('unclassified')
}

function matches(rule: ClassifyRule, input: ClassifyInput): boolean {
  if (rule.exit_codes && (input.exitCode === null || !rule.exit_codes.includes(input.exitCode))) return false
  if (rule.log_pattern !== undefined) {
    const pattern = new RegExp(rule.log_pattern)
    if (!input.tail.some((line) => pattern.test(line))) return false
  }
  return true
}

// The matched rule's lines first (the cause, as the job type author knows it), else the executor's summary, else the
// end of the output. Tail lines are cut from the front so the last lines, where failures usually print, survive.
function summarize(input: ClassifyInput, logPattern: string | undefined): string | null {
  if (logPattern !== undefined) {
    const pattern = new RegExp(logPattern)
    const lines = input.tail.filter((line) => pattern.test(line)).slice(0, SUMMARY_LINES)
    return fit(lines, 'head')
  }
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
