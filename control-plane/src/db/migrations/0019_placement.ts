import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// Two placement inputs the scheduler reads in claim_run: the starting need of a job type (`need_mb` in its file, in
// bytes here) and the per-machine cap of a queue. Nothing else in claim_run changes from 0011: signature, security
// definer, search_path and the grant (execute for the app role only) stay, `create or replace` keeps them.
const COLUMNS = [
  'alter table job_types add column need_bytes bigint check (need_bytes > 0)',
  'alter table queues add column machine_concurrency int check (machine_concurrency > 0)',
]

// The need of a key is its learned need (p90 since 0023) once it has 3 samples (runs/learned-need.ts MIN_LEARNED_SAMPLES), else the
// job type's need_bytes, else the learned one of fewer samples, else the 512 MiB default.
// The per-machine count looks at the runs of the queue on p_machine only; the global cap is untouched beside it.
const CLAIM_RUN = `create or replace function claim_run(p_machine uuid, p_free bigint, p_reserve bigint, p_offer_timeout_s int)
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

    select r.id, x.need into v_run, v_need
    from public.runs r
    join public.jobs j on j.id = r.job_id
    join public.queues q on q.id = j.queue_id
    join public.job_types jt on jt.id = r.job_type_id
    left join public.learned_needs n
      on n.project_id = r.project_id and n.job_type_id = r.job_type_id and n.machine_id = p_machine
    cross join lateral (
      select case when n.samples >= 3 then n.need_bytes
        else coalesce(jt.need_bytes, n.need_bytes, 536870912) end as need
    ) x
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
      and (q.machine_concurrency is null or (
        select count(*)
        from public.runs c
        join public.jobs cj on cj.id = c.job_id
        where cj.queue_id = q.id and c.machine_id = p_machine and c.state in ('offered', 'admitted', 'running')
      ) < q.machine_concurrency)
      and x.need <= p_free - p_reserve - v_in_flight
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

export const placement: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of [...COLUMNS, CLAIM_RUN]) await sql.raw(statement).execute(db)
  },
}
