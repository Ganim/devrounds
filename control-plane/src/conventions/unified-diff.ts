// A unified diff (design call 10): the job type produces it, the checker reads only what a change adds. Pure, so the
// format's corners stay testable without a repository: extended headers (`diff --<format> a/<path> b/<path>` with
// new/deleted/rename lines), quoted paths, binary files, `\ No newline at end of file`, and CRLF.

export type AddedLine = { line: number; text: string }

export type DiffFile = {
  // The new path; for a deleted file, the path it had.
  path: string
  // The path before a rename (or copy), else null.
  oldPath: string | null
  status: 'added' | 'modified' | 'renamed' | 'deleted'
  binary: boolean
  // Added lines with their line number in the new file.
  added: AddedLine[]
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

// A C-style quoted path (`"src/caf\303\251 x.ts"`): escapes are bytes of the UTF-8 name. Returns the decoded text and
// what follows the closing quote, or null when the quote never closes.
function unquote(text: string): { value: string; rest: string } | null {
  const bytes: number[] = []
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') return { value: Buffer.from(bytes).toString('utf8'), rest: text.slice(i + 1) }
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1))
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8))
      i += 3
    } else {
      const next = text[i + 1]
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
      i += 1
    }
  }
  return null
}

// The path of a `---`/`+++`/`rename from` line: quoted, or up to the tab some writers put after a name with spaces
// (or before a timestamp). null for /dev/null.
function pathOf(text: string): string | null {
  const path = text.startsWith('"') ? (unquote(text)?.value ?? text) : text.split('\t')[0]
  return path === '/dev/null' ? null : path
}

const strip = (path: string | null, prefix: string) => (path?.startsWith(prefix) ? path.slice(prefix.length) : path)

// `a/<old> b/<new>` of an extended header. Unquoted names with spaces are ambiguous, so this guess serves only files
// without `---`/`+++` lines (binary files, mode changes); the two names are equal unless renamed, which has its own
// lines.
function headerPaths(text: string): { old: string; new: string } | null {
  if (text.startsWith('"')) {
    const old = unquote(text)
    const next = old?.rest.trimStart() ?? ''
    const neu = next.startsWith('"') ? unquote(next)?.value : next
    return old && neu ? { old: old.value, new: neu } : null
  }
  const half = (text.length - 1) / 2
  if (Number.isInteger(half) && text[half] === ' ') return { old: text.slice(0, half), new: text.slice(half + 1) }
  const at = text.indexOf(' b/')
  return at < 0 ? null : { old: text.slice(0, at), new: text.slice(at + 1) }
}

type Draft = {
  header: { old: string; new: string } | null
  minus: string | null | undefined
  plus: string | null | undefined
  renameFrom: string | null
  renameTo: string | null
  copied: boolean
  created: boolean
  deleted: boolean
  binary: boolean
  added: AddedLine[]
}

const draft = (header: Draft['header'] = null): Draft => ({
  header,
  minus: undefined,
  plus: undefined,
  renameFrom: null,
  renameTo: null,
  copied: false,
  created: false,
  deleted: false,
  binary: false,
  added: [],
})

function finish(d: Draft, extended: boolean): DiffFile | null {
  // Prefixes are stripped in pairs, the way a patch applies with one level: a plain diff may name `a/x` itself.
  const prefixed =
    extended || ((d.minus === null || d.minus?.startsWith('a/')) && (d.plus === null || d.plus?.startsWith('b/')))
  const minus = prefixed ? strip(d.minus ?? null, 'a/') : (d.minus ?? null)
  const plus = prefixed ? strip(d.plus ?? null, 'b/') : (d.plus ?? null)
  const header = d.header && { old: strip(d.header.old, 'a/') ?? '', new: strip(d.header.new, 'b/') ?? '' }
  const deleted = d.deleted || (d.plus === null && d.minus !== undefined)
  const created = d.created || (d.minus === null && d.plus !== undefined)
  const oldPath = d.renameFrom ?? minus ?? header?.old ?? null
  const newPath = d.renameTo ?? plus ?? header?.new ?? null
  const path = deleted ? oldPath : newPath
  if (path === null) return null
  const moved = d.renameFrom !== null && d.renameTo !== null
  return {
    path,
    oldPath: moved ? d.renameFrom : null,
    // A copy is a new path, which is what a path rule checks.
    status: deleted ? 'deleted' : created || (moved && d.copied) ? 'added' : moved ? 'renamed' : 'modified',
    binary: d.binary,
    added: deleted ? [] : d.added,
  }
}

/** The files of a unified diff, in order, with the lines each one adds. Unknown lines outside hunks are skipped. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  if (lines.at(-1) === '') lines.pop()
  let current: Draft | null = null
  let extended = false
  const close = () => {
    const file = current && finish(current, extended)
    if (file) files.push(file)
    current = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const header = /^diff --\S+ (.*)$/.exec(line)
    if (header) {
      close()
      extended = true
      current = draft(headerPaths(header[1]))
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && current) {
      // Counted, not scanned: inside a hunk `--- x` is a removed `-- x`, not the next file's header.
      let oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
      let newLeft = hunk[3] === undefined ? 1 : Number(hunk[3])
      let at = Number(hunk[2])
      while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
        const body = lines[i + 1]
        const mark = body[0]
        if (mark === '\\') {
          i++
          continue
        }
        if (mark !== '+' && mark !== '-' && mark !== ' ' && body !== '') break
        i++
        if (mark === '+') {
          current.added.push({ line: at, text: body.slice(1) })
          at++
          newLeft--
        } else if (mark === '-') oldLeft--
        else {
          // A context line; an empty one is a context line whose leading space was trimmed.
          at++
          oldLeft--
          newLeft--
        }
      }
      continue
    }
    if (line.startsWith('--- ')) {
      // A plain diff has no extended header: a `---` after a file's hunks starts the next file.
      if (!current || current.minus !== undefined) {
        close()
        extended = false
        current = draft()
      }
      current.minus = pathOf(line.slice(4))
      continue
    }
    if (!current) continue
    if (line.startsWith('+++ ')) current.plus = pathOf(line.slice(4))
    else if (line.startsWith('new file mode')) current.created = true
    else if (line.startsWith('deleted file mode')) current.deleted = true
    else if (/^(rename|copy) from /.test(line)) {
      current.renameFrom = pathOf(line.replace(/^\S+ from /, ''))
      current.copied = line.startsWith('copy')
    } else if (/^(rename|copy) to /.test(line)) current.renameTo = pathOf(line.replace(/^\S+ to /, ''))
    else if (line.startsWith('Binary files ') || / binary patch$/.test(line)) current.binary = true
  }
  close()
  return files
}
