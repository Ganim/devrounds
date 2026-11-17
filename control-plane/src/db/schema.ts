import type { ColumnType, Generated, Selectable } from 'kysely'

// Mirrors migrations/0001_core.ts (0002 only adds indexes). pg returns int8 and numeric as strings, so those stay strings here.
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
}

export type Member = Selectable<MembersTable>
