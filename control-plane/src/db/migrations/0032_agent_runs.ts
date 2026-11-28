import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'

// Agent runs (P4 design §2.C, engines/agent-runtime): a job type with `agent` is run through an agent-runtime
// provider, which builds the command at dispatch and reads the run's output into agent_events as it ships.
//
// - job_types.agent: the job type file's `agent` block (job-types/file.ts), defaults filled; null for a plain command.
//   job_types.stall_s: seconds without output and CPU after which the executor stops the run (feature `stall`).
// - jobs.input: named values a prompt template reads as {{input.<key>}}.
// - runs: usage and cost (filled at RunFinished from agent_events; usage_source says where they came from), the
//   runtime's session id, the run this one resumes (its session, on the same machine: pinned_machine_id) and the
//   parent run (a run started by another run, P4-T08).
// - Three failure classes: stalled (the executor's stall stop), no_outcome (the agent never reported a result),
//   limit (the runtime's budget or turn limit). retry_on may name them; cancelled stays out (0012).
// - run_results: the one result a run reports (`devrounds run result`), at most 64 KiB of data.
// - agent_events: the vendor-neutral events the provider read from the output, one row per event, keyed by the log
//   line they came from so a resent segment adds nothing.
// - agent_budgets: per project and job type or member, daily caps that hold queued runs (run_over_budget, 0033) and a
//   per-run cap passed to the runtime.
const CLASSES = `'check_red', 'environment', 'timeout', 'memory', 'infra', 'cancelled', 'unclassified', 'stalled',
  'no_outcome', 'limit'`

const COLUMNS = [
  'alter table job_types add column agent jsonb',
  'alter table job_types add column stall_s int check (stall_s between 1 and 604800)',
  `alter table jobs add column input jsonb not null default '{}'`,
  'alter table runs add column tokens_in bigint check (tokens_in >= 0)',
  'alter table runs add column tokens_out bigint check (tokens_out >= 0)',
  'alter table runs add column tokens_cache_read bigint check (tokens_cache_read >= 0)',
  'alter table runs add column tokens_cache_write bigint check (tokens_cache_write >= 0)',
  'alter table runs add column cost_usd numeric(14, 6) check (cost_usd >= 0)',
  `alter table runs add column usage_source text check (usage_source in ('result', 'transcript', 'missing'))`,
  'alter table runs add column agent_session_id text check (length(agent_session_id) between 1 and 200)',
  'alter table runs add column resumed_from_run_id uuid',
  'alter table runs add column pinned_machine_id uuid',
  'alter table runs add column parent_run_id uuid',
  `alter table runs add constraint runs_resumed_from_fk
    foreign key (tenant_id, resumed_from_run_id) references runs (tenant_id, id)`,
  `alter table runs add constraint runs_pinned_machine_fk
    foreign key (tenant_id, pinned_machine_id) references machines (tenant_id, id)`,
  `alter table runs add constraint runs_parent_run_fk
    foreign key (tenant_id, parent_run_id) references runs (tenant_id, id)`,
  'create index runs_resumed_from on runs (tenant_id, resumed_from_run_id)',
  'create index runs_pinned_machine on runs (tenant_id, pinned_machine_id)',
  'create index runs_parent_run on runs (tenant_id, parent_run_id)',
  // The day's spend of a project, read by run_over_budget for every queued agent run a claim looks at.
  'create index runs_agent_spend on runs (project_id, finished_at) where cost_usd is not null or tokens_in is not null',
  'alter table runs drop constraint runs_failure_class_check',
  `alter table runs add constraint runs_failure_class_check check (failure_class in (${CLASSES}))`,
  'alter table job_types drop constraint job_types_retry_on_check',
  `alter table job_types add constraint job_types_retry_on_check
    check (retry_on <@ '{check_red,environment,timeout,memory,infra,unclassified,stalled,no_outcome,limit}'::text[])`,
]

const TABLES = [
  `create table run_results (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    run_id uuid not null unique,
    label text not null check (label ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    data jsonb not null default '{}',
    -- Null: read from the runtime's own output (result kind text or json), not reported by a member.
    reported_by uuid,
    at timestamptz not null default now(),
    check (octet_length(data::text) <= 65536),
    foreign key (tenant_id, run_id) references runs (tenant_id, id),
    foreign key (tenant_id, reported_by) references members (tenant_id, id)
  )`,
  `create table agent_events (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    run_id uuid not null,
    line_seq bigint not null check (line_seq >= 0),
    position int not null check (position >= 0),
    at timestamptz not null,
    kind text not null check (kind in ('message', 'tool_call', 'tool_result', 'permission_request', 'usage', 'result')),
    data jsonb not null,
    unique (run_id, line_seq, position),
    foreign key (tenant_id, run_id) references runs (tenant_id, id)
  )`,
  `create table agent_budgets (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    job_type_id uuid,
    member_id uuid,
    usd_per_day numeric(14, 6) check (usd_per_day > 0),
    tokens_per_day bigint check (tokens_per_day > 0),
    usd_per_run numeric(14, 6) check (usd_per_run > 0),
    updated_by uuid not null,
    updated_at timestamptz not null default now(),
    check ((job_type_id is null) <> (member_id is null)),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id),
    foreign key (tenant_id, member_id) references members (tenant_id, id),
    foreign key (tenant_id, updated_by) references members (tenant_id, id)
  )`,
]

// Same reason as 0007_fk_indexes: one index per composite FK the constraints above do not already lead with.
const INDEXES = [
  'create index run_results_run on run_results (tenant_id, run_id)',
  'create index run_results_reported_by on run_results (tenant_id, reported_by)',
  'create index agent_budgets_project on agent_budgets (tenant_id, project_id)',
  'create index agent_events_run on agent_events (tenant_id, run_id)',
  'create index agent_budgets_job_type on agent_budgets (tenant_id, job_type_id)',
  'create index agent_budgets_member on agent_budgets (tenant_id, member_id)',
  'create index agent_budgets_updated_by on agent_budgets (tenant_id, updated_by)',
  // One budget per subject and project.
  'create unique index agent_budgets_job_type_key on agent_budgets (project_id, job_type_id) where job_type_id is not null',
  'create unique index agent_budgets_member_key on agent_budgets (project_id, member_id) where member_id is not null',
]

export const agentRuns: Migration = {
  async up(db: Kysely<unknown>) {
    const statements = [
      ...COLUMNS,
      ...TABLES,
      ...isolate('run_results', 'tenant_id'),
      ...isolate('agent_events', 'tenant_id'),
      ...isolate('agent_budgets', 'tenant_id'),
      ...INDEXES,
    ]
    for (const statement of statements) await sql.raw(statement).execute(db)
  },
}
