import { createHash } from 'node:crypto'
import { type Static, type TSchema, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { canonical } from '../conventions/file.ts'
import { EnvValues, JobArgs } from '../job-types/file.ts'
import { type Issue, parseYamlFile } from '../yaml-file.ts'

// A flow document (P4 design §2.G 32): YAML for `devrounds flow set`, JSON in the API, stored as given in one row per
// version (flows/service.ts). Nodes are joined by `next` edges keyed by the label a node leaves with; `default`
// catches the other labels. A label with no edge parks the run, so an unexpected outcome stops for a person instead of
// ending as if it were planned. Cycles are allowed when each passes through a node with `max_visits`: one visit past it
// parks the run. New node kinds are added as new kinds; a document is versioned, never reshaped.
//
// Templates: `{{input.<name>}}` in a job's cwd, args and env values and in a park's reason, filled from the run's
// input. Nothing else is evaluated: a flow names what it runs, it does not compute it.
const NODE_ID = '^[a-z][a-z0-9_-]{0,63}$'
const NodeId = Type.String({ pattern: NODE_ID })
const Label = Type.String({ pattern: NODE_ID })
const Key = Type.String({ minLength: 1, maxLength: 200 })
const Next = Type.Record(Label, NodeId, { additionalProperties: false, maxProperties: 50 })
const MaxVisits = Type.Integer({ minimum: 1, maximum: 1000 })
// 30 days: longer than any wait a flow needs (pr-round rechecks after 900 s), short enough to notice a typo.
const MAX_WAIT_S = 30 * 24 * 3600

export const JOB_OUTCOMES = ['done', 'failed', 'stopped'] as const

// Runs `job_type` as a job of the flow run's task; the node leaves when the job ends (after the job type's own
// retries) with done (finished), failed or stopped, and data { run, exit_code, failure_class } of the job's last run.
const JobNode = Type.Object(
  {
    kind: Type.Literal('job'),
    job_type: Key,
    cwd: Type.String({ minLength: 1, maxLength: 1000 }),
    args: Type.Optional(JobArgs),
    env: Type.Optional(EnvValues),
    queue: Type.Optional(Key),
    machine: Type.Optional(Key),
    max_visits: Type.Optional(MaxVisits),
    next: Type.Optional(Next),
  },
  { additionalProperties: false },
)

// Leaves with `done` once duration_s passed (the scheduler tick wakes it, so within its poll). Waits on an event come
// with the webhook triggers (P4-T17) as another field of this kind.
const WaitNode = Type.Object(
  {
    kind: Type.Literal('wait'),
    duration_s: Type.Integer({ minimum: 1, maximum: MAX_WAIT_S }),
    max_visits: Type.Optional(MaxVisits),
    next: Type.Optional(Next),
  },
  { additionalProperties: false },
)

// `label` is the previous node's outcome, `data.<name>` a field of its data, `input.<name>` one of the run's input.
const Field = Type.String({ pattern: '^(label|data\\.[A-Za-z0-9_]{1,64}|input\\.[A-Za-z0-9_]{1,64})$' })
const Literal = Type.Union([Type.String({ maxLength: 1000 }), Type.Number(), Type.Boolean(), Type.Null()])

// The first case whose field equals its literal gives the label; none gives `default`. Literal comparison only: the
// data passes through, so a branch after a branch reads the same node's result.
const BranchNode = Type.Object(
  {
    kind: Type.Literal('branch'),
    cases: Type.Array(Type.Object({ field: Field, equals: Literal, label: Label }, { additionalProperties: false }), {
      minItems: 1,
      maxItems: 50,
    }),
    max_visits: Type.Optional(MaxVisits),
    next: Type.Optional(Next),
  },
  { additionalProperties: false },
)

// What a person must answer to resume a run parked at a park node: a small subset of JSON Schema (an object of flat
// fields), checked by askType without a JSON Schema library. The answer becomes the data the next node reads.
const AskField = Type.Object(
  {
    type: Type.Union([Type.Literal('string'), Type.Literal('number'), Type.Literal('integer'), Type.Literal('boolean')]),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    enum: Type.Optional(Type.Array(Literal, { minItems: 1, maxItems: 50 })),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Optional(Type.Integer({ minimum: 0, maximum: 4096 })),
    minimum: Type.Optional(Type.Number()),
    maximum: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
)

const FieldName = Type.String({ pattern: '^[A-Za-z0-9_]{1,64}$' })

export const AskSchema = Type.Object(
  {
    type: Type.Literal('object'),
    properties: Type.Record(FieldName, AskField, { additionalProperties: false, maxProperties: 50 }),
    required: Type.Optional(Type.Array(FieldName, { maxItems: 50 })),
  },
  { additionalProperties: false },
)

export type AskSchema = Static<typeof AskSchema>

// Ends the run parked (it needs a person), with the reason and, optionally, what the person must answer (`ask`). With
// a `next` edge for `resumed` (or `default`) a human can resume it there (flows/service.ts resumeFlowRun).
const ParkNode = Type.Object(
  {
    kind: Type.Literal('park'),
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
    ask: Type.Optional(AskSchema),
    max_visits: Type.Optional(MaxVisits),
    next: Type.Optional(Next),
  },
  { additionalProperties: false },
)

const FinishNode = Type.Object({ kind: Type.Literal('finish') }, { additionalProperties: false })

const NODE_SCHEMAS = { job: JobNode, wait: WaitNode, branch: BranchNode, park: ParkNode, finish: FinishNode } as const
export type NodeKind = keyof typeof NODE_SCHEMAS

const FlowNode = Type.Union([JobNode, WaitNode, BranchNode, ParkNode, FinishNode])

export const FlowDocument = Type.Object(
  {
    key: Type.String({ pattern: '^[a-z][a-z0-9-]{0,99}$' }),
    start: NodeId,
    nodes: Type.Record(NodeId, FlowNode, { additionalProperties: false, minProperties: 1, maxProperties: 200 }),
  },
  { additionalProperties: false },
)

export type FlowDocument = Static<typeof FlowDocument>
export type FlowNode = Static<typeof FlowNode>
export type JobNode = Static<typeof JobNode>
export type BranchNode = Static<typeof BranchNode>
export type ParkNode = Static<typeof ParkNode>

/**
 * The TypeBox schema of an answer to `ask` (no ask: an empty answer). Every field not in `required` is optional and
 * no other field is accepted, so a typo in a field name fails instead of being dropped.
 */
export function askType(ask: AskSchema | undefined): TSchema {
  const required = new Set(ask?.required ?? [])
  const properties: Record<string, TSchema> = {}
  for (const [name, field] of Object.entries(ask?.properties ?? {})) {
    const { type, enum: values, ...limits } = field
    const base =
      values !== undefined
        ? Type.Union(values.map((v) => (v === null ? Type.Null() : Type.Literal(v))))
        : type === 'string'
          ? Type.String(limits)
          : type === 'number'
            ? Type.Number(limits)
            : type === 'integer'
              ? Type.Integer(limits)
              : Type.Boolean()
    properties[name] = required.has(name) ? base : Type.Optional(base)
  }
  return Type.Object(properties, { additionalProperties: false })
}

const TEMPLATE = /\{\{\s*([^}]*?)\s*\}\}/g
const INPUT_REF = /^input\.([A-Za-z0-9_]{1,64})$/

function errorOf(schema: TSchema, value: unknown, prefix: string): Issue | null {
  const first = Value.Errors(schema, value).First()
  return first ? { path: `${prefix}${first.path}` || '/', reason: first.message } : null
}

// The strings of a node that hold templates, with their paths.
function templated(id: string, node: FlowNode): [path: string, text: string][] {
  const at = `/nodes/${id}`
  if (node.kind === 'park') return [[`${at}/reason`, node.reason]]
  if (node.kind !== 'job') return []
  return [
    [`${at}/cwd`, node.cwd],
    ...(node.args ?? []).map((arg, i): [string, string] => [`${at}/args/${i}`, arg]),
    ...Object.entries(node.env ?? {}).map(([name, value]): [string, string] => [`${at}/env/${name}`, value]),
  ]
}

function edgesOf(node: FlowNode): [label: string, target: string][] {
  return 'next' in node && node.next ? Object.entries(node.next) : []
}

// A cycle among the nodes without max_visits, as `a → b → a`, or null. Every cycle of the graph must pass through a
// node with max_visits, which is the same as the graph without those nodes having none.
function unboundedCycle(doc: FlowDocument): string[] | null {
  const bounded = (id: string) => (doc.nodes[id] as { max_visits?: number }).max_visits !== undefined
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    if (bounded(id) || state.get(id) === 'done') return null
    if (state.get(id) === 'open') return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 'open')
    stack.push(id)
    for (const [, target] of edgesOf(doc.nodes[id])) {
      const cycle = visit(target)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }
  for (const id of Object.keys(doc.nodes).sort()) {
    const cycle = visit(id)
    if (cycle) return cycle
  }
  return null
}

