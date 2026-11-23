import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { BatchJob } from '../jobs/batch-file.ts'
import { type Issue, parseYamlFile } from '../yaml-file.ts'

// A gate file, e.g. `devrounds gate run gate.yaml --cwd <path>`: the repo's checks for one worktree, run as one batch
// (`depends_on` by ref). A check is a batch job without `cwd`, `machine` and `queue`: the gate gives every check its
// cwd and machine (they share a worktree), and the file's `queue` (default `gates`) to all of them.
const Key = Type.String({ minLength: 1, maxLength: 200 })

export const GateCheck = Type.Omit(BatchJob, ['cwd', 'machine', 'queue'], { additionalProperties: false })

export const GateFile = Type.Object(
  {
    key: Key,
    queue: Type.Optional(Key),
    checks: Type.Array(GateCheck, { minItems: 1, maxItems: 200 }),
  },
  { additionalProperties: false },
)

export type GateCheck = Static<typeof GateCheck>
export type GateFile = Static<typeof GateFile>

// The body of `POST /gates`. headSha and dirty are the caller's report of the worktree; DevRounds never reads it.
export const GateInput = Type.Object(
  {
    file: GateFile,
    cwd: Type.String({ minLength: 1, maxLength: 1000 }),
    machine: Type.Optional(Key),
    headSha: Type.Optional(Type.String({ pattern: '^[0-9a-f]{7,64}$' })),
    dirty: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export type GateInput = Static<typeof GateInput>

function findGateIssue(value: unknown): Issue | null {
  const first = Value.Errors(GateFile, value).First()
  return first ? { path: first.path || '/', reason: first.message } : null
}

/** Parses a gate file; the first problem is DR101 with its path (e.g. `/checks/0/job_type`). */
export function parseGateFile(text: string): GateFile {
  return parseYamlFile<GateFile>(text, findGateIssue)
}

/**
 * The worktree lock's key for `cwd`: drive letter lowercased, `/` as `\`, trailing separators removed except the one
 * after `x:`. Only the drive letter folds case: the rest is kept as given, so two spellings that differ in the case
 * of a folder are two keys (the cost is a missed lock, never a gate refused for another worktree).
 */
export function normalizeCwd(cwd: string): string {
  let key = cwd.replace(/\//g, '\\')
  if (/^[A-Za-z]:/.test(key)) key = key[0].toLowerCase() + key.slice(1)
  const root = /^[a-z]:\\/.test(key) ? 3 : 1
  let end = key.length
  while (end > root && key[end - 1] === '\\') end--
  return key.slice(0, end)
}
