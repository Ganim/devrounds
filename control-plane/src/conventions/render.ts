import { createHash } from 'node:crypto'
import type { ConventionCheck, ConventionsDef } from './file.ts'

// The generated part of a target file (design call 6): everything between the two marker lines is DevRounds's, the
// rest stays hand-written. A marker is a whole line, so the markers quoted inside a sentence (README) are not one.
const BEGIN = /^<!-- devrounds:conventions begin version=([1-9][0-9]{0,8}) sha256=([0-9a-f]{16}) -->$/
const END = '<!-- devrounds:conventions end -->'
const MARKER = '<!-- devrounds:conventions '

export type Block = { version: number; sha: string; body: string }

// `stale_block`: a block in a file that is no longer a target (the caller passes the previously active version's
// targets too), so the superseded rules it carries do not stay there looking generated.
export type Drift = {
  path: string
  reason: 'missing_file' | 'missing_block' | 'malformed' | 'different' | 'stale_block'
}

const lf = (text: string) => text.replaceAll('\r\n', '\n')

// An editor may save a UTF-8 BOM before the begin marker of a block that starts the file; it is not part of the line.
const BOM = '\uFEFF'
const splitBom = (text: string) => (text.startsWith(BOM) ? [BOM, text.slice(1)] : ['', text])

const shortSha = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 16)

function suffix(check: ConventionCheck): string {
  if (check.kind === 'pattern' || check.kind === 'path') return ' (checked)'
  if (check.kind === 'job_type') return ` (checked by ${check.enforced_by})`
  return ''
}

// One line per item: YAML block scalars (`why: |`, `>`) end in a newline and may span lines; a line break would split
// the item and could put a marker at the start of a line, which leaves the file malformed.
const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ')

// "Title. Why", without doubling the stop when the title already ends a sentence.
const sentence = (title: string, why: string) => `${title}${/[.!?]$/.test(title) ? '' : '.'} ${oneLine(why)}`

/**
 * Each target's block for `version`: its rules and facts grouped by `section` in first-seen order (rules before facts),
 * one line per item. The header's sha256 is the first 16 hex of the body, so a hand edit shows without the record.
 */
export function renderBlocks(def: ConventionsDef, version: number): Map<string, string> {
  const items = [
    ...def.rules.map((r) => ({
      target: r.target,
      section: r.section,
      line: sentence(r.title, r.why) + suffix(r.check),
    })),
    ...def.facts.map((f) => ({ target: f.target, section: f.section, line: oneLine(f.text) })),
  ]
  const blocks = new Map<string, string>()
  for (const { path } of def.targets) {
    const sections = new Map<string, string[]>()
    for (const item of items.filter((i) => i.target === path)) {
      const lines = sections.get(item.section) ?? []
      lines.push(`- ${item.line}`)
      sections.set(item.section, lines)
    }
    const body = [...sections].map(([section, lines]) => [`### ${section}`, '', ...lines].join('\n')).join('\n\n')
    blocks.set(
      path,
      `<!-- devrounds:conventions begin version=${version} sha256=${shortSha(body)} -->\n${body}\n${END}`,
    )
  }
  return blocks
}

// Indexes of the begin and end lines in `lines` (line endings stripped), null when the file has no marker at all, or
// 'malformed' unless there is exactly one well-formed begin followed by one end.
function locate(lines: string[]): { begin: number; end: number } | null | 'malformed' {
  const markers = lines.flatMap((line, i) => (line.startsWith(MARKER) ? [i] : []))
  if (markers.length === 0) return null
  if (markers.length !== 2) return 'malformed'
  const [begin, end] = markers
  return BEGIN.test(lines[begin]) && lines[end] === END ? { begin, end } : 'malformed'
}

/** The generated block of a file's text (CRLF read as LF), null when it has none, 'malformed' when it is broken. */
export function readBlock(text: string): Block | null | 'malformed' {
  const lines = lf(splitBom(text)[1]).split('\n')
  const at = locate(lines)
  if (at === null || at === 'malformed') return at
  const [, version, sha] = BEGIN.exec(lines[at.begin]) ?? []
  return { version: Number(version), sha, body: lines.slice(at.begin + 1, at.end).join('\n') }
}

/**
 * `text` with its block replaced by `block` (LF), or with `block` appended after a blank line when it has none.
 * Written with the file's own line ending; every byte outside the block stays as it was. A malformed block throws:
 * the caller reports it with the path (readBlock first).
 */
export function applyBlock(file: string, block: string): string {
  const [bom, text] = splitBom(file)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const generated = block.split('\n').join(eol)
  // Lines with their own endings, so the text around the block is copied as is.
  const lines = text.split(/(?<=\n)/)
  const at = locate(lines.map((line) => line.replace(/\r?\n$/, '')))
  if (at === 'malformed') throw new Error('malformed conventions block')
  if (at === null) {
    if (text === '') return `${bom}${generated}${eol}`
    return `${bom}${text}${text.endsWith('\n') ? '' : eol}${eol}${generated}${eol}`
  }
  const endLine = lines[at.end]
  const ending = endLine.slice(endLine.replace(/\r?\n$/, '').length)
  return bom + [...lines.slice(0, at.begin), generated, ending, ...lines.slice(at.end + 1)].join('')
}

/**
 * `text` without its block (lines begin..end). When the block ends the file, the blank line applyBlock put before it
 * goes too, so removing an appended block gives the text back. No block: `text` as is; a malformed one throws.
 */
export function removeBlock(file: string): string {
  const [bom, text] = splitBom(file)
  const lines = text.split(/(?<=\n)/)
  const at = locate(lines.map((line) => line.replace(/\r?\n$/, '')))
  if (at === 'malformed') throw new Error('malformed conventions block')
  if (at === null) return file
  const before = lines.slice(0, at.begin)
  const after = lines.slice(at.end + 1)
  if (after.length === 0 && before.length > 1 && /^\r?\n$/.test(before[before.length - 1])) before.pop()
  return bom + [...before, ...after].join('')
}

/**
 * What differs between each target file and the render of `version` (`files`: the target's text, null when it does
 * not exist), in target order. Compared after CRLF → LF, so a CRLF checkout of an untouched render has no drift.
 * A path of `files` that is not a target (a former one) drifts while it still holds a block (`stale_block`, or
 * `malformed` when broken).
 */
export function driftOf(def: ConventionsDef, version: number, files: Map<string, string | null>): Drift[] {
  const drift: Drift[] = []
  for (const [path, expected] of renderBlocks(def, version)) {
    const text = files.get(path) ?? null
    const found = text === null ? null : readBlock(text)
    const want = readBlock(expected) as Block
    const reason =
      text === null
        ? 'missing_file'
        : found === null
          ? 'missing_block'
          : found === 'malformed'
            ? 'malformed'
            : found.version !== want.version || found.sha !== want.sha || found.body !== want.body
              ? 'different'
              : null
    if (reason) drift.push({ path, reason })
  }
  const targets = new Set(def.targets.map((t) => t.path))
  for (const [path, text] of files) {
    if (targets.has(path) || text === null) continue
    const found = readBlock(text)
    if (found !== null) drift.push({ path, reason: found === 'malformed' ? 'malformed' : 'stale_block' })
  }
  return drift
}
