import type { ConventionRule, ConventionsDef } from './file.ts'

const SPECIAL = /[.+^$()|\\]/

// A rule glob as a RegExp: `*` and `?` within a segment, `**` as a whole segment for any number of them, `[...]`
// (`[!...]` negated) and `{a,b}`; anything else is literal. Unlike node's path.matchesGlob, `*` and `**` enter dot
// segments (`**/*.ts` covers `.github/x.ts`: a rule that skipped `.github` or `.agents` would let their files pass
// silently) and matching is case-sensitive on every OS (Windows matched `src/A.TS` against `**/*.ts`), so a change
// gets the same answer on every machine. A `{` without its `}` is literal.
function globRegExp(glob: string): RegExp {
  let depth = 0
  let balanced = true
  for (const ch of glob) {
    depth += ch === '{' ? 1 : ch === '}' ? -1 : 0
    if (depth < 0) balanced = false
  }
  balanced &&= depth === 0
  let out = ''
  depth = 0
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*' && (i === 0 || glob[i - 1] === '/')) {
      const after = glob[i + 2]
      if (after === undefined) {
        out += '.*'
        i += 1
        continue
      }
      if (after === '/') {
        out += '(?:[^/]+/)*'
        i += 2
        continue
      }
    }
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else if (ch === '[') {
      // `]` right after `[` (or `[!`) is part of the class.
      const start = glob[i + 1] === '!' ? i + 2 : i + 1
      const close = glob.indexOf(']', start + 1)
      if (close < 0) out += '\\['
      else {
        const body = glob.slice(start, close).replace(/[\\^\]]/g, '\\$&')
        out += `[${glob[i + 1] === '!' ? '^' : ''}${body}]`
        i = close
      }
    } else if (balanced && ch === '{') {
      out += '(?:'
      depth += 1
    } else if (balanced && ch === '}') {
      out += ')'
      depth -= 1
    } else if (balanced && ch === ',' && depth > 0) out += '|'
    else out += SPECIAL.test(ch) || ch === '{' || ch === '}' ? `\\${ch}` : ch
  }
  return new RegExp(`^${out}$`)
}

const compiled = new Map<string, RegExp>()

/** Whether the repo path `path` matches the rule glob `glob` (see globRegExp for the syntax and why not node's). */
export function matchesGlob(path: string, glob: string): boolean {
  let re = compiled.get(glob)
  if (!re) {
    re = globRegExp(glob)
    compiled.set(glob, re)
  }
  return re.test(path)
}

/** Whether `rule` covers the repo path `path`: matched by one of its `paths` (none means every file), and by no `exclude`. */
export function ruleCovers(rule: ConventionRule, path: string): boolean {
  const matches = (glob: string) => matchesGlob(path, glob)
  return (rule.paths.length === 0 || rule.paths.some(matches)) && !rule.exclude.some(matches)
}

// Blocking rules first, then warn, then judgment (plan call 5): what an agent must not break comes first.
const rank = (rule: ConventionRule) => (rule.check.kind === 'judgment' ? 2 : rule.severity === 'block' ? 0 : 1)

/** The rules that cover any of `paths` (every rule for none), blocking first, then warn, then judgment, stable. */
export function rulesFor(def: ConventionsDef, paths: string[] | undefined): ConventionRule[] {
  const rules = paths === undefined ? def.rules : def.rules.filter((rule) => paths.some((p) => ruleCovers(rule, p)))
  return [...rules].sort((a, b) => rank(a) - rank(b))
}
