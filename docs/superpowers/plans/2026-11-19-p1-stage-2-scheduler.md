# DevRounds P1 Stage 2 (Scheduler, Session Login, Operational View) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jobs enter tenant-scoped queues and an own scheduler on the P0 Postgres places them on executors by learned
memory need (replacing direct dispatch), with `depends_on`, retries, offer expiry, scheduled jobs, session login through
Better Auth, a minimal operational view and the P1 resource and queue-time indicators, within the P1 budgets.

**Architecture:** A run in state `queued` is the unit of the queue. A security definer function `claim_run` takes one
queued run for one machine with `FOR UPDATE SKIP LOCKED` (priority, FIFO, per-queue cap, `depends_on`, need ≤ free −
reserve − in-flight needs), inside the machine's tenant transaction; the `Scheduler` in `serve` calls it for each live,
recently reported machine when woken by `LISTEN devrounds_scheduler` (NOTIFY on enqueue and run end), by a
`MachineReport`, or by a 15 s poll, and sends the `Offer` after the commit. Run ends settle the job (retry with backoff,
skip-on-red). Offers nobody answers expire, are withdrawn through `HelloAck.withdrawn` and requeued. Better Auth owns
identity in schema `auth`; the member auth hook takes a Bearer token first, then a read-only session cookie.

**Tech Stack:** as stage 1 (Node ≥24 TypeScript, Fastify 5, TypeBox, Kysely/pg, Postgres 17, `node:test`, Biome 2.6.8,
Rust 1.99.1 edition 2024, tokio-tungstenite), plus `better-auth` 1.7.25 (MIT, `serve` only, dynamic import) and a
dedicated `pg.Client` for `LISTEN`. React 19 + esbuild for `web/`.

**Spec:** `docs/superpowers/specs/2026-11-17-p1-spike-queue-and-auth.md` (§6 ruled, §7 is the checklist this plan
covers), `docs/superpowers/specs/2026-11-17-p1-foundation-design.md` (§3.1, §3.2, §7) and the parent
`C:/Users/Guilherme/Code/Clickmax/cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md` (§5.1, §5.3,
§5.4, §11.2, §11.6, §13, §16). Stage 1: `docs/superpowers/plans/2026-11-17-p1-stage-1-executor.md` and its ledger
`.superpowers/sdd/2026-11-17-p1-stage-1-executor/progress.md`. Paths below are relative to
`C:\Users\Guilherme\Code\devrounds`.

## Scope

In: queues, job batches with `depends_on`, the claim function, learned needs as a table, the scheduler loop with
LISTEN/NOTIFY and poll fallback, direct dispatch replaced, job outcomes (retry/backoff per job type, skip-on-red, stop of
queued runs), offer expiry with withdraw and requeue, crash recovery of offers, session heartbeats, scheduled jobs (the
table and its firing, for the P2 daily report), CLI retry with the same Idempotency-Key plus the idempotency-key sweep
(P1-T13), Better Auth session login (P1-T16), the minimal operational view (P1-T15), run indicators (P1-T18), the end
to end through the scheduler with the budgets, and the final whole-phase review.

Stage-1 deferrals folded in (ledger lines): learned needs as a table (stage-1 "Out") → Task 2; `depends_on`
skip-on-red not written (Task 1 minor) → Task 4; re-pair drops `otlp_endpoint` and resets admission tuning (Tasks 13
and 16 minors) → Task 5; reconnect backoff without jitter and no heartbeat on either side (Task 10 minor) → Task 5;
`stop` DR350 after an idempotent commit / Stop lost with the session (Task 13 minor) → Task 5 (an offered run on an
offline machine is withdrawn instead); expired idempotency keys never swept (idempotency.ts comment) → Task 7.

Out, with where it goes: gates and their job types, the per-worktree lock, the gate result cache (P2-T01..T07; P2-T02
consumes this plan's batches and `depends_on`); the daily improvement report itself (P2-T13; this plan only builds
schedules); a per-machine install concurrency cap (P2-T09); Workspace/Checkout tables (P2, `vcs` engine); `LogChunk`
live output (P5, first live consumer: SSE; the view polls, accepted P0 exception until P5); a generic outbox for
external side effects (the first messaging provider, P4+); choosing among several tenants per login (P6); password
change and member management in the web (P5); runs' duplicate `project_id/job_type_id/machine_id` without a composite
FK to `jobs` (stays parked for the final review triage); the supervise single-instance lock (P6 task exists).

## File Structure

```
control-plane/src/
  db/migrations/0010_queues.ts            queues, queue_job_types, job_batches, job_dependencies, jobs/runs changes
  db/migrations/0011_claim_run.ts         learned_needs, runs offer columns, claim_run()
  db/migrations/0012_job_retry.ts         job_types retry policy
  db/migrations/0013_offer_expiry.ts      expired_offers(), rearm_offers()
  db/migrations/0014_schedules.ts         schedules, jobs.schedule_id, due_schedules()
  db/migrations/00NN_idempotency_sweep.ts prune_idempotency_keys()          (lane A, numbered when it lands)
  db/migrations/00NN_auth.ts              schema auth, grants, members.user_id, resolve_session()  (lane B)
  queues/service.ts                       putQueue, listQueues, ensureQueue
  jobs/graph.ts, jobs/batch-file.ts, jobs/enqueue.ts, jobs/outcome.ts
  scheduler/notify.ts, scheduler/claim.ts, scheduler/scheduler.ts, scheduler/wake.ts, scheduler/expiry.ts,
  scheduler/schedules.ts
  auth/session.ts, auth/auth-migrate.ts
  runs/indicators.ts
  api/job-routes.ts (queues, batches, schedules), api/view-routes.ts (run/job lists, indicators)
web/src/  Login.tsx, MachinesPage.tsx, QueuesPage.tsx, JobsPage.tsx, RunsPage.tsx, RunPage.tsx, format.ts
executor/crates/protocol   HelloAck.withdrawn, feature "withdraw"
executor/crates/executor   runs.rs (withdraw), connection.rs (jitter, read timeout), pair.rs (keep config)
scripts/e2e/executor.e2e.ts   scheduler scenarios
```

## Global Constraints

- Every stage-1 Global Constraint still holds (P0 table rules, RLS forced, composite FKs, security definer hardening
  `set search_path = pg_catalog, public, pg_temp` + `revoke all … from public` + execute for the app role only, DR201
  for cross-tenant, codes only in `errors/words.ts`, no sync fs/child-process in `control-plane/src`, spawn only via
  `devrounds_sys_windows::spawn`, private bytes, never `/tmp`, signed English commits without trailers).
- The only exception to the table rule this plan adds: Better Auth's identity tables in schema `auth` (spike header).
  Nothing tenant-scoped is ever stored there.
- Every new referencing FK column gets an index (P1-T20 guard `0007_fk_indexes` style); every new table passes the
  catalog guard in `test-support/catalog.ts`.
- Migrations: 0010-0014 are fixed for the main path. Parallel lanes (Tasks 7, 8) name their migration with the next free
  number when they land on main (Kysely refuses out-of-order keys); a lane's private test DB is reset after renumbering.
- New error codes, all in the `x5x` block except DR402: DR152 `Jobs of batch {batch} depend on each other in a cycle:
  {cycle}.`, DR153 `Job type {jobType} is not allowed on queue {queue}.`, DR402 `A session cookie only reads; {method}
  {route} needs an API token.` AGENTS.md's x5x list gains DR152, DR153. Not-found adds `kind`: `queue`, `batch`,
  `schedule`.
