import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import type { MigrationOptions } from './index.ts'

// Agent runs in placement (P4 design §2.C 20, 21):
// - run_over_budget: a queued run of an agent job type whose project has a budget (agent_budgets, per job type or per
//   member who made the job) already spent today, in the tenant's time zone, stays queued. Spend is cost_usd and
//   tokens_in + tokens_out of the runs that finished today; cost is known only at a run's end, so a day can pass its cap
//   by the runs already running (accepted in the design). The view (scheduler/placeable.ts) reads the same function,
//   so `run show --wait` names the reason `budget`.
// - pinned_machine_id: a run that resumes an agent session goes only to the machine that holds its transcript.
// Otherwise claim_run is 0027's: security definer, search_path, the advisory lock and the grant (0011 says why).
const OVER_BUDGET = `create function run_over_budget(p_run uuid)
  returns boolean
  language sql stable set search_path = pg_catalog, public, pg_temp
  as $$
    select exists (
      select 1
      from public.runs r
      join public.jobs j on j.id = r.job_id
      join public.job_types jt on jt.id = r.job_type_id
      join public.tenants t on t.id = r.tenant_id
      join public.agent_budgets b on b.project_id = r.project_id
        and (b.job_type_id = r.job_type_id or b.member_id = j.created_by)
      cross join lateral (
        select coalesce(sum(s.cost_usd), 0) as usd,
          coalesce(sum(coalesce(s.tokens_in, 0) + coalesce(s.tokens_out, 0)), 0) as tokens
        from public.runs s
        join public.jobs sj on sj.id = s.job_id
        where s.project_id = r.project_id
          and s.finished_at >= (date_trunc('day', now() at time zone t.timezone) at time zone t.timezone)
          and (s.cost_usd is not null or s.tokens_in is not null)
          and (s.job_type_id = b.job_type_id or sj.created_by = b.member_id)
      ) spent
      where r.id = p_run and jt.agent is not null
        and ((b.usd_per_day is not null and spent.usd >= b.usd_per_day)
          or (b.tokens_per_day is not null and spent.tokens >= b.tokens_per_day))
    )
  $$`

const DROP = 'drop function claim_run(uuid, bigint, bigint, int, bigint)'
const FUNCTION = 'claim_run(uuid, bigint, bigint, int, bigint)'

const CLAIM_RUN = `create function claim_run(
    p_machine uuid, p_free bigint, p_reserve bigint, p_offer_timeout_s int, p_running_used bigint default 0
  )
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

    select coalesce(sum(r.memory_need) filter (where r.state in ('offered', 'admitted')), 0)
      + greatest(coalesce(sum(r.memory_need) filter (where r.state = 'running'), 0) - p_running_used, 0)
      into v_in_flight
    from public.runs r
    where r.tenant_id = v_tenant and r.machine_id = p_machine and r.state in ('offered', 'admitted', 'running');

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
      and (r.pinned_machine_id is null or r.pinned_machine_id = p_machine)
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
      and (jt.agent is null or not public.run_over_budget(r.id))
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

export function claimRunAgents({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      for (const statement of [
        OVER_BUDGET,
        'revoke all on function run_over_budget(uuid) from public',
        DROP,
        CLAIM_RUN,
        `revoke all on function ${FUNCTION} from public`,
      ])
        await sql.raw(statement).execute(db)
      await sql`grant execute on function run_over_budget(uuid) to ${sql.id(appRole)}`.execute(db)
      await sql`grant execute on function ${sql.raw(FUNCTION)} to ${sql.id(appRole)}`.execute(db)
    },
  }
}
