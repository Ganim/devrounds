import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { type Issue, parseYamlFile } from '../yaml-file.ts'
import { EVIDENCE } from './service.ts'

// The seed/plan file: position = order in the file. A criterion given as {text, evidence} is checked on import.
// Same cap as the API's key params, so every imported key can be addressed through the API and CLI.
const Key = Type.String({ minLength: 1, maxLength: 200 })
const Text = Type.String({ minLength: 1 })
const Criterion = Type.Union([
  Text,
  Type.Object({ text: Text, evidence: Type.String({ pattern: EVIDENCE.source }) }, { additionalProperties: false }),
])

const PlanFileTask = Type.Object(
  {
    key: Key,
    title: Text,
    description: Type.Optional(Type.String()),
    assignee: Type.Optional(Key),
    estimate_hours: Type.Optional(Type.Number({ minimum: 0 })),
    parent: Type.Optional(Key),
    blocked_by: Type.Optional(Type.Array(Key)),
    criteria: Type.Optional(Type.Array(Criterion)),
    // Omitted = todo. Import never moves a task back to todo (see import.ts).
    state: Type.Optional(
      Type.Union([
        Type.Literal('todo'),
        Type.Literal('in_progress'),
        Type.Literal('blocked'),
        Type.Literal('done'),
        Type.Literal('cancelled'),
      ]),
    ),
    // Required by blocked and cancelled (DR104 on import otherwise).
    reason: Type.Optional(Text),
  },
  { additionalProperties: false },
)

const PlanFilePhase = Type.Object(
  {
    key: Key,
    title: Text,
    // May be empty, like in the API and `devrounds phase add` without --goal; export writes it as "".
    goal: Type.String(),
    state: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('delivered')])),
    blocked_by: Type.Optional(Type.Array(Key)),
    criteria: Type.Optional(Type.Array(Criterion)),
    tasks: Type.Array(PlanFileTask),
  },
  { additionalProperties: false },
)

export const PlanFileSchema = Type.Object(
  {
    project: Type.Object({ key: Key, name: Text }, { additionalProperties: false }),
    phases: Type.Array(PlanFilePhase),
  },
  { additionalProperties: false },
)

export type PlanFile = Static<typeof PlanFileSchema>
export type PlanFileTask = Static<typeof PlanFileTask>
export type PlanFileCriterion = Static<typeof Criterion>

// Schema first, then what a schema cannot say: keys are unique across the file.
export function findIssue(value: unknown): Issue | null {
  const first = Value.Errors(PlanFileSchema, value).First()
  if (first) return { path: first.path || '/', reason: first.message }
  const file = value as PlanFile
  const seen = new Set<string>()
  for (const [p, phase] of file.phases.entries()) {
    if (seen.has(phase.key)) return { path: `/phases/${p}/key`, reason: `key ${phase.key} appears twice` }
    seen.add(phase.key)
    for (const [t, task] of phase.tasks.entries()) {
      if (seen.has(task.key)) return { path: `/phases/${p}/tasks/${t}/key`, reason: `key ${task.key} appears twice` }
      seen.add(task.key)
    }
  }
  return null
}

export function parsePlanFile(text: string): PlanFile {
  return parseYamlFile<PlanFile>(text, findIssue)
}