- Scheduler values: NOTIFY channel `devrounds_scheduler`, payload = tenant id only. Poll `schedulerPollS` default 15
  (`DEVROUNDS_SCHEDULER_POLL_S`). Offer timeout `offerTimeoutS` default 120 (`DEVROUNDS_OFFER_TIMEOUT_S`). A machine
  is placeable only with a `MachineReport` received in the last 30 s. Reserve = `min(total / 10, 2 GiB)` (executor
  `default_reserve`). Need default 536870912. In-flight need = sum of `runs.memory_need` in `offered`/`admitted` on
  that machine. At most 64 claims per machine per tick.
- Retry defaults per job type: `max_attempts` 1 (1..10), `backoff_s` 30, doubling per attempt, capped at 3600 s;
  `retry_on` default `[infra]`, never `cancelled`. Requeues (cause `requeue`) never count as attempts.
- Withdrawn runs are listed in `HelloAck.withdrawn` for 7 days (= executor `RUN_DIR_RETENTION`). Close code 4408 =
  offer timeout (the executor reconnects as for any drop). Gateway ping every 15 s, session ended after 2 missed pongs;
  executor drops a session with no frame for 45 s; reconnect backoff 1 s → 30 s with ±20 % jitter.
- Better Auth: `better-auth@1.7.25` exact, `telemetry: { enabled: false }`, organizations plugin never installed,
  sign-up disabled, email/password only (min 12 chars), own Kysely pool `max: 2` as `devrounds_app` with
  `search_path=auth`, cookie prefix `devrounds`, non-secure cookies on loopback, base URL `http://127.0.0.1:<port>`,
  trusted origins `127.0.0.1` and `localhost` on that port. Loaded only by `serve` (dynamic import), never by the CLI.
- Budgets: executor ≤ 50 MB, control plane (`supervise` + `serve`) ≤ 300 MB private bytes idle, 1 MB = 1 000 000 bytes;
  projected ~203 MB with scheduler + Better Auth (spike §3).
- Lint is `rtk proxy pnpm lint` (the rtk hook rewrites `pnpm lint`; ledger note); every cargo command runs from
  `executor/` (`pnpm test:executor`, `pnpm lint:executor`).
- Tracker: each task's key gets `devrounds task start` at dispatch, criteria checked with `commit:` evidence, then
  `devrounds task done` (controller).

## Review Focus

1. A burst of 20 enqueues against one machine with 8 GiB free: the claims together never offer more need than free −
   reserve, because in-flight needs count before the executor reports the new usage. Test in Task 2.
2. The executor is offline past the offer timeout while it holds an offer it already admitted: after reconnect the
   withdrawn run never spawns and its requeued twin runs exactly once. Tests in Task 5 (Rust and TS).
3. `serve` dies between the claim commit and the `Offer` send, or stays down past the timeout: the run is re-offered
   after the next `HelloAck` or gets a fresh timeout, never expired at startup and never run twice. Tests in Tasks 3, 5.
4. A cross-site form posts to the API with the browser's session cookie: DR402, nothing changes. Test in Task 8.
5. `serve` is down while a daily schedule passes its time twice: on start it fires once, not twice. Test in Task 6.

## Calls made

Each was decided by Claude under Guilherme's standing rule for DevRounds ("don't wait for approval; record the call").

1. **The queued run is the queue unit; `runs.machine_id` and `jobs.machine_id` become nullable** (machine set at claim;
   `jobs.machine_id` now means "pinned"). Cost if wrong: a queue table later; runs keep their meaning.
2. **Offers are columns on the run (`offer_expires_at`, `offer_accepted_at`, `withdrawn_at`), not an `offers` table**
   (spike §7 named a table): an offer is 1:1 with a run attempt because an expired offer ends that run and a new run
   (cause `requeue`) is queued. Cost if wrong: one table plus a backfill.
3. **`claim_run` is security definer as ruled, but derives the tenant from the machine row and runs inside that
   tenant's transaction**, so it can never cross tenants (§11.4: a machine belongs to one tenant); a per-tenant
   `pg_advisory_xact_lock` makes the concurrency cap exact. Cost if wrong: claims of one tenant serialize (ms each).
4. **In-flight reservation**: the claim subtracts the needs of runs `offered`/`admitted` on the machine; `running` runs
   are already in the reported free memory. Cost if wrong: an over-offer the executor's start-gate still delays.
5. **NOTIFY for database-side changes (enqueue, run end, schedule fire), an in-process poke for `MachineReport` and
   `HelloAck`** (one `serve` in P1). Cost if wrong: one `pg_notify` per report when a second `serve` appears (P6).
6. **No generic outbox table in P1.** Every control-plane → executor command is derived from committed state and
   re-sent after each `HelloAck` (offered runs → `Offer`, orphan kill → `Stop`, withdrawn runs → `HelloAck.withdrawn`):
   the state change and the pending command are one committed row, which is what the transactional outbox guarantees.
   A generic outbox comes with the first external side effect (messaging provider). Cost if wrong: a table and a
   dispatcher later, nothing to migrate.
7. **Withdraw rides on `HelloAck` (feature `withdraw`) and an expired offer on a live session closes it with 4408**, so
   the executor drops withdrawn runs before it is "connected" and nothing can spawn in between; no new live message.
   Cost if wrong: a reconnect per expiry on a wedged executor (rare). An old executor without the feature would still
   run a withdrawn offer: acceptable while every executor ships with the control plane (one machine in P1).
8. **DR350 stays only for stopping an admitted/running run on an offline machine**; an offered run there is withdrawn at
   once, a queued one is stopped at once. `run start` never answers DR350 again (it queues).
9. **Job states `open | finished | failed | stopped | skipped`, run state `skipped` added.** Orphaned runs fail their
   job without retry (the process may still be alive under `let_finish`). Cost if wrong: one more transition.
10. **Retries are opt-in**: `max_attempts` default 1, `retry_on` default `[infra]`, exponential backoff capped at 1 h.
    Cost if wrong: one YAML field per job type.
11. **Batches (`job_batches`) are the "same gate" boundary for `depends_on`** in P1: edges are written by `ref` inside
    one batch file, so cross-batch edges cannot be expressed; P2 gates create one batch each. Cost if wrong: rename.
12. **Schedules: `every_s` (≥ 60) or `daily_at` HH:MM in the tenant time zone; fires missed while `serve` was down fire
    once; a fire is skipped while the schedule's previous job is still open.** Cost if wrong: a cron column later.
13. **Session cookies are read-only (GET/HEAD); mutations need a Bearer token (DR402).** The P1 view is read-only, so
    this removes CSRF from scope. Cost if wrong: an origin/CSRF check when the view starts mutating (P5).
14. **One tenant per login in P1** (`unique (user_id)` on members); `members.user_id` is `text` with no FK into `auth`
    (Better Auth owns that schema). Cost if wrong: drop the index and add a tenant picker (P6).
15. **`devrounds-admin migrate` runs Better Auth's migrations after ours and writes `authSecret` into `server.json` when
    missing** (32 random bytes, base64url, never rotated by migrate), since migrate is already the upgrade step.
    Without `authSecret` (`serve` started before migrate) session login is off and the token API still works.
16. **Logins are created by the operator** (`devrounds-admin login create|remove`), printing a generated password once;
    no self sign-up. Cost if wrong: an invite flow in P5.
17. **`run list` is the only new list CLI** (agents need it); jobs, queues and machines lists are web + existing CLI.

---

### Task 1: Queues, batches and the scheduling schema (P1-T43)

**Files:**

- Create: `control-plane/src/db/migrations/0010_queues.ts`, `control-plane/src/queues/{service.ts,service.test.ts}`,
  `control-plane/src/jobs/{graph.ts,graph.test.ts,batch-file.ts,enqueue.ts,enqueue.test.ts}`,
  `control-plane/src/scheduler/notify.ts`, `control-plane/src/api/job-routes.ts`
