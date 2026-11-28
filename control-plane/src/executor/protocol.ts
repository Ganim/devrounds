import { type Static, type TSchema, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { fail } from '../errors/error.ts'

// Wire messages between executor and control plane, mirroring executor/crates/protocol/src/lib.rs 1:1 (JSON keys
// are the Rust field names). Both sides test against executor/crates/protocol/fixtures/*.json. Rust names the
// executor's messages ClientMessage and the control plane's ServerMessage.

export const PROTOCOL = 1
export const FEATURES = [
  'seq',
  'steps',
  'log-segments',
  'orphans',
  'trace-context',
  'acked-through',
  'withdraw',
  'job-env',
  'environment',
  'stall',
] as const

const U32 = Type.Integer({ minimum: 0, maximum: 4294967295 })
// Rust sends u64; a JSON number above 2^53 would silently round here, so the schema refuses it. Seqs and byte counts
// stay far below. Values that can exceed it (a FILETIME start_time) travel as decimal strings.
const U64 = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const I64 = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })
const DecimalU64 = Type.String({ pattern: '^[0-9]{1,20}$' })
const RFC3339_UTC = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' })
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()])
const OneOf = <T extends string[]>(...words: [...T]) => Type.Union(words.map((word) => Type.Literal(word)))

const JobSpec = Type.Object({
  job_type: Type.String(),
  program: Type.String(),
  args: Type.Array(Type.String()),
  cwd: Type.String(),
  env_allow: Type.Array(Type.String()),
  timeout_s: U32,
  // Feature job-env: values the run gets (job type env_set, then the job's env); never secrets.
  env_set: Type.Record(Type.String(), Type.String()),
  // Feature environment: run in cwd just before the run, its stdout read back on RunStarted (environments/).
  environment_probe: Type.Optional(Type.Object({ program: Type.String(), args: Type.Array(Type.String()) })),
  // Feature stall: seconds without output and CPU after which the executor stops the run (reason stalled).
  stall_s: Type.Optional(U32),
})

// Feature environment: what the probe printed, as JSON, or why there is nothing (error). The exit code stands apart,
// as a probe may describe a failed environment and still print it.
const EnvironmentReading = Type.Object({
  output: Type.Unknown(),
  exit_code: Nullable(I64),
  error: Nullable(Type.String()),
})
export type EnvironmentReading = Static<typeof EnvironmentReading>

export const RUN_EVENTS = {
  Admitted: Type.Object({ kind: Type.Literal('Admitted'), run: Type.String() }),
  Delayed: Type.Object({
    kind: Type.Literal('Delayed'),
    run: Type.String(),
    reason: OneOf('memory', 'concurrency', 'memory_critical'),
    position: U32,
    need: U64,
    // null before the executor's first memory reading.
    available: Nullable(U64),
  }),
  RunStarted: Type.Object({
    kind: Type.Literal('RunStarted'),
    run: Type.String(),
    pid: U32,
    start_time: DecimalU64,
    boot_id: Type.String(),
    // Feature environment, for a job with an environment_probe. Absent from older executors.
    environment: Type.Optional(EnvironmentReading),
  }),
  StepStarted: Type.Object({ kind: Type.Literal('StepStarted'), run: Type.String(), step: U32, name: Type.String() }),
  StepFinished: Type.Object({
    kind: Type.Literal('StepFinished'),
    run: Type.String(),
    step: U32,
    outcome: OneOf('finished', 'failed'),
  }),
  LogSegment: Type.Object({
    kind: Type.Literal('LogSegment'),
    run: Type.String(),
    first_seq: U64,
    last_seq: U64,
    records: U32,
    zstd_base64: Type.String(),
  }),
  RunFinished: Type.Object({
    kind: Type.Literal('RunFinished'),
    run: Type.String(),
    reason: OneOf('exited', 'stopped', 'timeout', 'spawn_failed', 'infra', 'stalled'),
    exit_code: Nullable(I64),
    peak: U64,
    p95: U64,
    p50: U64,
    cpu_seconds: Type.Number({ minimum: 0 }),
    swept: U32,
    visible_windows: U32,
    tail: Type.Array(Type.String()),
    summary: Nullable(Type.String()),
  }),
  Orphans: Type.Object({
    kind: Type.Literal('Orphans'),
    runs: Type.Array(Type.Object({ run: Type.String(), alive: Type.Boolean() })),
  }),
}

const RunEvent = Type.Union(Object.values(RUN_EVENTS))
export type RunEvent = Static<typeof RunEvent>

const eventFields = { type: Type.Literal('Event'), seq: U64, at: RFC3339_UTC }

export const EXECUTOR_MESSAGES = {
  Hello: Type.Object({
    type: Type.Literal('Hello'),
    protocol: U32,
    version: Type.String(),
    features: Type.Array(Type.String()),
    boot_id: Type.String(),
    // Feature acked-through: every seq up to this one was acked by some control plane. Absent from older executors.
    acked_through: Type.Optional(U64),
  }),
  MachineReport: Type.Object({
    type: Type.Literal('MachineReport'),
    total_memory: U64,
    available_memory: U64,
    commit_total: U64,
    commit_limit: U64,
    // Busy share of all CPUs, nominally 0-100. No maximum: Rust sends any f64, and a reading that rounds just past 100
    // must not reject the whole report.
    cpu_percent: Type.Number({ minimum: 0 }),
    memory_pressure: OneOf('normal', 'warn', 'critical'),
    running: U32,
    executor_private_bytes: U64,
  }),
  // Live output only: no seq, never acked; the durable copy arrives as LogSegment events.
  LogChunk: Type.Object({
    type: Type.Literal('LogChunk'),
    run: Type.String(),
    stream: OneOf('stdout', 'stderr'),
    text: Type.String(),
  }),
  Event: Type.Object({ ...eventFields, event: RunEvent }),
}

