import type { ColumnType, Generated, Selectable } from 'kysely'

// Mirrors migrations/0001_core.ts, 0004_machines.ts, 0005_runs.ts, 0006_log_segments.ts, 0008_runs_orphaned_at.ts,
// 0009_runs_trace_span_id.ts, 0010_queues.ts and 0011_claim_run.ts (0002, 0003 and 0007 add no columns). pg returns int8 and numeric as strings, so those stay strings here.
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
// Why string on write: pg turns a JS array parameter into a Postgres array, so callers JSON.stringify first.
type Json = ColumnType<unknown, string, string>

export type MemberKind = 'human' | 'agent'
export type PhaseState = 'open' | 'delivered'
export type TaskState = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled'

export interface TenantsTable {
  id: Generated<string>
  name: string
  timezone: Generated<string>
}

export interface MembersTable {
  id: Generated<string>
  tenant_id: string
  kind: MemberKind
  name: string
}

export interface ApiTokensTable {
  id: Generated<string>
  tenant_id: string
  member_id: string
  token_hash: Buffer
  created_at: Timestamp
  revoked_at: NullableTimestamp
}

export interface ProjectsTable {
  id: Generated<string>
  tenant_id: string
  key: string
  name: string
}

export interface PhasesTable {
  id: Generated<string>
  tenant_id: string
  project_id: string
  key: string
  title: string
  goal: Generated<string>
  position: number
  state: Generated<PhaseState>
  delivered_at: NullableTimestamp
  delivered_by: string | null
}

export interface PhaseDependenciesTable {
  tenant_id: string
  phase_id: string
  blocked_by_phase_id: string
}

export interface TasksTable {
  id: Generated<string>
  tenant_id: string
  project_id: string
  phase_id: string | null
  parent_id: string | null
  key: string
  title: string
  description: Generated<string>
  state: Generated<TaskState>
  assignee_id: string | null
  estimate_hours: ColumnType<string | null, string | number | null | undefined, string | number | null>
  started_at: NullableTimestamp
  finished_at: NullableTimestamp
  version: Generated<number>
}

export interface TaskDependenciesTable {
  tenant_id: string
  task_id: string
  blocked_by_task_id: string
}

export interface CriteriaTable {
  id: Generated<string>
  tenant_id: string
  task_id: string | null
  phase_id: string | null
  position: number
  text: string
  checked_at: NullableTimestamp
  checked_by: string | null
  evidence: string | null
}

export interface LinksTable {
  id: Generated<string>
  tenant_id: string
  task_id: string | null
  phase_id: string | null
  kind: string
  ref: string
  title: string | null
}

export interface PlanEventsTable {
  id: Generated<string>
  tenant_id: string
  project_id: string
  task_id: string | null
  phase_id: string | null
  actor_id: string
  kind: string
  reason: string | null
  data: Json
  at: Timestamp
}

export interface IdempotencyKeysTable {
  tenant_id: string
  key: string
  response: Json
  created_at: Timestamp
}

export type MachineLifecycle = 'persistent' | 'ephemeral'

export interface MachinesTable {
  id: Generated<string>
  tenant_id: string
  name: string
  compute_provider: Generated<string>
  lifecycle: Generated<MachineLifecycle>
  token_hash: Buffer
  os: string
  executor_version: string
  paired_at: Timestamp
  revoked_at: NullableTimestamp
  last_seen_at: NullableTimestamp
  last_report: ColumnType<unknown, string | null | undefined, string | null>
  last_seq: ColumnType<string, string | number | bigint | undefined, string | number | bigint>
}

export interface PairingCodesTable {
  id: Generated<string>
  tenant_id: string
  code_hash: Buffer
  machine_name: string
  created_by: string
  created_at: Timestamp
  expires_at: Timestamp
  used_at: NullableTimestamp
}

// int8 read as a decimal string; written from any integer form.
type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>
type NullableInt8 = ColumnType<
  string | null,
  string | number | bigint | null | undefined,
  string | number | bigint | null
>

export type OrphanPolicy = 'kill' | 'let_finish'
export type RunState =
  | 'queued'
  | 'offered'
  | 'admitted'
  | 'running'
  | 'finished'
  | 'failed'
  | 'stopped'
  | 'orphaned'
  | 'skipped'
export type RunCause = 'first' | 'retry' | 'requeue'
export type JobState = 'open' | 'finished' | 'failed' | 'stopped' | 'skipped'
export type FailureClass = 'check_red' | 'environment' | 'timeout' | 'memory' | 'infra' | 'cancelled' | 'unclassified'
export type DelayReason = 'memory' | 'concurrency' | 'memory_critical'
export type StepOutcome = 'finished' | 'failed'