- Modify: `control-plane/src/db/{schema.ts,migrations/index.ts}`, `control-plane/src/runs/{states.ts,view.ts,record.ts}`,
  `control-plane/src/api/server.ts`, `control-plane/src/cli/commands.ts`, `control-plane/src/errors/{codes.ts,words.ts}`,
  `docs/errors.md`, `AGENTS.md`

**Interfaces:**

- Tables (all with `tenant_id`, forced RLS via `isolate()`, composite FKs, FK indexes):
  `queues(id, tenant_id, project_id, key, priority int not null default 0, concurrency int null check (concurrency >
  0), created_at, unique (project_id, key), unique (tenant_id, id))`;
  `queue_job_types(tenant_id, queue_id, job_type_id, primary key (queue_id, job_type_id))` (none = every job type);
  `job_batches(id, tenant_id, project_id, created_by, created_at, unique (tenant_id, id))`;
  `job_dependencies(tenant_id, job_id, depends_on_job_id, primary key (job_id, depends_on_job_id), check (job_id <>
  depends_on_job_id))`.
  `jobs`: `machine_id` drops not null (= pin); add `queue_id uuid not null` (backfill: one `default` queue per project
  that has jobs), `batch_id uuid null`, `ref text null` (`unique (batch_id, ref)`), `state text not null default
  'open' check in ('open','finished','failed','stopped','skipped')` (backfill from the job's last run: running states →
  `open`, `orphaned` → `failed`).
  `runs`: `machine_id` drops not null; state check adds `skipped`; add `not_before timestamptz not null default now()`,
  `memory_need bigint null`, `cause text not null default 'first' check in ('first','retry','requeue')`; partial index
  `runs_queued on runs (tenant_id, not_before) where state = 'queued'`.
