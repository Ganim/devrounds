import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Issue } from '../yaml-file.ts'
import type { Evidence } from './file.ts'

// Evidence is checked where the repo is: in the CLI, at `conventions propose --cwd` and `conventions verify`. The
// control plane never reads a repo (design call 1), so it stores what the CLI verified, with the caller's head sha.

/** What evidence verification reads of a document: rules and facts with their keys and evidence. */
export type EvidenceItems = {
  rules: readonly { key: string; evidence: readonly Evidence[] }[]
  facts?: readonly { key: string; evidence: readonly Evidence[] }[]
}

/** An excerpt that still holds but no longer at its recorded `line`; `now` is the line it starts on today. */
export type MovedEvidence = { path: string; key: string; file: string; line: number; now: number }

export type EvidenceIssue = Issue & { key: string }

// Evidence is a source file or doc; past this it is a data file nobody quotes, and reading it would stall the daily job.
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024

// The text of a repo file with CRLF as LF (a Windows checkout of an LF file still holds its excerpts), or why not.
// Every failure is a reason, so one unreadable file stales its own rules instead of failing the whole verify.
async function readRepoText(cwd: string, file: string): Promise<{ text: string } | { reason: string }> {
  try {
    const info = await stat(join(cwd, file))
    if (!info.isFile()) return { reason: 'not a file' }
    if (info.size > MAX_EVIDENCE_BYTES) return { reason: 'over 5 MB' }
    return { text: outsideBlocks((await readFile(join(cwd, file), 'utf8')).replace(/\r\n/g, '\n')) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { reason: 'no such file' }
    return { reason: `cannot be read (${code ?? (err as Error).message})` }
  }
}

// The text with every generated block's lines emptied (line numbers kept). `render` rewrites those lines from the
// record, so an excerpt found there would be the rule quoting itself: never stale, and gone after the next render.
function outsideBlocks(text: string): string {
  let inside = false
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('<!-- devrounds:conventions begin ')) inside = true
      const kept = inside ? '' : line
      if (line.startsWith('<!-- devrounds:conventions end')) inside = false
      return kept
    })
    .join('\n')
}

// 1-based line of a text offset.
function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line += 1
  return line
}

// Whether an occurrence of `excerpt` starts on 1-based `line`.
function startsOnLine(text: string, excerpt: string, line: number): boolean {
  let start = 0
  for (let n = 1; n < line; n += 1) {
    start = text.indexOf('\n', start) + 1
    if (start === 0) return false
  }
  const end = text.indexOf('\n', start)
  const found = text.indexOf(excerpt, start)
  return found !== -1 && (end === -1 || found <= end)
}

/**
 * Every evidence entry of `doc` against the files under `cwd`, each file read once. An excerpt missing from its file,
 * or a missing file, is an issue at the entry's JSON path. The excerpt is the anchor, not the line: one found off its
 * recorded `line` is moved, not an issue.
 */
export async function inspectEvidence(
  cwd: string,
  doc: EvidenceItems,
): Promise<{ issues: EvidenceIssue[]; moved: MovedEvidence[] }> {
  const entries = [
    ...doc.rules.map((item, i) => ({ at: `/rules/${i}`, item })),
    ...(doc.facts ?? []).map((item, i) => ({ at: `/facts/${i}`, item })),
  ].flatMap(({ at, item }) => item.evidence.map((e, j) => ({ path: `${at}/evidence/${j}`, key: item.key, e })))
  const files = [...new Set(entries.map(({ e }) => e.path))]
  // One file at a time: a document can cite hundreds of files, and the reads are cheap next to the job.
  const reads = new Map<string, { text: string } | { reason: string }>()
  for (const file of files) reads.set(file, await readRepoText(cwd, file))
  const issues: EvidenceIssue[] = []
  const moved: MovedEvidence[] = []
  for (const { path, key, e } of entries) {
    const read = reads.get(e.path) as { text: string } | { reason: string }
    if ('reason' in read) {
      issues.push({ path, key, reason: read.reason })
      continue
    }
    const excerpt = e.excerpt.replace(/\r\n/g, '\n')
    const found = read.text.indexOf(excerpt)
    if (found === -1) issues.push({ path, key, reason: `excerpt not found in ${e.path}` })
    else if (e.line !== undefined && !startsOnLine(read.text, excerpt, e.line)) {
      moved.push({ path, key, file: e.path, line: e.line, now: lineOf(read.text, found) })
    }
  }
  return { issues, moved }
}

/** inspectEvidence's issues alone: what `conventions propose --cwd` refuses (the first one, as DR101). */
export async function verifyEvidence(cwd: string, doc: EvidenceItems): Promise<Issue[]> {
  const { issues } = await inspectEvidence(cwd, doc)
  return issues.map(({ path, reason }) => ({ path, reason }))
}
