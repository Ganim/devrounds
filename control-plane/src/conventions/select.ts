import { posix } from 'node:path'
import type { ConventionRule, ConventionsDef } from './file.ts'

/** Whether `rule` covers the repo path `path`: matched by one of its `paths` (none means every file), and by no `exclude`. */
export function ruleCovers(rule: ConventionRule, path: string): boolean {
  const matches = (glob: string) => posix.matchesGlob(path, glob)
  return (rule.paths.length === 0 || rule.paths.some(matches)) && !rule.exclude.some(matches)
}

// Blocking rules first, then warn, then judgment (plan call 5): what an agent must not break comes first.
const rank = (rule: ConventionRule) => (rule.check.kind === 'judgment' ? 2 : rule.severity === 'block' ? 0 : 1)

/** The rules that cover any of `paths` (every rule for none), blocking first, then warn, then judgment, stable. */
export function rulesFor(def: ConventionsDef, paths: string[] | undefined): ConventionRule[] {
  const rules = paths === undefined ? def.rules : def.rules.filter((rule) => paths.some((p) => ruleCovers(rule, p)))
  return [...rules].sort((a, b) => rank(a) - rank(b))
}