export interface JobTypesTable {
  id: Generated<string>
  tenant_id: string
  project_id: string
  key: string
  program: string
  args: Json
  env_allow: ColumnType<string[], string[] | undefined, string[]>
  timeout_s: Generated<number>
  orphan_policy: Generated<OrphanPolicy>
  classify: Json
  updated_at: Timestamp
}

export interface JobsTable {
  id: Generated<string>
  tenant_id: string
  project_id: string
  job_type_id: string
  task_id: string | null
  cwd: string
  // Null: any machine; set: pinned to that machine.
  machine_id: string | null
  queue_id: string
  batch_id: string | null
  ref: string | null
  state: Generated<JobState>
  created_by: string
  created_at: Timestamp
}

export interface QueuesTable {
  id: Generated<string>
  tenant_id: string
  project_id: string
  key: string
  priority: Generated<number>
  concurrency: number | null
  created_at: Timestamp
}

export interface QueueJobTypesTable {
  tenant_id: string
  queue_id: string
  job_type_id: string
}

export interface JobBatchesTable {
  id: Generated<string>
  tenant_id: string
  project_id: string
  created_by: string
  created_at: Timestamp
}

export interface JobDependenciesTable {
  tenant_id: string
  job_id: string
  depends_on_job_id: string
}

export interface RunsTable {
  id: Generated<string>
  tenant_id: string
  project_id: string
  job_id: string
  job_type_id: string
  // Null until the run is placed on a machine.
  machine_id: string | null
  attempt: Generated<number>
  state: Generated<RunState>
  queued_at: Timestamp
  not_before: Timestamp
  memory_need: NullableInt8
  cause: Generated<RunCause>
  offered_at: NullableTimestamp
  offer_expires_at: NullableTimestamp
  offer_accepted_at: NullableTimestamp
  withdrawn_at: NullableTimestamp
  admitted_at: NullableTimestamp
  started_at: NullableTimestamp
  finished_at: NullableTimestamp
  exit_code: NullableInt8
  failure_class: FailureClass | null
  failure_summary: string | null
  log_cursor: NullableInt8
  pid: number | null
  process_start_time: NullableInt8
  boot_id: string | null
  peak_private_bytes: NullableInt8
  p95_private_bytes: NullableInt8
  p50_private_bytes: NullableInt8
  cpu_seconds: number | null
  swept_processes: number | null
  visible_windows: number | null
  orphan_action: 'killed' | 'let_finish' | null
  orphaned_at: NullableTimestamp
  clock_skew_ms: Generated<number>
  trace_id: string | null
  trace_span_id: string | null
}

export interface LearnedNeedsTable {
  tenant_id: string
  project_id: string
  job_type_id: string
  machine_id: string
  need_bytes: Int8
  samples: number
  updated_at: Timestamp
}

export interface RunStepsTable {
  id: Generated<string>
  tenant_id: string
  run_id: string
  step: number
  name: string
  started_at: Timestamp
  finished_at: NullableTimestamp
  outcome: StepOutcome | null
}

export interface RunDelaysTable {
  id: Generated<string>
  tenant_id: string
  run_id: string
  at: Timestamp
  reason: DelayReason
  need_bytes: Int8
  available_bytes: NullableInt8
  position: number
}

export interface LogSegmentsTable {
  id: Generated<string>
  tenant_id: string
  run_id: string
  first_seq: Int8
  last_seq: Int8
  records: number
  bytes: number
  /** Relative to the logs root, for people reading the table (rows from before it was relative hold an absolute
   * path); code always derives the file with log-store.ts segmentFile. */
  path: string
  created_at: Timestamp
}

export interface Database {
  tenants: TenantsTable
  members: MembersTable
  api_tokens: ApiTokensTable
  projects: ProjectsTable
  phases: PhasesTable
  phase_dependencies: PhaseDependenciesTable
  tasks: TasksTable
  task_dependencies: TaskDependenciesTable
  criteria: CriteriaTable
  links: LinksTable
  plan_events: PlanEventsTable
  idempotency_keys: IdempotencyKeysTable
  machines: MachinesTable
  pairing_codes: PairingCodesTable
  job_types: JobTypesTable
  jobs: JobsTable
  queues: QueuesTable
  queue_job_types: QueueJobTypesTable
  job_batches: JobBatchesTable
  job_dependencies: JobDependenciesTable
  runs: RunsTable
  learned_needs: LearnedNeedsTable
  run_steps: RunStepsTable
  run_delays: RunDelaysTable
  log_segments: LogSegmentsTable
}

export type Member = Selectable<MembersTable>
