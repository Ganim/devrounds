import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { matchesGlob } from './select.ts'

// `devrounds conventions candidates`: the lines a repo's instruction files already state as rules, with path:line, so
// an agent following docs/conventions/extract.md starts from what the repo says (design call 14). A heuristic for
// where to look, not a parser: the agent decides what becomes a rule.

export type Candidate = { path: string; line: number; text: string; heading: string }

export const DEFAULT_CANDIDATE_GLOBS = ['**/AGENTS.md', '**/CLAUDE.md', 'README.md']

// Dependencies, build output, VCS data and agent scratch: never the project's own instructions.
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'target', '.superpowers'])

// Case-sensitive on purpose: "never" inside a sentence is prose, "Never ..." and "MUST" are how rules are written.
const IMPERATIVE = /\b(Never|Always|MUST|NEVER|Do not)\b/
// A heading that names a list of rules ("Never", "Always", "Mandatory Rules"): every bullet under it is a candidate.
const RULE_HEADING = /\b(never|always|must|mandatory|do not)\b/i
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*([-*+]|\d+[.)])\s+\S/
const FENCE = /^\s*(`{3,}|~{3,})/

// Repo-relative POSIX paths of the markdown files under `cwd`, without following links (a package manager's
// `node_modules` can be junctions) or entering SKIPPED_DIRS.
async function markdownFiles(cwd: string, dir = ''): Promise<string[]> {
  const entries = await readdir(join(cwd, dir), { withFileTypes: true })
  // A directory with its own `.git` is another checkout (a worktree copy, a submodule): its files are not this repo's,
  // and evidence cited from one passes propose locally and goes stale on a clean checkout.
  if (dir !== '' && entries.some((entry) => entry.name === '.git')) return []
  const found: string[] = []
  for (const entry of entries) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) found.push(...(await markdownFiles(cwd, rel)))
    else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) found.push(rel)
  }
  return found
}

function candidatesOf(path: string, text: string): Candidate[] {
  const found: Candidate[] = []
  // The heading of each level in force; a bullet counts when any of them names rules.
  const headings: string[] = []
  // The open fence (e.g. "````"); CommonMark closes it only with the same character, at least as long.
  let fence = ''
  for (const [i, raw] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
    const marker = FENCE.exec(raw)?.[1]
    if (marker !== undefined) {
      if (fence === '') fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && raw.trim() === marker) fence = ''
      continue
    }
    // Code blocks hold commands and examples, not statements.
    if (fence !== '') continue
    const heading = HEADING.exec(raw)
    if (heading) {
      headings.length = heading[1].length
      headings[heading[1].length - 1] = heading[2]
      continue
    }
    const underRules = headings.some((h) => h !== undefined && RULE_HEADING.test(h))
    if (IMPERATIVE.test(raw) || (underRules && BULLET.test(raw))) {
      found.push({ path, line: i + 1, text: raw.trim(), heading: headings.findLast((h) => h !== undefined) ?? '' })
    }
  }
  return found
}

/**
 * The imperative lines of the markdown files under `cwd` matched by `globs` (repo-relative): lines with Never, Always,
 * MUST, NEVER or Do not, and bullets under a heading named like those. Sorted by path, then line; fenced code skipped.
 * Globs match as rule globs do (select.ts): case-sensitive and into dot directories, so a `**` glob reaches
 * `.agents/skills/` and `.claude/commands/`, where instruction files often live.
 */
export async function findCandidates(cwd: string, globs = DEFAULT_CANDIDATE_GLOBS): Promise<Candidate[]> {
  const files = (await markdownFiles(cwd)).filter((file) => globs.some((glob) => matchesGlob(file, glob)))
  files.sort()
  const found: Candidate[] = []
  for (const file of files) found.push(...candidatesOf(file, await readFile(join(cwd, file), 'utf8')))
  return found
}