/** The first problem of a flow document, with its JSON path, or null. */
export function findFlowIssue(value: unknown): Issue | null {
  // Each node against its own kind first: a union's first error names no branch, so it would not say what is wrong.
  const nodes = (value as { nodes?: unknown } | null)?.nodes
  if (nodes !== null && typeof nodes === 'object' && !Array.isArray(nodes)) {
    for (const [id, node] of Object.entries(nodes)) {
      const kind = (node as { kind?: unknown } | null)?.kind
      if (typeof kind === 'string' && Object.hasOwn(NODE_SCHEMAS, kind)) {
        const issue = errorOf(NODE_SCHEMAS[kind as NodeKind], node, `/nodes/${id}`)
        if (issue) return issue
      } else {
        return { path: `/nodes/${id}/kind`, reason: `must be one of ${Object.keys(NODE_SCHEMAS).join(', ')}` }
      }
    }
  }
  const shape = errorOf(FlowDocument, value, '')
  if (shape) return shape
  const doc = value as FlowDocument
  if (!(doc.start in doc.nodes)) return { path: '/start', reason: `names no node (${doc.start})` }
  for (const [id, node] of Object.entries(doc.nodes)) {
    for (const [label, target] of edgesOf(node)) {
      if (!(target in doc.nodes)) return { path: `/nodes/${id}/next/${label}`, reason: `names no node (${target})` }
    }
    for (const [path, text] of templated(id, node)) {
      for (const [, expr] of text.matchAll(TEMPLATE)) {
        if (!INPUT_REF.test(expr)) return { path, reason: `template {{${expr}}} must be {{input.<name>}}` }
      }
    }
    if (node.kind === 'park') {
      for (const [i, name] of (node.ask?.required ?? []).entries()) {
        if (!(name in (node.ask?.properties ?? {}))) {
          return { path: `/nodes/${id}/ask/required/${i}`, reason: `names no property (${name})` }
        }
      }
    }
  }
  const cycle = unboundedCycle(doc)
  if (cycle) {
    return {
      path: `/nodes/${cycle[0]}/max_visits`,
      reason: `is required on a node of the cycle ${cycle.join(' → ')}, so the loop is bounded`,
    }
  }
  return null
}

