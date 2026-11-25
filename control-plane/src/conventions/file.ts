import { createHash } from 'node:crypto'
import { type Static, type TSchema, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { type Issue, parseYamlFile } from '../yaml-file.ts'
import { patternExamplesIssue } from './examples.ts'
import { expandBraces, MAX_GLOB_ALTERNATIVES } from './select.ts'

// A project's conventions document (design §3): YAML for `devrounds conventions propose`, JSON in the API. A version
// stores it as given; readers use parseConventionsFile's def, with every default filled.
const ItemKey = Type.String({ pattern: '^[a-z0-9][a-z0-9.-]{0,99}$' })
// Section and title render as a heading and the start of a line (render.ts), so neither may break a line.
const SINGLE_LINE = '^[^\\r\\n]*$'
const Section = Type.String({ minLength: 1, maxLength: 100, pattern: SINGLE_LINE })
// A POSIX path relative to the repo root; findConventionsIssue refuses `\`, absolute paths and `.`/`..` segments, in
// globs too.
const RepoPath = Type.String({ minLength: 1, maxLength: 500 })
const Glob = Type.String({ minLength: 1, maxLength: 500 })
const Globs = Type.Array(Glob, { maxItems: 100 })
const Regex = Type.String({ minLength: 1, maxLength: 1000 })
// No `g` or `y`: a RegExp with either keeps `lastIndex` between test() calls, so one line's match shifts the next.
const Flags = Type.String({ pattern: '^[imsu]{0,4}$' })

const Evidence = Type.Object(
  {
    path: RepoPath,
    excerpt: Type.String({ minLength: 1, maxLength: 300 }),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    role: Type.Union([Type.Literal('source'), Type.Literal('example')]),
  },
  { additionalProperties: false },
)
const EvidenceList = Type.Array(Evidence, { minItems: 1, maxItems: 20 })

const PatternCheck = Type.Object(
  { kind: Type.Literal('pattern'), forbid: Regex, unless: Type.Optional(Regex), flags: Type.Optional(Flags) },
  { additionalProperties: false },
)
const PathCheck = Type.Object({ kind: Type.Literal('path'), forbid_new: Glob }, { additionalProperties: false })
const JobTypeCheck = Type.Object(
  { kind: Type.Literal('job_type'), enforced_by: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
)
const JudgmentCheck = Type.Object({ kind: Type.Literal('judgment') }, { additionalProperties: false })
const CHECKS: Record<string, TSchema> = {
  pattern: PatternCheck,
  path: PathCheck,
  job_type: JobTypeCheck,
  judgment: JudgmentCheck,
}

// One line each: the checker matches added lines one at a time, so a multi-line example could pass the rule's
// self-test with a pattern that never fires on a diff.
const Example = Type.String({ maxLength: 1000, pattern: SINGLE_LINE })
const Examples = Type.Object(
  {
    bad: Type.Optional(Type.Array(Example, { maxItems: 20 })),
    good: Type.Optional(Type.Array(Example, { maxItems: 20 })),
  },
  { additionalProperties: false },
)

const Rule = Type.Object(
  {
    key: ItemKey,
    section: Section,
    title: Type.String({ minLength: 1, maxLength: 200, pattern: SINGLE_LINE }),
    why: Type.String({ minLength: 1, maxLength: 1000 }),
    target: Type.Optional(RepoPath),
    // Files the rule applies to; none means every file (judgment rules are often repo-wide).
    paths: Type.Optional(Globs),
    exclude: Type.Optional(Globs),
    check: Type.Union([PatternCheck, PathCheck, JobTypeCheck, JudgmentCheck]),
    severity: Type.Optional(Type.Union([Type.Literal('warn'), Type.Literal('block')])),
    examples: Type.Optional(Examples),
    evidence: EvidenceList,
  },
  { additionalProperties: false },
)

const Fact = Type.Object(
  {
    key: ItemKey,
    section: Section,
    text: Type.String({ minLength: 1, maxLength: 1000 }),
    target: Type.Optional(RepoPath),
    evidence: EvidenceList,
  },
  { additionalProperties: false },
)

export const ConventionsFile = Type.Object(
  {
    // Files that carry a generated block, in render order.
    targets: Type.Array(Type.Object({ path: RepoPath }, { additionalProperties: false }), {
      minItems: 1,
      maxItems: 20,
    }),
    rules: Type.Array(Rule, { maxItems: 500 }),
    facts: Type.Optional(Type.Array(Fact, { maxItems: 200 })),
  },
  { additionalProperties: false },
)

export type ConventionsFile = Static<typeof ConventionsFile>
export type RuleFile = Static<typeof Rule>
type FactFile = Static<typeof Fact>
export type Evidence = Static<typeof Evidence>
export type ConventionCheck = RuleFile['check']

export type ConventionRule = Omit<RuleFile, 'severity' | 'target' | 'paths' | 'exclude'> & {
  severity: 'warn' | 'block'
  target: string
  paths: string[]
  exclude: string[]
}
export type ConventionFact = Omit<FactFile, 'target'> & { target: string }

/** A conventions document with every default filled in. */
export type ConventionsDef = { targets: { path: string }[]; rules: ConventionRule[]; facts: ConventionFact[] }

const MAX_DOCUMENT_BYTES = 1024 * 1024

// TypeBox reports a failed union as "Expected union value" at the union itself; checking the variant the `kind`
// names gives the field that is actually wrong (e.g. /rules/0/check/flags).
function schemaIssue(value: unknown): Issue | null {
  const first = Value.Errors(ConventionsFile, value).First()
  if (!first) return null
  const check = first.value as { kind?: unknown } | null
  if (/^\/rules\/\d+\/check$/.test(first.path) && typeof check === 'object' && check !== null) {
    const kind = check.kind
    const variant = typeof kind === 'string' && Object.hasOwn(CHECKS, kind) ? CHECKS[kind] : undefined
    if (!variant) return { path: `${first.path}/kind`, reason: `expected one of ${Object.keys(CHECKS).join(', ')}` }
    const inner = Value.Errors(variant, check).First()
    if (inner) return { path: `${first.path}${inner.path}`, reason: inner.message }
  }
  return { path: first.path || '/', reason: first.message }
}

function repoPathIssue(path: string): string | null {
  if (path.includes('\\')) return 'use / as the separator'
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'a path relative to the repo root'
  // On Windows `x::$INDEX_ALLOCATION` names the directory x, so a `:` past the drive reaches what the name hides.
  if (path.includes(':')) return 'no :'
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return 'no empty, . or .. segment'
  }
  return null
}

/**
 * Why `path` cannot be a target, or null. `render` writes there, so on top of a repo path it may not enter `.git`
 * (a hook is run by the shell); case-insensitive, as on Windows. Windows also reaches `.git` by its 8.3 name (`GIT~1`)
 * and drops a trailing dot or space (`.git.`), so those segments are refused too, as git does on NTFS. The CLI checks
 * the targets it receives again.
 */
export function targetPathIssue(path: string): string | null {
  const issue = repoPathIssue(path)
  if (issue) return issue
  const parts = path.split('/')
  if (parts.some((part) => /[. ]$/.test(part))) return 'no segment ending in . or a space'
  return parts.some((part) => part.toLowerCase() === '.git' || /^git~\d+$/i.test(part)) ? 'no .git segment' : null
}

function evidenceIssue(at: string, evidence: Evidence[]): Issue | null {
  for (const [i, item] of evidence.entries()) {
    const reason = repoPathIssue(item.path)
    if (reason) return { path: `${at}/evidence/${i}/path`, reason }
  }
  return null
}

function compile(at: string, source: string, flags: string): RegExp | Issue {
  try {
    return new RegExp(source, flags)
  } catch (err) {
    return { path: at, reason: (err as Error).message }
  }
}

// A pattern rule needs paths and a bad example, and its regexes must compile. Cheap at any size, unlike running them
// (patternExamplesIssue).
function patternShapeIssue(at: string, rule: RuleFile, check: Static<typeof PatternCheck>): Issue | null {
  if (!rule.paths?.length) return { path: `${at}/paths`, reason: 'a pattern rule needs paths' }
  if (!rule.examples?.bad?.length) {
    return { path: `${at}/examples/bad`, reason: 'a pattern rule needs at least one bad example' }
  }
  const flags = check.flags ?? ''
  if (new Set(flags).size !== flags.length) return { path: `${at}/check/flags`, reason: 'a flag appears twice' }
  const forbid = compile(`${at}/check/forbid`, check.forbid, flags)
  if (!(forbid instanceof RegExp)) return forbid
  const unless = check.unless === undefined ? null : compile(`${at}/check/unless`, check.unless, flags)
  return unless !== null && !(unless instanceof RegExp) ? unless : null
}

/**
 * Schema first, then what a schema cannot say: the size cap, repo-relative paths, unique targets and keys (rules and
 * facts share one key space), targets named in `targets`, and pattern rules that compile. Everything but running the
 * examples (patternExamplesIssue).
 */
export function findConventionsShapeIssue(value: unknown): Issue | null {
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? '')
  } catch {
    // A YAML alias that contains itself parses to a cyclic object.
    return { path: '/', reason: 'an alias refers to itself' }
  }
  if (bytes > MAX_DOCUMENT_BYTES) return { path: '/', reason: 'the document is over 1 MB' }
  const schema = schemaIssue(value)
  if (schema) return schema
  const file = value as ConventionsFile
  const targets = new Set<string>()
  // Case-insensitive: on Windows `AGENTS.md` and `agents.md` are one file, which would get two generated blocks.
  const folded = new Set<string>()
  for (const [i, { path }] of file.targets.entries()) {
    const reason = targetPathIssue(path) ?? (folded.has(path.toLowerCase()) ? 'duplicate target' : null)
    if (reason) return { path: `/targets/${i}/path`, reason }
    targets.add(path)
    folded.add(path.toLowerCase())
  }
  const keys = new Map<string, string>()
  const items = [
    ...file.rules.map((item, i) => ({ at: `/rules/${i}`, item })),
    ...(file.facts ?? []).map((item, i) => ({ at: `/facts/${i}`, item })),
  ]
  for (const { at, item } of items) {
    const seen = keys.get(item.key)
    if (seen !== undefined) return { path: `${at}/key`, reason: `duplicate key (also ${seen}/key)` }
    keys.set(item.key, at)
    if (item.target !== undefined && !targets.has(item.target)) {
      return { path: `${at}/target`, reason: 'not in targets' }
    }
    const evidence = evidenceIssue(at, item.evidence)
    if (evidence) return evidence
  }
  for (const [i, rule] of file.rules.entries()) {
    const issue =
      globsIssue(`/rules/${i}`, rule) ??
      (rule.check.kind === 'pattern' ? patternShapeIssue(`/rules/${i}`, rule, rule.check) : null)
    if (issue) return issue
  }
  return null
}

