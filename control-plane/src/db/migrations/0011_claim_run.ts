import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'
import type { MigrationOptions } from './index.ts'

// The memory a job type is expected to need on a machine, kept as a row (updated when a run reports its peak) so
// claim_run can join it instead of computing medians per candidate. runs/learned-need.ts owns the rule.
const TABLES = [
  `create table learned_needs (
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    job_type_id uuid not null,
    machine_id uuid not null,
    need_bytes bigint not null,
    samples int not null,
    updated_at timestamptz not null default now(),
    primary key (project_id, job_type_id, machine_id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id),
    foreign key (tenant_id, machine_id) references machines (tenant_id, id)
  )`,
]

// Runs as the owner (superuser), so it sees every tenant's runs. Same window and rounding as learnedNeed: the last
// 10 peaks by finished_at desc, id; percentile_cont is cast to numeric so round() goes half up like (a + b + 1) / 2.
const BACKFILL = `insert into learned_needs (tenant_id, project_id, job_type_id, machine_id, need_bytes, samples)
  select tenant_id, project_id, job_type_id, machine_id,
    round((percentile_cont(0.5) within group (order by peak_private_bytes))::numeric)::bigint,
    count(*)::int
  from (
    select tenant_id, project_id, job_type_id, machine_id, peak_private_bytes,
      row_number() over (partition by project_id, job_type_id, machine_id order by finished_at desc, id) as n
    from runs
    where peak_private_bytes is not null and machine_id is not null
  ) recent
  where n <= 10
  group by tenant_id, project_id, job_type_id, machine_id`

// An offer is 1:1 with a run attempt, so its lifecycle lives on the run (used from the offer expiry onwards).
const RUNS = [
  'alter table runs add column offer_expires_at timestamptz',
  'alter table runs add column offer_accepted_at timestamptz',
  'alter table runs add column withdrawn_at timestamptz',
]

// Why security definer: the claim must be exact across concurrent ticks (advisory lock, skip locked) and its rules
// live in one place. It is still tenant-bound: the tenant comes from the machine row, which must belong to the
// transaction's app.tenant_id, and every read filters by it (the owner bypasses RLS, so the filters are the guard).
// Why the advisory lock: under read committed each statement after it sees the claims committed before it, so the
// in-flight sum and the queue cap count every claim of the tenant, and a burst never over-offers.
// Same hardening as resolve_token (0001): qualified names, pg_temp last, execute for the app role only.
const CLAIM_RUN = `create function claim_run(p_machine uuid, p_free bigint, p_reserve bigint, p_offer_timeout_s int)
  returns table (tenant_id uuid, run_id uuid, memory_need bigint)
  language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp
  as $$
  declare
    v_tenant uuid;
    v_in_flight bigint;
    v_run uuid;
    v_need bigint;
  begin
    select m.tenant_id into v_tenant
    from public.machines m
    where m.id = p_machine and m.revoked_at is null
      and m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
    if v_tenant is null then
      return;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('devrounds.claim:' || v_tenant::text, 0));

    select coalesce(sum(r.memory_need), 0) into v_in_flight
    from public.runs r
    where r.tenant_id = v_tenant and r.machine_id = p_machine and r.state in ('offered', 'admitted');

    select r.id, coalesce(n.need_bytes, 536870912) into v_run, v_need
    from public.runs r
    join public.jobs j on j.id = r.job_id
    join public.queues q on q.id = j.queue_id
    left join public.learned_needs n
      on n.project_id = r.project_id and n.job_type_id = r.job_type_id and n.machine_id = p_machine
    where r.tenant_id = v_tenant
      and r.state = 'queued'
      and r.not_before <= now()
      and (j.machine_id is null or j.machine_id = p_machine)
      and not exists (
        select 1
        from public.job_dependencies d
        join public.jobs dj on dj.id = d.depends_on_job_id
        where d.job_id = j.id and dj.state <> 'finished'
      )
      and (q.concurrency is null or (
        select count(*)
        from public.runs c
        join public.jobs cj on cj.id = c.job_id
        where cj.queue_id = q.id and c.state in ('offered', 'admitted', 'running')
      ) < q.concurrency)
      and coalesce(n.need_bytes, 536870912) <= p_free - p_reserve - v_in_flight
    order by q.priority desc, r.queued_at, r.id
    for update of r skip locked
    limit 1;
    if v_run is null then
      return;
    end if;

    update public.runs r
    set state = 'offered',
      machine_id = p_machine,
      offered_at = now(),
      memory_need = v_need,
      offer_expires_at = now() + make_interval(secs => p_offer_timeout_s)
    where r.id = v_run;

    return query select v_tenant, v_run, v_need;
  end
  $$`

const FUNCTION = 'claim_run(uuid, bigint, bigint, int)'

// Same reason as 0007_fk_indexes: the primary key does not lead with tenant_id.
const FK_INDEXES = ['project_id', 'job_type_id', 'machine_id'].map(
  (column) => `create index learned_needs_${column} on learned_needs (tenant_id, ${column})`,
)

export function claimRun({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      const statements = [
        ...TABLES,
        ...isolate('learned_needs', 'tenant_id'),
        ...FK_INDEXES,
        BACKFILL,
        ...RUNS,
        CLAIM_RUN,
        `revoke all on function ${FUNCTION} from public`,
      ]
      for (const statement of statements) await sql.raw(statement).execute(db)
      await sql`grant execute on function ${sql.raw(FUNCTION)} to ${sql.id(appRole)}`.execute(db)
    },
  }
}