/** Parses a flow file; the first problem is DR101 with its path (e.g. `/nodes/build/next/done`). */
export function parseFlowFile(text: string): FlowDocument {
  return parseYamlFile<FlowDocument>(text, findFlowIssue)
}

/** SHA-256 (hex) of the document's canonical JSON: the same document with keys in another order has the same sha. */
export function flowSha(doc: FlowDocument): string {
  return createHash('sha256').update(canonical(doc)).digest('hex')
}

/** The input names the document's templates use, each with the first path that uses it. */
export function inputNames(doc: FlowDocument): Map<string, string> {
  const names = new Map<string, string>()
  // By node id: a stored document comes back from jsonb with its keys reordered.
  for (const [id, node] of Object.entries(doc.nodes).sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const [path, text] of templated(id, node)) {
      for (const [, expr] of text.matchAll(TEMPLATE)) {
        const name = (INPUT_REF.exec(expr) as RegExpExecArray)[1]
        if (!names.has(name)) names.set(name, path)
      }
    }
  }
  return names
}

/** `text` with each `{{input.<name>}}` replaced by the input's value; the caller checked every name is set. */
export function render(text: string, input: Record<string, string>): string {
  return text.replace(TEMPLATE, (_match, expr: string) => input[(INPUT_REF.exec(expr) as RegExpExecArray)[1]] ?? '')
}

/** The label a branch node leaves with, reading the previous node's outcome and data and the run's input. */
export function branchLabel(
  node: BranchNode,
  last: { outcome: string | null; data: Record<string, unknown> },
  input: Record<string, string>,
): string {
  for (const c of node.cases) {
    const [root, name] = c.field.split('.')
    const value = root === 'label' ? last.outcome : root === 'data' ? last.data[name] : input[name]
    if ((value ?? null) === c.equals) return c.label
  }
  return 'default'
}