// The rule matcher (select.ts matchesGlob) has no `{n..m}` ranges, and node's matcher, which others may run on the
// same globs, expands them (43 s on `{1..2000000}`); a few literal alternatives cover real rules. The matcher expands
// braces and tries each alternative, so their number is capped too. More than 3 `*` in one segment backtracks
// polynomially on a long path segment (`*a*a*a*a*b` took 13 s on 200 characters); real globs use one or two.
export function globIssue(glob: string): string | null {
  if (/\{[^}]*\.\.[^}]*\}/.test(glob)) return 'no {n..m} ranges'
  if ((glob.match(/\{/g)?.length ?? 0) > 4) return 'at most 4 brace groups'
  const alternatives = expandBraces(glob)
  if (alternatives === null) return `at most ${MAX_GLOB_ALTERNATIVES} alternatives once braces are expanded`
  const stars = (segment: string) => segment.match(/\*/g)?.length ?? 0
  if (alternatives.some((alt) => alt.split('/').some((segment) => stars(segment) > 3))) {
    return 'at most 3 * in one segment'
  }
  return repoPathIssue(glob)
}

// Globs match repo-relative POSIX diff paths, so one written like a Windows or absolute path would never match.
function globsIssue(at: string, rule: RuleFile): Issue | null {
  for (const field of ['paths', 'exclude'] as const) {
    for (const [i, glob] of (rule[field] ?? []).entries()) {
      const reason = globIssue(glob)
      if (reason) return { path: `${at}/${field}/${i}`, reason }
    }
  }
  if (rule.check.kind === 'path') {
    const reason = globIssue(rule.check.forbid_new)
    if (reason) return { path: `${at}/check/forbid_new`, reason }
  }
  return null
}

