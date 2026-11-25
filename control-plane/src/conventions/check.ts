import { posix } from 'node:path'
import type { ConventionRule, ConventionsDef } from './file.ts'
import type { Drift } from './render.ts'
import { ruleCovers } from './select.ts'
import type { DiffFile } from './unified-diff.ts'

/** One hit of a rule on a change: the added line (pattern) or the new path (path, `line` null). */
export type Violation = {
  rule: string
  severity: 'warn' | 'block'
  path: string
  line: number | null
  excerpt: string
}

const EXCERPT_CHARS = 200

const excerptOf = (text: string) => [...text.trim()].slice(0, EXCERPT_CHARS).join('')

// A new path the rule refuses: matched by forbid_new and covered by the rule's paths/exclude.
function refused(rule: ConventionRule, glob: string, path: string): boolean {
  return posix.matchesGlob(path, glob) && ruleCovers(rule, path)
}

/**
 * The violations of `files` (a parsed diff) against `def` (design calls 8-9): `pattern` rules on the added lines of
 * covered files that are neither deleted nor binary, `path` rules on new files and on renames into the glob. `job_type`
 * and `judgment` rules are checked elsewhere. In file, then line, then rule order.
 *
 * Runs the document's regexes on this thread: the CLI checks a change in the caller's own process. The control plane
 * must not call it (examples-check.ts is how it runs member regexes).
 */
export function checkChange(def: ConventionsDef, files: DiffFile[]): Violation[] {
  const patterns = def.rules.flatMap((rule) => {
    if (rule.check.kind !== 'pattern') return []
    const flags = rule.check.flags ?? ''
    const unless = rule.check.unless === undefined ? null : new RegExp(rule.check.unless, flags)
    return [{ rule, forbid: new RegExp(rule.check.forbid, flags), unless }]
  })
  const violations: Violation[] = []
  for (const file of files) {
    if (file.status === 'deleted') continue
    for (const rule of def.rules) {
      if (rule.check.kind !== 'path') continue
      const glob = rule.check.forbid_new
      const isNew =
        file.status === 'added' ||
        (file.status === 'renamed' && file.oldPath !== null && !refused(rule, glob, file.oldPath))
      if (isNew && refused(rule, glob, file.path)) {
        violations.push({
          rule: rule.key,
          severity: rule.severity,
          path: file.path,
          line: null,
          excerpt: excerptOf(file.path),
        })
      }
    }
    if (file.binary) continue
    const covering = patterns.filter((p) => ruleCovers(p.rule, file.path))
    for (const added of file.added) {
      for (const { rule, forbid, unless } of covering) {
        if (forbid.test(added.text) && !unless?.test(added.text)) {
          violations.push({
            rule: rule.key,
            severity: rule.severity,
            path: file.path,
            line: added.line,
            excerpt: excerptOf(added.text),
          })
        }
      }
    }
  }
  return violations
}

/** The rule name of a target whose generated block differs from the active version's render (always blocking). */
export const DOCS_DRIFT = 'docs_drift'

/** Drift (render.ts) as blocking violations, the reason as excerpt, so the check reports and counts it with the rest. */
export function driftViolations(drift: Drift[]): Violation[] {
  return drift.map((d) => ({ rule: DOCS_DRIFT, severity: 'block', path: d.path, line: null, excerpt: d.reason }))
}
