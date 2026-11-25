import { readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

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
const FENCE = /^\s*(```|~~~)/

// Repo-relative POSIX paths of the markdown files under `cwd`, without following links (a pnpm `node_modules` is
// junctions) or entering SKIPPED_DIRS.
async function markdownFiles(cwd: string, dir = ''): Promise<string[]> {
  const entries = await readdir(join(cwd, dir), { withFileTypes: true })
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
  let fenced = false
  for (const [i, raw] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
    if (FENCE.test(raw)) {
      fenced = !fenced
      continue
    }
    // Code blocks hold commands and examples, not statements.
    if (fenced) continue
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
 */
export async function findCandidates(cwd: string, globs = DEFAULT_CANDIDATE_GLOBS): Promise<Candidate[]> {
  const files = (await markdownFiles(cwd)).filter((file) => globs.some((glob) => posix.matchesGlob(file, glob)))
  files.sort()
  const found: Candidate[] = []
  for (const file of files) found.push(...candidatesOf(file, await readFile(join(cwd, file), 'utf8')))
  return found
}