/** findConventionsShapeIssue, then each pattern rule's examples, on this thread: for the CLI, which runs the caller's own
 * document in the caller's own process. */
export function findConventionsIssue(value: unknown): Issue | null {
  const shape = findConventionsShapeIssue(value)
  if (shape) return shape
  for (const [i, rule] of (value as ConventionsFile).rules.entries()) {
    const issue = patternExamplesIssue(`/rules/${i}`, rule)
    if (issue) return issue
  }
  return null
}

export function withDefaults(file: ConventionsFile): ConventionsDef {
  const target = file.targets[0].path
  return {
    targets: file.targets,
    rules: file.rules.map((rule) => ({
      ...rule,
      severity: rule.severity ?? 'warn',
      target: rule.target ?? target,
      paths: rule.paths ?? [],
      exclude: rule.exclude ?? [],
    })),
    facts: (file.facts ?? []).map((fact) => ({ ...fact, target: fact.target ?? target })),
  }
}

/** Parses a conventions file; the first problem is DR101 with its path (e.g. `/rules/0/examples/bad/0`). */
export function parseConventionsFile(text: string): ConventionsDef {
  return withDefaults(parseYamlFile<ConventionsFile>(text, findConventionsIssue))
}

// JSON with keys sorted at every level. Kept here rather than shared with api/idempotency.ts so this module stays free
// of the server's imports: the CLI reads documents in the worktree (render, check, verify).
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** SHA-256 (hex) of the def's canonical JSON: the same document with keys in another order has the same sha. */
export function documentSha(def: ConventionsDef): string {
  return createHash('sha256').update(canonical(def)).digest('hex')
}
