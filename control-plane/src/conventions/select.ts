import type { ConventionRule, ConventionsDef } from './file.ts'

const SPECIAL = /[.+^$()|\\{}]/

/** Alternatives one rule glob may expand to (file.ts refuses more): each is compiled and tried, so this bounds the cost. */
export const MAX_GLOB_ALTERNATIVES = 32

// The index of the `]` closing the class that opens at `glob[i]`, or -1 for a literal `[`. A `]` right after `[` (or
// `[!`) is part of the class.
function classEnd(glob: string, i: number): number {
  const start = glob[i + 1] === '!' ? i + 2 : i + 1
  return glob.indexOf(']', start + 1)
}

// The `}` that closes the `{` at `glob[open]` and the top-level commas between them, or null when nothing closes it.
function braceGroup(glob: string, open: number): { close: number; commas: number[] } | null {
  let depth = 0
  const commas: number[] = []
  for (let i = open; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '[') {
      const close = classEnd(glob, i)
      if (close > 0) i = close
    } else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { close: i, commas }
    } else if (ch === ',' && depth === 1) commas.push(i)
  }
  return null
}

/**
 * The brace-free globs `glob` stands for (`{web/**,api/**}` is `web/**` and `api/**`), or null past `limit` of them. A
 * `{` without its `}` is literal. Expanding before compiling keeps one code path for `**`: inside braces it is still a
 * whole segment of each alternative, so `{web/**,api/**}` reaches `web/a/b.ts`.
 */
export function expandBraces(glob: string, limit = MAX_GLOB_ALTERNATIVES): string[] | null {
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '[') {
      const close = classEnd(glob, i)
      if (close > 0) i = close
      continue
    }
    const group = glob[i] === '{' ? braceGroup(glob, i) : null
    if (!group) continue
    const bounds = [i, ...group.commas, group.close]
    const out: string[] = []
    for (let k = 0; k + 1 < bounds.length; k++) {
      const alternative = glob.slice(0, i) + glob.slice(bounds[k] + 1, bounds[k + 1]) + glob.slice(group.close + 1)
      const expanded = expandBraces(alternative, limit - out.length)
      if (expanded === null) return null
      out.push(...expanded)
    }
    return out
  }
  return limit < 1 ? null : [glob]
}

// One brace-free glob as a regex source: `*` and `?` within a segment, `**` as a whole segment for any number of them,
// `[...]` (`[!...]` negated); anything else is literal.
function alternativeSource(glob: string): string {
  let out = ''
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
      const close = classEnd(glob, i)
      if (close < 0) out += '\\['
      else {
        const start = glob[i + 1] === '!' ? i + 2 : i + 1
        const body = glob.slice(start, close).replace(/[\\^\]]/g, '\\$&')
        out += `[${glob[i + 1] === '!' ? '^' : ''}${body}]`
        i = close
      }
    } else out += SPECIAL.test(ch) ? `\\${ch}` : ch
  }
  return out
}

// A rule glob as a RegExp: one alternative per brace expansion (expandBraces). Unlike node's path.matchesGlob, `*` and
// `**` enter dot segments (`**/*.ts` covers `.github/x.ts`: a rule that skipped `.github` or `.agents` would let their
// files pass silently) and matching is case-sensitive on every OS (Windows matched `src/A.TS` against `**/*.ts`), so a
// change gets the same answer on every machine. A glob past MAX_GLOB_ALTERNATIVES, which file.ts refuses in a document
// and the CLI in `--glob`, matches nothing rather than expanding without bound.
function globRegExp(glob: string): RegExp {
  const alternatives = expandBraces(glob)
  if (alternatives === null) return /(?!)/
  return new RegExp(`^(?:${alternatives.map(alternativeSource).join('|')})$`)
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
