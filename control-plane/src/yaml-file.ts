import { isCollection, LineCounter, type Node, parseDocument } from 'yaml'
import { fail } from './errors/error.ts'

export type Issue = { path: string; reason: string }

// The deepest node that exists on the path: a missing property points at the object that should hold it.
function nodeAt(contents: unknown, path: string): Node | null {
  let node = (contents as Node | null) ?? null
  for (const raw of path.split('/').slice(1)) {
    if (!isCollection(node)) break
    const next = node.get(raw.replace(/~1/g, '/').replace(/~0/g, '~'), true) as Node | undefined
    if (!next) break
    node = next
  }
  return node
}

// DR101's words show {path} and {reason}; line and column ride along in the data for the CLI and API, and in the
// reason so the rendered text points at the spot too.
function failAt(path: string, reason: string, lineCounter: LineCounter, offset: number): never {
  const { line, col } = lineCounter.linePos(offset)
  return fail('DR101', { path, reason: `${reason} (line ${line}, column ${col})`, line, column: col })
}

/** DR101 for an issue found after parseYamlFile (by a check it cannot run, e.g. one that reads files), at its position. */
export function failYamlIssue(text: string, issue: Issue): never {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter, prettyErrors: false })
  return failAt(issue.path, issue.reason, lineCounter, nodeAt(doc.contents, issue.path)?.range?.[0] ?? 0)
}

/** Parses a YAML file and checks it with `findIssue`; the first problem is DR101 with its JSON path and position. */
export function parseYamlFile<T>(text: string, findIssue: (value: unknown) => Issue | null): T {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter, prettyErrors: false })
  const syntax = doc.errors[0]
  if (syntax) failAt('/', syntax.message.split('\n')[0], lineCounter, syntax.pos[0])
  const value = doc.toJS()
  const issue = findIssue(value)
  if (issue) failAt(issue.path, issue.reason, lineCounter, nodeAt(doc.contents, issue.path)?.range?.[0] ?? 0)
  return value as T
}