- `scheduler/notify.ts`: `notifyScheduler(trx: Trx, tenantId: string): Promise<void>` (`select pg_notify('devrounds_scheduler', $1)`;
  delivered at commit, so a listener's claim sees the row).
- `queues/service.ts`: `ensureQueue(trx, projectId, key = 'default') -> QueueRow` (only `default` is created on first
  use; any other unknown key → DR201 `kind: 'queue'`); `putQueue(ctx, projectKey, { key, priority?, concurrency?:
  number | null, jobTypes?: string[] }) -> QueueView`; `listQueues(ctx, projectKey) -> QueueView[]` with `QueueView =
  { key, priority, concurrency: number | null, jobTypes: string[], depth: number, inFlight: number, oldestQueuedAt:
  Date | null }`.
- `jobs/graph.ts`: `checkGraph(batch: string, jobs: { ref: string; dependsOn: string[] }[]): void` — DR101 at
  `/jobs/<i>/depends_on/<j>` for an unknown ref, DR101 at `/jobs/<i>/ref` for a duplicate ref, DR152 with `cycle` =
  refs joined by " → " ending where it started (self-edge included).
- `jobs/batch-file.ts`: TypeBox `BatchInput = { jobs: [{ ref, job_type, cwd, machine?, queue?, task?, depends_on?:
  string[] }] }` (1..200 jobs), `parseBatchFile(text) -> BatchInput` (YAML through `yaml-file.ts`).
- `jobs/enqueue.ts`: `enqueueRun(ctx, { projectKey, jobTypeKey, cwd, machineName?, queueKey?, taskKey? }) -> RunView`
  (job without batch + run attempt 1, `queued`, then `notifyScheduler`); `submitBatch(ctx, projectKey, input:
  BatchInput) -> BatchView` (one transaction: graph check first, nothing inserted on any error);
  `batchView(ctx, projectKey, batchId) -> BatchView` with `BatchView = { id, jobs: [{ ref, jobId, runId, jobType,
  state }] }`. A pinned machine must be a live machine of the tenant (DR201 `kind: 'machine'`); a queue with job types
  that does not list this one → DR153. `createRun` (direct dispatch, still used until Task 3) sets `queue_id` from
  `ensureQueue`.
- `RunView` gains `queue: string`, `cause: 'first' | 'retry' | 'requeue'`, `notBefore: Date`; `machine` becomes
  `string | null`. `nextRunState` gains `skip` (`queued` → `skipped`, stamps `finished_at`); `stop` also from `queued`.
- Routes (`api/job-routes.ts`, under `/api/projects/:key`, members, mutations through `mutateIdempotent`):
  `PUT /queues/:queue { priority?, concurrency?: integer | null, jobTypes?: string[] }`, `GET /queues`,
  `POST /batches { jobs: [...] }` (JSON shape of `BatchInput`), `GET /batches/:id`.
- CLI: `devrounds queue set <key> [--priority <n>] [--concurrency <n>|none] [--job-types <a,b>]`, `devrounds queue
  list`, `devrounds batch submit <file.yaml>` (prints one line per job, `next: devrounds batch show <id>`),
  `devrounds batch show <id>` (failures first: failed/skipped jobs, then the rest).

- [ ] **Step 1: Failing tests.** `graph.test.ts`: `a diamond is accepted`; `a two-job cycle answers DR152 with cycle
      "a → b → a"`; `a self dependency answers DR152`; `an unknown ref answers DR101 at /jobs/1/depends_on/0`.
      `enqueue.test.ts`: `a batch creates one queued run per job, attempt 1, cause first, in the default queue, and the
      dependency edges`; `a batch with a cycle inserts nothing`; `a job type not listed by the queue answers DR153`;
      `an unknown queue answers DR201 kind queue`; `a pinned machine that is revoked answers DR201 kind machine`;
      `a batch of another tenant is not found (DR201)`; `enqueue notifies devrounds_scheduler with the tenant id after
      commit` (a test LISTEN client sees the payload only after the transaction commits). `service.test.ts`: `queue list
      reports depth, in flight and the oldest queued time`; `concurrency none clears the cap`. The catalog guard test
      covers the new tables without edits (it walks the catalog); `0007` FK-index guard covers the new FKs.
- [ ] **Step 2:** `pnpm test` → the new tests FAIL.
- [ ] **Step 3:** Implement; DR152, DR153 in words + `pnpm gen:errors`; AGENTS.md x5x list gains DR152, DR153.
- [ ] **Step 4:** `pnpm test`, `rtk proxy pnpm lint`, `pnpm typecheck` → PASS (existing dispatch tests still pass).
- [ ] **Step 5:** Commit "Queues, batches and depends_on edges for the scheduler".

### Task 2: claim_run and learned needs (P1-T44)

**Files:**

- Create: `control-plane/src/db/migrations/0011_claim_run.ts`, `control-plane/src/scheduler/{claim.ts,claim.test.ts}`
- Modify: `control-plane/src/db/{schema.ts,migrations/index.ts}`, `control-plane/src/runs/{learned-need.ts,record.ts}`

**Interfaces:**

- Consumes: tables of Task 1.
- Tables: `learned_needs(tenant_id, project_id, job_type_id, machine_id, need_bytes bigint not null, samples int not
  null, updated_at, primary key (project_id, job_type_id, machine_id))`, backfilled in the migration from `runs` (last
  10 peaks per key, `round(percentile_cont(0.5))`, same as `learnedNeed`). `runs` gains `offer_expires_at
  timestamptz null`, `offer_accepted_at timestamptz null`, `withdrawn_at timestamptz null` (used from Task 5).
- Function `claim_run(p_machine uuid, p_free bigint, p_reserve bigint, p_offer_timeout_s int) returns table (tenant_id
  uuid, run_id uuid, memory_need bigint)`, `language plpgsql volatile security definer`, hardened as Global
  Constraints. Algorithm (the order matters; the body is the implementer's):
  1. the machine row with `revoked_at is null`, else return nothing; its `tenant_id` is the only tenant considered;
  2. `pg_advisory_xact_lock(hashtextextended('devrounds.claim:' || tenant_id, 0))`;
  3. `in_flight` = sum of `memory_need` of the machine's runs in `offered`/`admitted`;
  4. one run: `state = 'queued'`, `not_before <= now()`, job pinned to nobody or this machine, every
     `job_dependencies` target job `finished`, queue `concurrency` null or its runs in `offered|admitted|running` below
     it, `coalesce(learned need for (project, job type, p_machine), 536870912) <= p_free - p_reserve - in_flight`;
     order `queues.priority desc, runs.queued_at, runs.id`; `for update of runs skip locked limit 1`;
  5. that run → `offered`, `machine_id`, `offered_at = now()`, `memory_need`, `offer_expires_at = now() +
     p_offer_timeout_s`; return it.
- `scheduler/claim.ts`: `defaultReserve(total: bigint): bigint` (`min(total / 10n, 2n << 30n)`); `claimRun(trx: Trx,
  machineId: string, o: { freeBytes: bigint; reserveBytes: bigint; offerTimeoutS: number }) -> { runId: string;
  memoryNeed: bigint } | null` (called inside `withTenant` of the machine's tenant).
- `runs/learned-need.ts`: `updateLearnedNeed(trx, projectId, jobTypeId, machineId): Promise<void>` (upsert from
  `learnedNeed`), called by `applyRunEvent` for a `RunFinished` with a peak, in the same transaction;
  `storedNeed(trx, projectId, jobTypeId, machineId) -> bigint` (row or 536870912n).

- [ ] **Step 1: Failing tests** in `claim.test.ts` (app-role connection, two tenants): `claims by queue priority, then
      FIFO`; `a job waits until every dependency job is finished`; `the queue cap counts offered, admitted and running
      runs`; `need must fit free minus reserve minus in-flight needs` (free 4 GiB, reserve 1 GiB, three queued at 1 GiB,
      one already offered at 1 GiB → one claim, then none); **Review Focus 1** `a burst of 20 claims never offers more
      need than free minus reserve` (8 GiB free, 1 GiB reserve, 20 queued at 512 MiB → exactly 14 offered);
      `learned need defaults to 536870912 and follows learned_needs`; `a run pinned to another machine is not claimed`;
      `a run with not_before in the future is not claimed`; `a revoked machine claims nothing`; `a queued run of another
      tenant is never returned`; `two concurrent claims never take the same run` (two pool connections, `Promise.all`);
      `public cannot execute claim_run; the app role can`; `a RunFinished with a peak updates learned_needs to the
      median of the last 10 peaks`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "claim_run with RAM-aware placement and learned needs as a table".

### Task 3: Scheduler loop replaces direct dispatch (P1-T08)

**Files:**

- Create: `control-plane/src/scheduler/{scheduler.ts,wake.ts,scheduler.test.ts}`
- Modify: `control-plane/src/runs/{dispatch.ts,dispatch.test.ts,record.ts}`, `control-plane/src/executor/gateway.ts`,
  `control-plane/src/api/{server.ts,run-routes.ts}`, `control-plane/src/main.ts`, `control-plane/src/config.ts`,
  `control-plane/src/cli/commands.ts`, `scripts/e2e/executor.e2e.ts` (drop `--machine` where the scheduler places),
  `AGENTS.md`, `README.md`

**Interfaces:**

- Consumes: `enqueueRun`, `notifyScheduler` (Task 1); `claimRun`, `defaultReserve` (Task 2); `offerOf`,
  `pendingOffers`, `Sessions` (stage 1).
- `Sessions` gains `list(): { machineId: string; tenantId: string }[]` and per session `report?: { at: number;
  availableMemory: bigint; totalMemory: bigint }` (set by the gateway on each `MachineReport`).
- `scheduler/wake.ts`: `listen(url: string, channel: string, onNotify: (payload: string) => void, log) -> { close():
  Promise<void> }` — one dedicated `pg.Client` (not the pool), reconnects 1 s → 30 s on error.
- `scheduler/scheduler.ts`: `new Scheduler({ db, sessions, offerTimeoutS, pollMs, telemetry, log, now? })`;
  `start(listenUrl: string): Promise<void>` (LISTEN + poll timer); `poke(tenantId: string): void`; `tick(): Promise<void>`
  (one at a time; a poke during a tick sets a rerun flag); `stop(): Promise<void>`. A tick, per poked tenant (every
  tenant with a live session on the poll): placeable machines (report ≤ 30 s old) sorted by `available − reserve −
  in-flight` descending; per machine, up to 64 times: `withTenant` → `claimRun` → null ends this machine; else
  `telemetry.runDispatched`, trace ids on the run, `offerOf` with the claimed `memory_need` → commit → `sessions.send`.
  A failed send leaves the run offered; `pendingOffers` re-sends it after the next `HelloAck` (Task 5 adds expiry).
- `recordDispatch`/`dispatchRun`/`connectedMachine` are removed; `POST /runs { jobType, cwd, machine?, queue?, task? }`
  calls `enqueueRun` (Idempotency-Key as before; the Offer comes from the scheduler, so a replay offers nothing).
- `record.ts`: every terminal transition and `RunFinished` call `notifyScheduler` in their transaction.
- `gateway.ts`: after `HelloAck` and after each `MachineReport` → `scheduler.poke(tenantId)` (optional `scheduler` in
  `GatewayOptions`; `buildServer` passes it).
- `serve`: builds the `Scheduler` with `config.databaseUrl` for LISTEN, starts it after `listen`, stops it first on
  shutdown. Config `schedulerPollS` (`DEVROUNDS_SCHEDULER_POLL_S`, default 15, > 0), `offerTimeoutS`
  (`DEVROUNDS_OFFER_TIMEOUT_S`, default 120, ≥ 5); DR502 otherwise.
- CLI: `devrounds run start <jobType> --cwd <path> [--machine <name>] [--queue <key>] [--task <key>]` prints `run <id>
  queued · <jobType>[ on <machine>]`, `next: devrounds run show <id> --wait`. AGENTS.md: the run line becomes
  `devrounds run start <jobType> --cwd <path> [--machine <name>]`; `agent-docs.test.ts` parses it.

- [ ] **Step 1: Failing tests** in `scheduler.test.ts` (fake executor over `WebSocket`, as `dispatch.test.ts`):
      `an enqueued run is offered within 1 s through NOTIFY` (poll 60 s, so only NOTIFY can wake it); `with LISTEN
      unreachable the poll still offers within one interval` (poll 200 ms, bad listen URL); `a machine without a report
      in the last 30 s gets no offer`; `placement prefers the machine with more free memory`; `run start with no
      machine connected queues the run and offers it once one connects` (no DR350); `the Offer carries memory_need from
      the claim`; **Review Focus 3** `a claim whose Offer send failed is re-sent after the next HelloAck and admitted
      once` (close the fake socket between claim and send; reconnect; one Admitted applied); `a MachineReport that frees
      memory wakes the scheduler`. Remove the `dispatch.test.ts` cases that assert DR350 on dispatch.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm test`, lint, typecheck, `pnpm e2e` (scheduler
      places synthetic and lint) → PASS.
- [ ] **Step 5:** Commit "Scheduler on LISTEN/NOTIFY and poll replaces direct dispatch".

### Task 4: Job outcomes: retries, backoff and skip-on-red (P1-T45)

**Files:**

- Create: `control-plane/src/db/migrations/0012_job_retry.ts`, `control-plane/src/jobs/{outcome.ts,outcome.test.ts}`
- Modify: `control-plane/src/job-types/{file.ts,service.ts,job-types.test.ts}`, `control-plane/src/runs/{record.ts,dispatch.ts,states.ts}`,
  `control-plane/src/db/{schema.ts,migrations/index.ts}`

**Interfaces:**

- Consumes: Tasks 1-3.
- `job_types` gain `max_attempts int not null default 1 check (max_attempts between 1 and 10)`, `retry_backoff_s int
  not null default 30 check (retry_backoff_s >= 0)`, `retry_on text[] not null default '{infra}'`. Job type YAML:
  `retry: { max_attempts?, backoff_s?, on?: FailureClass[] }`; `cancelled` in `on` → DR101 at `/retry/on/<i>`.
- `jobs/outcome.ts`: `settleJob(trx: Trx, tenantId: string, runId: string) -> { retryRunId: string | null; skipped:
  string[] }`, called in the transaction of every terminal run transition (`applyRunEvent` finish/fail/stop,
  `applyOrphans`, `failRevokedRuns`, stop of a queued run). Rules: `finished` → job `finished`; `failed` with class in
  `retry_on` and attempts (runs with cause `first`/`retry`) < `max_attempts` → new run `attempt + 1`, cause `retry`,
  `not_before = finished_at + min(backoff_s × 2^(attempts − 1), 3600) s`, job stays `open`; other `failed` and
  `orphaned` → job `failed`; `stopped` → job `stopped` (a requeue from Task 5 is not a stop of the job). A job that
  ends `failed`/`stopped`/`skipped` skips every open job reachable through `job_dependencies` (recursive CTE): job
  `skipped`, its queued run → `skipped` with `failure_summary` `skipped: dependency <ref or job id> <state>`. A
  finished job or a new retry run calls `notifyScheduler`.
- `prepareStop` on a `queued` run ends it `stopped`/`cancelled` at once (no executor), then `settleJob`. Manual
  `retryRun` creates cause `retry` and sets the job back to `open`.

- [ ] **Step 1: Failing tests** in `outcome.test.ts`: `a red dependency skips every dependent transitively and none is
      ever offered`; `a retryable failure queues attempt 2 with not_before 30 s after the end, attempt 3 at 60 s`;
      `check_red is not retried with the default policy`; `retries stop at max_attempts and the job fails`; `a stopped
      job skips its dependents`; `stop of a queued run ends it cancelled without an executor`; `a finished dependency
      lets the dependent be claimed`; `an orphaned run fails its job without a retry`. `job-types.test.ts`: `retry.on
      cannot name cancelled (DR101 at /retry/on/0)`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "Job outcomes: retry with backoff per job type and skip-on-red".

### Task 5: Offer expiry, withdraw, crash recovery and heartbeats (P1-T46)

**Files:**

- Create: `control-plane/src/db/migrations/0013_offer_expiry.ts`, `control-plane/src/scheduler/{expiry.ts,expiry.test.ts}`,
  `executor/crates/executor/tests/withdraw.rs`
- Modify: `control-plane/src/executor/{gateway.ts,gateway.test.ts,protocol.ts}`, `control-plane/src/runs/{record.ts,dispatch.ts}`,
  `control-plane/src/scheduler/scheduler.ts`, `control-plane/src/main.ts`, `executor/crates/protocol/{src/lib.rs,fixtures/HelloAck.json}`,
  `executor/crates/executor/src/{runs.rs,connection.rs,pair.rs}`, `executor/crates/executor/tests/{connection.rs,run_loop.rs}`

**Interfaces:**

- Consumes: offer columns (Task 2), `settleJob` (Task 4), `Scheduler` (Task 3).
- Functions (security definer, as `expired_log_segments`): `expired_offers() returns table (tenant_id uuid, run_id uuid,
  machine_id uuid)` (`offered`, `offer_accepted_at is null`, `offer_expires_at < now()`); `rearm_offers(p_timeout_s int)
  returns int` (every unaccepted offered run gets `offer_expires_at = now() + p_timeout_s`).
- `applyRunEvent`: the first event of an offered run sets `offer_accepted_at` (a `Delayed` keeps the offer alive).
- `scheduler/expiry.ts`: `expireOffers(db, sessions, offerTimeoutS, log) -> string[]` (machine ids to close). Per row,
  in `withTenant`, if still offered and unaccepted: run → `stopped`, `failure_class 'infra'`, `failure_summary` `offer
  not answered within <n> s by <machine>; requeued as run <id>`, `withdrawn_at = now()`; new run of the same job,
  `attempt + 1`, cause `requeue`; `notifyScheduler`. After commit, a machine with a live session is closed with
  `CLOSE_OFFER_TIMEOUT = 4408`. Each scheduler tick runs it first. `serve` calls `rearm_offers(offerTimeoutS)` before
  its first tick, so offers left by a crash get a full timeout once executors reconnect.
- Stop of an `offered` run whose machine has no live session: run `stopped`/`cancelled`, `withdrawn_at = now()`,
  `settleJob`; DR350 remains for `admitted`/`running` on an offline machine.
- Protocol: `FEATURES` += `"withdraw"` (Rust and TS, ours' order); `HelloAck { …, withdrawn: Vec<String> }` with
  `#[serde(default)]`, sent non-empty only when the session negotiated `withdraw`: runs of this machine with
  `withdrawn_at > now() - 7 days`. `HelloAck.json` fixture gains one id.
- Gateway: `socket.ping()` every 15 s; two pongs missed → `terminate()` → the session ends (no more claims for it).
- Executor: `RunLoop::handle(HelloAck)` runs before `Connection` sets `connected = true` (keep that order, assert it in
  a test); each withdrawn run that is active and not spawned is dropped (its `Admitting` dropped, `forget_run`, run
  dir removed, no event); a spawned one is stopped as for `Stop { cancel }`; an unknown one is ignored.
  `pair` keeps `admission` and `otlp_endpoint` from an existing `config.json`. Reconnect backoff gets ±20 % jitter;
  a session with no frame (ping included) for 45 s is dropped and redialed.

- [ ] **Step 1: Failing tests.** TS (`expiry.test.ts`, `gateway.test.ts`): `an unanswered offer expires after the
      timeout: run stopped/infra, a requeue run of the same job queued`; `a Delayed answer keeps the offer past the
      timeout`; **Review Focus 3** `serve start re-arms pending offers instead of expiring them`; `HelloAck lists
      withdrawn runs of the last 7 days only to an executor with the withdraw feature`; `a late Admitted for a withdrawn
      run is skipped and changes nothing`; `requeue does not count toward max_attempts`; `stop of an offered run on an
      offline machine ends it at once and withdraws it`; `a session that stops answering pings ends within 45 s and gets
      no offers`; `an expired offer on a live session closes it with 4408`. Rust: **Review Focus 2**
      `withdrawn_run_waiting_in_the_gate_never_spawns_and_emits_nothing` (window full → Offer → HelloAck withdrawn → slot
      frees → no `RunStarted`, store forgets it); `withdrawn_unknown_run_is_ignored`;
      `hello_ack_reaches_the_handler_before_connected`; `repair_keeps_admission_and_otlp_endpoint`;
      `backoff_has_jitter_within_20_percent`; `silent_control_plane_is_dropped_after_45_s` (`tokio::time::pause`);
      `every_fixture_round_trips` covers `HelloAck.withdrawn`.
- [ ] **Step 2:** Run `pnpm test`, `pnpm test:executor` → FAIL.
- [ ] **Step 3:** Implement both sides.
- [ ] **Step 4:** `pnpm test`, `pnpm test:executor`, lint both, typecheck → PASS.
- [ ] **Step 5:** Commit "Offer expiry with withdraw and requeue, offer re-arm on start, session heartbeats".

### Task 6: Scheduled jobs (P1-T47)

**Files:**

- Create: `control-plane/src/db/migrations/0014_schedules.ts`, `control-plane/src/scheduler/{schedules.ts,schedules.test.ts}`
- Modify: `control-plane/src/scheduler/scheduler.ts`, `control-plane/src/api/job-routes.ts`, `control-plane/src/cli/commands.ts`,
  `control-plane/src/db/{schema.ts,migrations/index.ts}`

**Interfaces:**

- Consumes: `enqueueRun` internals (Task 1), job states (Task 4), the poll tick (Task 3).
- `schedules(id, tenant_id, project_id, key, job_type_id, cwd, queue_id, machine_id null, every_s int null check
  (every_s >= 60), daily_at time null, check (num_nonnulls(every_s, daily_at) = 1), enabled bool not null default
  true, next_due_at timestamptz not null, last_job_id uuid null, created_by, updated_at, unique (project_id, key),
  unique (tenant_id, id))`; `jobs.schedule_id uuid null`. Security definer `due_schedules(p_now timestamptz) returns
  table (tenant_id uuid, schedule_id uuid)`.
- `nextDue(trx, schedule, after: Date, timezone: string) -> Date`: `every_s` → `after + every_s`; `daily_at` → the
  next `HH:MM` strictly after `after` in the tenant time zone, computed in SQL (`(date_trunc('day', after at time zone
  tz) + daily_at) at time zone tz`, + 1 day when not after).
- `fireDueSchedules(db, now, log) -> number`: per due row, `withTenant`, `for update skip locked` on the schedule; if
  `last_job_id`'s job is `open` → skip (logged); else a job (`schedule_id` set, `created_by` = schedule creator) + run
  queued + `notifyScheduler`, `last_job_id` set; in both cases `next_due_at = nextDue(now)` (a long outage fires once).
  Called by every scheduler tick.
- `putSchedule(ctx, projectKey, { key, jobType, cwd, queue?, machine?, everyS?, dailyAt?, enabled? }) ->
  ScheduleView`; `listSchedules(ctx, projectKey) -> ScheduleView[]` (`{ key, jobType, every, dailyAt, enabled,
  nextDueAt, lastJob: { id, state } | null }`). Routes `PUT /schedules/:schedule`, `GET /schedules`.
- CLI: `devrounds schedule set <key> --job-type <jt> --cwd <path> (--daily HH:MM | --every <seconds>) [--queue <key>]
  [--machine <name>] [--disable]`, `devrounds schedule list` (next due shown in the tenant time zone).

- [ ] **Step 1: Failing tests:** `a due schedule enqueues one job and moves next_due_at`; `daily 06:00 in
      America/Sao_Paulo is due at 09:00Z`; `a fire is skipped while the previous job is open`; **Review Focus 5**
      `a schedule missed twice while serve was down fires once`; `two ticks at once fire a due schedule once`; `a
      disabled schedule never fires`; `every below 60 s answers DR101 at /everyS`; `--daily 25:00 answers DR101`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "Scheduled jobs driven by the scheduler tick".

### Task 7: Idempotency and outbox (P1-T13) — parallel lane A, from the start

**Files:**

- Create: `control-plane/src/db/migrations/00NN_idempotency_sweep.ts`
- Modify: `control-plane/src/cli/{commands.ts,cli.test.ts}`, `control-plane/src/api/idempotency.ts`, `control-plane/src/main.ts`,
  `control-plane/src/db/migrations/index.ts`

**Interfaces:**

- `apiFor(...).send` draws one Idempotency-Key per invocation; after a `TimeoutError` or a dropped connection (any
  failure other than `ECONNREFUSED`) it sends the same method, path, body and key once more; a second such failure is
  the existing `Unreachable` "outcome unknown" with `next: devrounds events`. Routes exempt from Idempotency-Key
  (`POST /machines/pairing-codes`) are never retried.
- Security definer `prune_idempotency_keys(p_cutoff timestamptz) returns int` (deletes rows older than the cutoff
  across tenants; data never leaves the function); `serve` calls it with `now() - 24 h` on the hourly prune timer.
- The derived outbox (Call 6) is documented where it lives: a comment on `pendingOffers` and on the gateway's
  post-`HelloAck` re-send (Task 5 file), no new table.

- [ ] **Step 1: Failing tests** (`cli.test.ts`, local HTTP server on `127.0.0.1:0`): `a mutation that times out is sent
      once more with the same Idempotency-Key and its answer is printed` (first request held past `timeoutMs`; the
      server records both keys equal); `a refused connection is not retried`; `two timeouts report outcome unknown with
      next: devrounds events`; `machine pair-code is not retried`; `idempotency keys older than 24 h are pruned`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "CLI retries a timed-out mutation once with the same Idempotency-Key".

### Task 8: Session login with Better Auth (P1-T16) — parallel lane B, from the start

**Files:**

- Create: `control-plane/src/auth/{session.ts,auth-migrate.ts,session.test.ts}`, `control-plane/src/db/migrations/00NN_auth.ts`,
  `web/src/Login.tsx`
- Modify: `control-plane/src/api/{members.ts,server.ts}`, `control-plane/src/{admin.ts,admin.test.ts,config.ts,main.ts}`,
  `control-plane/src/db/{migrate.ts,schema.ts,migrations/index.ts}`, `control-plane/src/test-support/catalog.ts`,
  `control-plane/package.json`, `control-plane/src/errors/{codes.ts,words.ts}`, `docs/errors.md`,
  `web/src/{api.ts,main.tsx}`, `AGENTS.md`, `README.md`

**Interfaces:**

- Migration (owner): `create schema auth`; `grant usage on schema auth to <app>`; `alter default privileges in schema
  auth grant select, insert, update, delete on tables to <app>`; `members.user_id text null` + `create unique index
  members_user on members (user_id) where user_id is not null`; security definer `resolve_session(p_user_id text)
  returns table (tenant_id uuid, member_id uuid, kind text)` (human members only).
- `auth/auth-migrate.ts`: `migrateAuth(adminUrl: string, appRole: string, secret: string): Promise<void>` — Better
  Auth `getMigrations(options)` on an owner pool with `search_path=auth`, `runMigrations()`, then `grant select,
  insert, update, delete on all tables in schema auth to <app>`. `migrateToLatest` calls it after the Kysely
  migrations. `devrounds-admin migrate` writes `authSecret` into `server.json` when missing (`owner-only.ts`).
- `config.ts`: `authSecret` (`DEVROUNDS_AUTH_SECRET` or file) in `ServerConfig`, optional.
- `auth/session.ts`: `startAuth(o: { databaseUrl, port, secret }) -> Promise<SessionAuth>` (dynamic `import('better-auth')`,
  options of Global Constraints); `SessionAuth = { handler(req, res): Promise<void>; userOf(headers: Headers):
  Promise<string | null>; close(): Promise<void> }`. `serve` builds it only when `authSecret` is set.
- `server.ts`: `ServerOptions.sessionAuth?: SessionAuth`; route `GET|POST /api/auth/*` hijacks to `handler`.
- `members.ts` hook: `Authorization` present → `resolveToken` only (DR401 on failure, no cookie fallback); else a
  `devrounds.session_token` cookie with `sessionAuth` → `userOf` → `resolve_session` → owner; that path on a method
  other than GET/HEAD → DR402 `{ method, route }`; otherwise DR401.
- Admin: `devrounds-admin login create --tenant <name> --member <name> --email <email>` (human member, else DR453
  `action: 'log in'`; a member that already has a login → DR101 `path: '--member'`,
  `reason: 'already has a login; remove it first'`); prints the generated 20-char password once.
  `devrounds-admin login remove --tenant <name> --member <name>` deletes the Better Auth user and clears `user_id`.
  The admin builds a Better Auth instance with sign-up enabled on the owner connection for `create` only.
- Web: `Login.tsx` posts `{ email, password }` to `/api/auth/sign-in/email`; signed-in state from `GET
  /api/auth/get-session`; sign out `POST /api/auth/sign-out`; `request()` sends no Authorization header; a DR401 shows
  the form; the old `devrounds.token` localStorage key is removed on load.
- AGENTS.md: remove the accepted exception "The web view uses a pasted API token…"; add under accepted exceptions
  "Better Auth identity tables in schema `auth` (no `tenant_id`, no RLS); tenant data never goes there; the schema is
  created by `devrounds-admin migrate`, never by `serve`". The catalog guard skips schema `auth` by name only.
- Code: DR402.

- [ ] **Step 1: Failing tests** (`session.test.ts`, `buildServer` + `inject`, a login created through the admin
      function): `a member logs in with email and password and reads the plan with the cookie`; **Review Focus 4** `a
      POST with only the session cookie answers DR402 and changes nothing`; `a Bearer token wins over a cookie and a
      bad Bearer answers DR401 even with a valid cookie`; `sign-up through /api/auth answers an error and creates no
      user`; `a user linked to no member answers DR401`; `a session of tenant A reading tenant B's project answers
      DR201`; `the app role has DML but no DDL on schema auth, and serve never creates it` (catalog query); `login
      create refuses an agent member (DR453)`; `without authSecret /api/auth answers DR202 (no route) and tokens still work`.
      `admin.test.ts`: `migrate writes authSecret once and keeps it`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; `pnpm gen:errors`; `cd web && pnpm build`.
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS; open the built view on a test `serve`, log in, screenshot the
      roadmap (criterion evidence `note:`).
- [ ] **Step 5:** Commit "Session login with Better Auth; the web view drops the pasted token".

### Task 9: Minimal operational view (P1-T15) — after Tasks 4 and 8; may run beside Tasks 5-6

**Files:**

- Create: `control-plane/src/api/view-routes.ts`, `control-plane/src/api/view-routes.test.ts`,
  `web/src/{MachinesPage.tsx,QueuesPage.tsx,JobsPage.tsx,RunsPage.tsx,RunPage.tsx,format.ts,format.test.ts}`
- Modify: `control-plane/src/api/server.ts`, `control-plane/src/machines/service.ts`, `control-plane/src/cli/commands.ts`,
  `web/src/{main.tsx,api.ts,style.css}`

**Interfaces:**

- Consumes: `RunView`, `listQueues`, `batchView`, job states, `readRunLog`, `listMachines`.
- Routes (`/api/projects/:key`, read-only): `GET /runs?state=&jobType=&queue=&cursor=&limit=` (1..100, default 50)
  → `{ runs: RunSummary[], nextCursor: string | null }`, newest `queued_at` first, keyset cursor over `(queued_at, id)`
  base64url; `RunSummary = { id, state, attempt, cause, jobType, queue, machine, queuedAt, finishedAt, failureClass,
  totalMs }`. `GET /jobs?state=&cursor=&limit=` → `{ jobs: JobSummary[], nextCursor }`, `JobSummary = { id, ref,
  batch, jobType, state, attempts, dependsOn: string[], lastRun: { id, state, failureClass } }`.
  `MachineView` gains `freeBytes`, `reservedBytes` (in-flight needs), `reserveBytes`, `reportAt`.
- CLI: `devrounds run list [--state <s>] [--job-type <k>]` (failures first, 16 KiB budget with `--cursor`).
- Web (hash routes, 10 s poll — P0 exception until P5): `#/machines`, `#/queues`, `#/jobs`, `#/runs`, `#/run/<id>`
  (outcome and failure summary first, then timeline, durations, resources, steps, delays, then the log page with a
  "more" link following `nextCursor`). `format.ts`: `formatBytes(n) -> string` (binary units, `536870912` → `512 MiB`),
  `formatDuration(ms) -> string` (`65000` → `1m 05s`, null → `—`).

- [ ] **Step 1: Failing tests:** `run list pages newest first with an exact cursor continuation`; `run list filters by
      state and job type`; `another tenant's runs and jobs never appear`; `job list shows dependsOn refs and the last
      run`; `machine list reports free, reserved and reserve bytes`; `format.test.ts` values above.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement routes, CLI and pages; `cd web && pnpm build`.
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS; screenshots of each page on a test `serve` with a finished,
      failed, skipped and queued run (criterion evidence).
- [ ] **Step 5:** Commit "Minimal operational view: machines, queues, jobs, runs and logs".

### Task 10: Resource and queue-time indicators (P1-T18) — after Task 9

**Files:**

- Create: `control-plane/src/runs/{indicators.ts,indicators.test.ts}`
- Modify: `control-plane/src/api/view-routes.ts`, `control-plane/src/cli/commands.ts`, `web/src/BalancePage.tsx`

**Interfaces:**

- `runIndicators(ctx, projectKey, { period: 'day' | 'week'; from: Date; to: Date }) -> IndicatorRow[]`, one row per
  (local calendar period of `finished_at` in the tenant time zone, Monday weeks, job type): `{ period: string /*
  YYYY-MM-DD */, jobType, runs, finished, failed, skipped, failureClasses: Partial<Record<FailureClass, number>>,
  retries, requeues, queueWaitP50Ms, queueWaitP90Ms, admissionDelayP50Ms, runTimeP50Ms, runTimeP90Ms, peakP50Bytes,
  peakMaxBytes, cpuSeconds }` (`percentile_cont`, nulls when no sample). Windows and caps as `getBalance`.
- `indicatorsNow(ctx, projectKey) -> { queues: { key, depth, oldestWaitMs }[]; machines: { name, freeBytes,
  reservedBytes, reserveBytes }[]; learnedNeeds: { jobType, machine, needBytes, samples }[] }`.
- Routes `GET /indicators?period=&from=&to=`, `GET /indicators/now`. CLI `devrounds indicators [--period day|week]
  [--from <date>] [--to <date>]` (failures first: classes with failures, then the table). Web: a "Runs" section on the
  Balance page.

- [ ] **Step 1: Failing tests:** `p50 and p90 of queue wait and run time per job type per local day` (run times 1..10 s
      → p50 5500 ms, p90 9100 ms); `a run finished at 02:30Z counts on the previous day in America/Sao_Paulo`; `failure
      classes include unclassified`; `retries and requeues are counted by cause`; `now reports the oldest wait per
      queue and reserved vs free per machine`; `another tenant's runs are not counted`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "Run indicators: queue wait, run time, failure classes, resources".

### Task 11: End to end through the scheduler, budgets and the live install (P1-T48)

**Files:**

- Create: `roadmap/fixtures/job-types/{flaky.yaml,dag-build.yaml,dag-test.yaml}`, `roadmap/fixtures/batches/dag.yaml`
- Modify: `scripts/e2e/executor.e2e.ts`, `executor/crates/test-fixtures/src/bin/tree-fixture.rs` (`--fail-once <path>`:
  exit 1 and create the file when it is missing, else go on), `README.md`, `AGENTS.md`

**Interfaces:**

- e2e (`DEVROUNDS_OFFER_TIMEOUT_S=5`, `DEVROUNDS_SCHEDULER_POLL_S=2` for its `serve`): every run placed by the
  scheduler (no `--machine`); scenarios: `dag` (green build → test finished; red build → test `skipped`, never
  offered); `retry` (`flaky`: `retry: { max_attempts: 2, on: [check_red] }`, exit 1 classified `check_red` → attempt 2
  finishes); `expiry` (executor `run` stopped, a pinned run enqueued, after 5 s it is `stopped`/`infra` with a requeue
  run; executor started → the requeue run finishes, the first never has `started_at`); `schedule` (`--every 60` fires
  within 75 s and finishes); stage-1 scenarios kept (synthetic, lint, orphan, re-pair). After 60 s idle the e2e `serve`
  alone is ≤ 230 000 000 private bytes (early warning; `supervise` is measured live below).

- [ ] **Step 1:** Write the scenarios and fixtures; `pnpm e2e` → FAIL until Tasks 1-10 are in.
- [ ] **Step 2:** `pnpm e2e`, `pnpm test`, `pnpm test:executor`, lint both, typecheck, `pnpm devlanes-sync` → PASS.
- [ ] **Step 3 (controller, live):** `devrounds-admin migrate` on the live database; restart task `DevRounds`; rebuild
      release, `devrounds-executor service install` (blocked until the 19/11 Kaspersky incident is cleared: exclusions +
      reboot, then the `DevRoundsExecutor` name must register again; if it still fails, stop and ask Guilherme, do not
      rename the task); `devrounds-admin login create` for Guilherme's member, web login screenshot; synthetic through the
      scheduler without `--machine`; after 60 s idle `pnpm footprint` → PASS. Check P1 criteria 1-3 with `commit:` and
      `note:` evidence (footprint output, run id).
- [ ] **Step 4:** README (queues, batches, schedules, login create, view); commit "End to end through the scheduler".

### Task 12: Final whole-phase review (P1-T49)

- [ ] **Step 1:** Dispatch the whole-branch review (opus, `references/final-review.md`) over stage 2's range plus a
      whole-phase pass on P1's contracts, with the parked lines of both ledgers for triage.
- [ ] **Step 2:** One fix wave for Critical/Important and the triaged minors; scoped re-review until clean.
- [ ] **Step 3:** Check P1 criterion 4 with the review evidence; `devrounds task done P1-T49`; the phase closes
      itself when every task and criterion is done.

---

## Order and parallelism

Main path (shared `record.ts`, `scheduler.ts`, `gateway.ts`; sequential on `main`): Task 1 → 2 → 3 → 4 → 5 → 6 → 11 →
12. Lane A (Task 7) and lane B (Task 8) start at once in worktrees under `.superpowers/worktrees/` with private test
databases (`devrounds_test_lane_a`, `_lane_b`); each lands by rebase onto `main` with its migration renumbered to the
next free key. Task 9 starts after Tasks 4 and 8 have landed and may run beside Tasks 5-6 (it touches `view-routes.ts`
and `web/` only, plus one registration line in `server.ts` and `machines/service.ts`); Task 10 follows Task 9. Task 11
needs everything before it.

## Not settled here

- The executor scheduled task name `DevRoundsExecutor` is rejected by Task Scheduler since the 19/11 Kaspersky
  disinfection; the live part of Task 11 waits on exclusions + reboot and may need Guilherme.
- Whether `devrounds plan import` updates the title of an existing task (P1-T08): if it only adds criteria, the old
  title stays; not worth a change.
- Better Auth 1.7.25's id column type under `generateId: 'uuid'` was not read from its schema; `members.user_id` is
  `text` so either works.

---

## Import list (stage 2)

Narrows P1-T08 to the scheduler loop and adds criteria to P1-T13, T15, T16, T18; new keys from P1-T43 (P1-T41 was never
used). Wrapped in the project/phase envelope when imported, as stage 1.

```yaml
- key: P1-T43
  title: Queues, batches and the scheduling schema
  phase: P1
  criteria:
    - A batch creates one queued run per job with its depends_on edges; a cycle answers DR152 and inserts nothing
    - A job type not allowed on its queue answers DR153; the default queue is created on first use
- key: P1-T44
  title: claim_run and learned needs
  phase: P1
  blocked_by: [P1-T43]
  criteria:
    - claim_run orders by queue priority then FIFO, honours the queue cap, depends_on and pins, and claims only the machine's tenant
    - A burst of claims never offers more need than free memory minus reserve minus in-flight needs
    - Learned needs live in a table updated from run peaks, 512 MiB without history
- key: P1-T08
  title: Queues and placement - scheduler replaces direct dispatch
  phase: P1
  blocked_by: [P1-T44]
  criteria:
    - An enqueued run is offered within 1 s through LISTEN/NOTIFY, and within one poll interval with LISTEN down
    - run start queues without a connected machine; the scheduler places it when one connects
    - An Offer lost between claim and send is re-sent after the next HelloAck and runs once
- key: P1-T45
  title: Job outcomes - retries, backoff and skip-on-red
  phase: P1
  blocked_by: [P1-T08]
  criteria:
    - A retryable failure queues the next attempt with doubling backoff up to max_attempts
    - A red, stopped or skipped dependency skips every dependent, none of them ever offered
- key: P1-T46
  title: Offer expiry, withdraw, crash recovery and heartbeats
  phase: P1
  blocked_by: [P1-T45]
  criteria:
    - An unanswered offer expires, is withdrawn through HelloAck and requeued; Delayed keeps it
    - A withdrawn run waiting in the executor's gate never spawns; serve start re-arms pending offers
    - Dead sessions end within 45 s on both sides; re-pair keeps admission and otlp_endpoint
- key: P1-T47
  title: Scheduled jobs
  phase: P1
  blocked_by: [P1-T46]
  criteria:
    - A due schedule enqueues one job; fires missed while serve was down fire once; an open previous job skips the fire
- key: P1-T13
  title: Idempotency and outbox
  phase: P1
  criteria:
    - The CLI retries a timed-out mutation once with the same Idempotency-Key
    - Idempotency keys older than 24 h are pruned hourly
- key: P1-T16
  title: Session login with Better Auth
  phase: P1
  criteria:
    - A human member logs in to the web view with email and password; the pasted-token exception is removed from AGENTS.md
    - A session cookie only reads (DR402 on mutations); a Bearer token wins over a cookie
    - Better Auth tables live in schema auth, created by devrounds-admin migrate, never by serve
- key: P1-T15
  title: Minimal operational view (jobs, runs, logs, machines)
  phase: P1
  blocked_by: [P1-T45, P1-T16]
  criteria:
    - The view shows machines (free, reserved), queues, jobs, runs and a run with its logs, tenant-scoped
    - run list pages with an exact cursor continuation
- key: P1-T18
  title: Resource and queue-time indicators (spec §13)
  phase: P1
  blocked_by: [P1-T15]
  criteria:
    - Queue wait and run time p50/p90 and failure classes per job type per local calendar day
    - Reserved vs free memory per machine, oldest wait per queue and learned need per job type are shown
- key: P1-T48
  title: End to end through the scheduler, budgets and the live install
  phase: P1
  blocked_by: [P1-T47, P1-T13, P1-T18]
  criteria:
    - pnpm e2e passes the DAG, retry, offer-expiry and schedule scenarios with every run placed by the scheduler
    - pnpm footprint passes on the installed services with the scheduler and Better Auth loaded
- key: P1-T49
  title: Final whole-phase review
  phase: P1
  blocked_by: [P1-T48]
  criteria:
    - The whole-phase review has no open Critical or Important finding
```