// Parsing checks the envelope first so an unknown kind can still be read as an ignorable event.
const EventEnvelope = Type.Object({ ...eventFields, event: Type.Object({ kind: Type.String() }) })

export const CONTROL_PLANE_MESSAGES = {
  HelloAck: Type.Object({
    type: Type.Literal('HelloAck'),
    protocol: U32,
    features: Type.Array(Type.String()),
    machine_id: Type.String(),
    last_seq: U64,
    // Feature withdraw: runs offered to this machine and withdrawn in the last 7 days (expired, or stopped while the
    // machine was offline); the executor drops any it has not spawned. Empty without the feature.
    withdrawn: Type.Array(Type.String()),
  }),
  Offer: Type.Object({
    type: Type.Literal('Offer'),
    run: Type.String(),
    job: JobSpec,
    memory_need: U64,
    trace_parent: Nullable(Type.String()),
  }),
  Stop: Type.Object({ type: Type.Literal('Stop'), run: Type.String(), reason: OneOf('cancel', 'orphan_policy') }),
  Ack: Type.Object({ type: Type.Literal('Ack'), seq: U64 }),
  Resync: Type.Object({ type: Type.Literal('Resync'), from_seq: U64 }),
}

export type Hello = Static<typeof EXECUTOR_MESSAGES.Hello>
export type MachineReport = Static<typeof EXECUTOR_MESSAGES.MachineReport>
type UnknownEvent = { kind: 'Unknown' }
export type EventMessage = Static<typeof EventEnvelope> & { event: RunEvent | UnknownEvent }
export type ExecutorMessage = Hello | MachineReport | Static<typeof EXECUTOR_MESSAGES.LogChunk> | EventMessage
export type ControlPlaneMessage = {
  [K in keyof typeof CONTROL_PLANE_MESSAGES]: Static<(typeof CONTROL_PLANE_MESSAGES)[K]>
}[keyof typeof CONTROL_PLANE_MESSAGES]

function check<T extends TSchema>(schema: T, value: unknown, type: string, prefix = ''): Static<T> {
  const first = Value.Errors(schema, value).First()
  if (first) fail('DR150', { type, path: `${prefix}${first.path}` || '/', reason: first.message })
  return value as Static<T>
}

function known<T extends object>(table: T, key: string): key is Extract<keyof T, string> {
  return Object.hasOwn(table, key)
}

/** Parses one executor frame. Unknown types and event kinds come back as Unknown for the caller to ignore. */
export function parseExecutorMessage(text: string): ExecutorMessage | { type: 'Unknown' } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    fail('DR150', { path: '/', reason: `not JSON: ${(err as Error).message}` })
  }
  const type = (value as { type?: unknown } | null)?.type
  if (typeof type !== 'string') fail('DR150', { path: '/type', reason: 'missing or not a string' })
  if (!known(EXECUTOR_MESSAGES, type)) return { type: 'Unknown' }
  if (type !== 'Event') return check(EXECUTOR_MESSAGES[type], value, type)
  const event = check(EventEnvelope, value, type)
  const { kind } = event.event
  if (!known(RUN_EVENTS, kind)) return { ...event, event: { kind: 'Unknown' } }
  return { ...event, event: check(RUN_EVENTS[kind], event.event, type, '/event') }
}

/** The features both sides speak, in the order of `ours`. */
export function negotiate(ours: readonly string[], theirs: readonly string[]): string[] {
  return ours.filter((feature) => theirs.includes(feature))
}

/** The session's features for this Hello; DR151 when the executor speaks another protocol. */
export function checkHello(hello: Hello): string[] {
  if (hello.protocol !== PROTOCOL) fail('DR151', { got: hello.protocol, supported: PROTOCOL })
  return negotiate(FEATURES, hello.features)
}

/**
 * Orders one session's events. `new` only for lastSeq + 1, which advances; `duplicate` for anything already applied.
 * A seq past lastSeq + 1 is a gap: the first answers `gap` (send one Resync), and later ones while the same seq is
 * still missing answer `duplicate` (ignore them; the resync resends them in order).
 */
export class SeqTracker {
  lastSeq: bigint
  #gapAnsweredFor: bigint | null = null

  constructor(lastSeq: bigint = 0n) {
    this.lastSeq = lastSeq
  }

  accept(seq: number | bigint): 'new' | 'duplicate' | 'gap' {
    const next = BigInt(seq)
    const expected = this.lastSeq + 1n
    if (next === expected) {
      this.lastSeq = next
      this.#gapAnsweredFor = null
      return 'new'
    }
    if (next < expected || this.#gapAnsweredFor === expected) return 'duplicate'
    this.#gapAnsweredFor = expected
    return 'gap'
  }
}
