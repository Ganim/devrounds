# DevRounds P2 Stage 1 (Gates Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DevRounds runs a repo's pre-PR gate as one entity (checks with arguments and env values, one worktree at a
time, a result cache by caller key, per-machine queue caps and starting memory needs), measures gates, runs its own
gates on itself, and opens deduplicated roadmap tasks from a daily improvement report and the devlanes upstream sync,
all testable without the Clickmax monorepo.

**Architecture:** A gate is a row that owns one P1 batch: `gate run` turns a gate file into a batch pinned to one
machine and the `gates` queue, under a per-worktree lock (a partial unique index on running gates plus an advisory
lock at submit). The gate ends in the transaction where its batch's last open job ends (`endJob` in
`jobs/outcome.ts`). Jobs carry `args` and `env` that the job type allows; the Offer appends the args and carries the
values in `JobSpec.env_set` (protocol feature `job-env`). A check with a `cache_key` matching a finished run within
7 days is written finished at submit, pointing at that run, and is left out of run indicators. `claim_run` learns
`need_mb` and `queues.machine_concurrency`. Findings (report, devlanes) become unphased tasks keyed by a unique
open `source_key`.

**Tech Stack:** as P1 (Node ≥24 TypeScript, Fastify 5, TypeBox, Kysely/pg, Postgres 17, `node:test`, Biome 2.6.8,
Rust 1.99.1 edition 2024). No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-p2-gates-design.md` (§2 calls 2-8 and 13-15, §4 "Stage 1", §6 thresholds),
parent `C:/Users/Guilherme/Code/Clickmax/cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md`
(§5.5, §11.1, §11.7). Format reference: `docs/superpowers/plans/2026-11-19-p1-stage-2-scheduler.md`. Paths below are
relative to `C:\Users\Guilherme\Code\devrounds`.

## Scope

In: `devrounds-admin project add` and `--project` per command; job args and env values to the spawn; `need_mb`;
`queues.machine_concurrency`; gates (table, lock, `gate run`, `gate show`, end with the batch, cache); gate
indicators (P2-T10); DevRounds's own gates (P2-T11); plan files with links and unphased tasks (P2-T12); finding tasks
by `source_key`; improvement report (P2-T13); devlanes sync job (P2-T14); a gate e2e; a stage review.

Out, with where it goes: Clickmax job types, gate file generator, prepare, shared store proof, learned-need replay,
10-gate replay, wall time, `/ship` switch, global virtual store (stage 2: P2-T01, T04, T05, T06, T08 proof, T09
proof, T15, T16); a gates page in the web view (the CLI and `--json` serve the script; P5 view work); DevRounds
computing cache keys (the `vcs` engine, later, same column); `gate stop` (a check stops with `run stop`).

## File Structure

```
control-plane/src/
  db/migrations/0018_job_env.ts           job_types args_from_job/job_env/env_set, jobs args/env
  db/migrations/0019_placement.ts         job_types.need_bytes, queues.machine_concurrency, claim_run replaced
  db/migrations/0020_result_cache.ts      jobs.cache_key, runs.cached_from_run_id
  db/migrations/0021_gates.ts             gates + worktree lock index
  db/migrations/0022_task_source_key.ts   tasks.source_key + open-key unique index
  admin.ts                                project add
  job-types/file.ts, job-types/service.ts args_from_job, job_env, env_set, need_mb
  jobs/batch-file.ts, jobs/enqueue.ts     job args/env/cache_key; insertBatch shared with gates
  jobs/cache.ts                           findCachedRun
  jobs/outcome.ts                         endJob → settleGate
  gates/file.ts, gates/service.ts, gates/indicators.ts
  planning/findings.ts                    openFinding
  planning/plan-file.ts, export.ts, import.ts   links, top-level tasks, source_key
  runs/improvement.ts                     improvementReport
  runs/dispatch.ts                        Offer args + env_set
  api/gate-routes.ts, api/report-routes.ts
  cli/commands.ts, cli/output.ts          --project, run start --arg/--env, gate, report, task open-finding, unphased
executor/crates/core/src/job.rs, protocol (feature job-env), executor/src/isolation.rs
scripts/devlanes-sync.ts                  --open-tasks
roadmap/fixtures/job-types/{devrounds-*.yaml,improvement-report.yaml,devlanes-sync.yaml,gate-check.yaml}
roadmap/fixtures/gates/{devrounds.yaml,e2e.yaml}
scripts/e2e/executor.e2e.ts               gate scenario
```

## Global Constraints

- Every P1 Global Constraint still holds: `tenant_id uuid not null`, RLS enabled and forced through `isolate()`,
  composite FKs `(tenant_id, x_id) -> (tenant_id, id)`, an index `(tenant_id, col)` per referencing FK, catalog
  guards in `test-support/catalog.ts` pass without edits, DR201 for cross-tenant, codes only in `errors/words.ts` +
  `pnpm gen:errors`, no sync fs/child-process in `control-plane/src`, spawn only via `devrounds_sys_windows::spawn`,
  no vendor/customer/tool name in engine code (no "clickmax", "devlanes", "pnpm" in `control-plane/src` outside
  tests), signed English commits.
- Migrations 0018-0022 in that order on main; `claim_run` is replaced with `create or replace` keeping signature,
  `security definer`, `set search_path = pg_catalog, public, pg_temp`, execute for the app role only.
- New codes: DR308 `Worktree {cwd} on machine {machine} is held by gate {gate}.` (409, keys `cwd, machine, gate`,
  hint: `devrounds gate show {gate} --wait`, or `gate run --wait-lock <s>`); DR309 `Task {task} already tracks
  finding {sourceKey}.` (409, keys `task, sourceKey`). New not-found kind: `gate`.
- Limits (design call 2-3): job args ≤ 200, each ≤ 4096 chars; env entries ≤ 50, names `^[A-Za-z_][A-Za-z0-9_]{0,199}$`,
  values ≤ 4096 chars; `DEVROUNDS_RUN_ID` may not be set by a job or job type (the executor owns it). Env names
  compare case-insensitively (Windows).
- Cache window 7 days; source run = `finished`, same project and job type, same `cache_key`, not itself cached.
- Lock: one `running` gate per (project, machine, normalized cwd); normalized = drive letter lowercased, `/` → `\`,
  trailing separators removed except after `x:`; `--wait-lock` default 900 s.
- `need_mb` is MiB (× 1048576, like the 512 MiB default); it is the need while the key has fewer than 3 samples.
- Report thresholds (§6): step p50 grew > 20 % and > 10 s with ≥ 3 samples on each side; class count on the day ≥ 2
  and ≥ 2 × the daily mean of the 7 days before; unclassified share of failed runs > 5 %.
- Finding tasks: unphased, key `F-<4 digits>` (next after the highest), `source_key` unique among tasks not
  `done`/`cancelled` of the project.
- Lint is `rtk proxy pnpm lint`; cargo commands run from `executor/` (`pnpm test:executor`, `pnpm lint:executor`).
- Tracker: each task's key gets `devrounds task start` at dispatch, criteria checked with `commit:` evidence, then
  `devrounds task done` (controller). Apply the "Tracker mapping" edits before Task 1.

## Review Focus

1. The same worktree spelled `C:\src\app\` by one caller and `c:/src/app` by another: one lock, the second gets
   DR308 naming the first. Test in Task 5.
2. Two `gate run` for one worktree at the same instant: exactly one gate is `running`, the other answers DR308 with
   its id (never a raw 23505). Test in Task 5.
3. A gate whose check is retried by its job type's policy, or whose last open check is skipped: the gate ends exactly
   once, when nothing is open; a person's `run retry` of a check after the gate ended leaves it ended and the worktree
   free. Tests in Task 5.
4. A job sets `db_name` while the job type lists `DB_NAME` in `job_env` and the machine has `Db_Name`: accepted, and
   the child sees one variable with the job's value. Tests in Task 2 (TS and Rust).
5. A `cache_key` whose only earlier run failed, was itself a cache hit, is older than 7 days or belongs to another
   project: no hit, the check runs. Test in Task 4.

## Calls made

Each by Claude under Guilherme's standing rule for DevRounds; the ones that change or add to the design say so.

1. **Cached is not a run state** (changes call 6's wording): a hit is a `finished` run with `cached_from_run_id`, its
   job `finished`. `claim_run`'s `depends_on` check, `TERMINAL` and every state list stay as they are; views print
   "cached". Cost if wrong: a state added later, backfilled from the column.
2. **The lock wait is the CLI's** (adds to call 5): `POST /gates` never blocks; it answers DR308 with the holder, and
   `gate run` waits on `GET /gates/<holder>?wait=25` and submits again until `--wait-lock` runs out. A server-side
   wait would outlive the CLI's 30 s timeout. No FIFO between waiters; cost if wrong: a `waiting` gate state.
3. **The gate's machine** (call 4 says "resolved at submit"): `--machine <name>`, else the tenant's only live
   machine, else DR101 at `/machine`. The worktree is on the caller's machine and DevRounds cannot tell which it is.
4. **`gates` is created on first use like `default`** (call 8 needs it to exist). `ensureQueue` auto-creates both.
5. **`project add --tenant <name>`**, not `<id>` (call 13): every admin command names tenants; the actor of the
   `create_project` event is the tenant's `import` member that bootstrap created.
6. **Env values travel in `JobSpec.env_set` under feature `job-env`**, and the scheduler offers nothing to a session
   without it: an older executor would drop the values silently and run the wrong database. Every executor ships with
   the control plane (one machine).
7. **The devlanes task opening lives in `scripts/devlanes-sync.ts`** (changes call 14's `devrounds devlanes-sync`):
   AGENTS.md forbids tool names in engine code. The engine offers the generic `POST /findings` and
   `devrounds task open-finding`, which the report uses too.
8. **Finding tasks are unphased with keys `F-<4 digits>`** (adds to call 14): a finding in the open phase would block
   its delivery (DR305). This extends the AGENTS.md "Keys" invariant and needs Guilherme's approval with MANIFESTO.md;
   until then Task 10 lands with the key prefix as one constant.
9. **`gate show --json` / `gate run --json`** print the gate view as JSON (adds): the stage-2 script reads per-check
   outcomes without parsing agent text.
10. **A reopened finding whose `source_key` is open again answers DR309** instead of a raw unique violation.

---

### Task 1: Projects per tenant and `--project` per command

**Files:**

- Modify: `control-plane/src/admin.ts`, `control-plane/src/admin.test.ts`, `control-plane/src/cli/commands.ts`,
  `control-plane/src/cli/cli.test.ts`, `README.md`

**Interfaces:**

- Produces: `projectAdd(admin: Kysely<Database>, appRole: string, i: { tenant: string; key: string; name: string }):
  Promise<{ projectId: string; eventId: string }>` (tenant by name via `tenantIdByName`, `set local role` as in
  `bootstrap`, actor = member `import`, `createProject`; a taken key answers DR101 at `/key` as today).
  `devrounds-admin project add --tenant <name> --key <key> --name <name>`.
- CLI: every spec except `login` accepts `--project <key>`, overriding `CliConfig.project` for that invocation
  (merged into `optionsOf`, read in `runCli`'s `connect`); usage lists it once in `usage()`. `moreCommandFor` keeps it.

- [ ] **Step 1: Failing tests.** `admin.test.ts`: `project add creates a second project in the tenant with a
      create_project event by import`; `project add with a taken key answers DR101 at /key`; `project add for an
      unknown tenant answers DR201 kind tenant`. `cli.test.ts`: `--project beta reads beta's plan with a config for
      alpha`; `--project of another tenant's key exits 5 with the login next step` (existing projectMissing path).
- [ ] **Step 2:** `pnpm test` → the new tests FAIL.
- [ ] **Step 3:** Implement; README "Run the control plane" gains `devrounds-admin project add` and `--project`.
- [ ] **Step 4:** `pnpm test`, `rtk proxy pnpm lint`, `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit "Projects per tenant and --project per command".

### Task 2: Job args and env values to the spawn

**Files:**

- Create: `control-plane/src/db/migrations/0018_job_env.ts`
- Modify: `control-plane/src/db/{schema.ts,migrations/index.ts}`, `control-plane/src/job-types/{file.ts,service.ts,
  job-types.test.ts}`, `control-plane/src/jobs/{batch-file.ts,enqueue.ts,enqueue.test.ts}`,
  `control-plane/src/api/run-routes.ts`, `control-plane/src/runs/{dispatch.ts,dispatch.test.ts}`,
  `control-plane/src/executor/{protocol.ts,protocol.test.ts,gateway.ts}`, `control-plane/src/scheduler/{scheduler.ts,
  scheduler.test.ts}`, `control-plane/src/cli/commands.ts`, `executor/crates/core/src/job.rs`,
  `executor/crates/protocol/src/lib.rs`, `executor/crates/protocol/fixtures/Offer.json`,
  `executor/crates/executor/src/isolation.rs`, `README.md`

**Interfaces:**

- Migration: `job_types` + `args_from_job boolean not null default false`, `job_env text[] not null default '{}'`,
  `env_set jsonb not null default '{}'`; `jobs` + `args jsonb not null default '[]'`, `env jsonb not null default '{}'`.
- Job type file: `args_from_job?: boolean`, `job_env?: string[]` (≤ 50 names), `env_set?: Record<name, string>`.
  `JobTypeDef` gains `args_from_job: boolean; job_env: string[]; env_set: Record<string, string>`;
  `findJobTypeIssue` refuses `DEVROUNDS_RUN_ID` in `env_set` or `job_env` (`/env_set/DEVROUNDS_RUN_ID`,
  `/job_env/<i>`) with reason `set by the executor`.
- `BatchJob` gains `args?: string[]`, `env?: Record<name, string>` (limits in Global Constraints). `EnqueueInput`
  gains the same two. `resolver(trx, projectId)` returns `(i, path?: string) => Promise<JobValues>`, `JobValues`
  gaining `args: string` and `env: string` (JSON); DR101 at `${path}/args` reason `job type <k> does not take job args
  (args_from_job)` and at `${path}/env/<NAME>` reason `job type <k> does not let a job set <NAME> (job_env)`. Batch
  paths are `/jobs/<i>`.
- `POST /runs` body gains `args?`, `env?`; CLI `run start ... [--arg <a>]... [--env NAME=value]...` (DR101 at `--env`
  without `=`).
- Protocol: `JobSpec.env_set: Record<string, string>` (Rust `BTreeMap<String, String>` with `#[serde(default)]`);
  feature `job-env` appended to `FEATURES` on both sides. `offerOf`: `args = [...jobType.args, ...job.args]`,
  `env_set = { ...jobType.env_set, ...job.env }` with a job name replacing a job type name that differs only in case.
- `Sessions.list()` items gain `features: string[]`; `Scheduler.#placeable` keeps only sessions with `job-env`.
- Executor `NoneIsolation::prepare`: after the allowlist, each `env_set` entry removes any key equal ignoring ASCII
  case, then inserts; `DEVROUNDS_RUN_ID` last.

- [ ] **Step 1: Failing tests.** `job-types.test.ts`: `env_set and job_env round-trip through putJobType and
      getJobType`; `DEVROUNDS_RUN_ID in env_set answers DR101 at /env_set/DEVROUNDS_RUN_ID`. `enqueue.test.ts`:
      `job args on a job type without args_from_job answer DR101 at /jobs/0/args`; `an env name outside job_env answers
      DR101 at /jobs/1/env/OTHER and inserts nothing`; `db_name is accepted when job_env lists DB_NAME`.
      `dispatch.test.ts`: `the Offer appends the job's args to the job type's and merges env_set with the job value
      winning case-insensitively`. `scheduler.test.ts`: `a session without job-env gets no offer`. Rust
      (`isolation.rs`): `env_set_reaches_the_child_without_an_allowlist_entry`;
      `env_set_replaces_a_machine_variable_spelled_in_another_case` (one key, job value); `env_set_cannot_replace_run_id`.
      `protocol` fixture tests (both sides) read the new `Offer.json` with `env_set`.
- [ ] **Step 2:** `pnpm test`, `pnpm test:executor` → the new tests FAIL.
- [ ] **Step 3:** Implement; README "Queues, batches and schedules" documents `args`, `env`, `args_from_job`,
      `job_env`, `env_set` (values stored on the job, not secrets; secrets stay in `env`).
- [ ] **Step 4:** `pnpm test`, `pnpm test:executor`, both lints, `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit "Jobs carry args and env values the job type allows".

### Task 3: Starting need and per-machine queue cap in claim_run

**Files:**

- Create: `control-plane/src/db/migrations/0019_placement.ts`
- Modify: `control-plane/src/db/{schema.ts,migrations/index.ts}`, `control-plane/src/job-types/{file.ts,service.ts}`,
  `control-plane/src/runs/learned-need.ts`, `control-plane/src/queues/{service.ts,service.test.ts}`,
  `control-plane/src/scheduler/claim.test.ts`, `control-plane/src/cli/commands.ts`, `web/src/QueuesPage.tsx`,
  `README.md`

**Interfaces:**

- Migration: `job_types.need_bytes bigint null check (need_bytes > 0)`; `queues.machine_concurrency int null check
  (machine_concurrency > 0)`; `create or replace function claim_run(...)` with two changes only: need =
  `case when n.samples >= 3 then n.need_bytes else coalesce(jt.need_bytes, n.need_bytes, 536870912) end` (join
  `job_types jt`), and `(q.machine_concurrency is null or (count of runs of q on p_machine in offered/admitted/running)
  < q.machine_concurrency)` beside the global cap.
- Job type file `need_mb?: integer 1..1048576` → `need_bytes = need_mb * 1048576`; `JobTypeDef.need_mb: number | null`.
- `learned-need.ts`: `MIN_LEARNED_SAMPLES = 3`; `storedNeed` applies the same rule (comment points at 0019).
- `QueueSettings.machineConcurrency?: integer | null`; `QueueView.machineConcurrency: number | null`; CLI `queue set
  <key> [--machine-concurrency <n>|none]`; `queue list` and `#/queues` show it.

- [ ] **Step 1: Failing tests.** `claim.test.ts`: `need_mb is the claimed need while the key has two samples`;
      `with three samples the learned need wins over need_mb`; `without need_mb a key with one sample keeps its learned
      need`; `machine_concurrency 1 offers one run of the queue per machine and still one on a second machine`;
      `concurrency 1 and machine_concurrency 2 hold one run in flight overall`. `service.test.ts`:
      `machine concurrency none clears the cap`.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement; README queue section gains `--machine-concurrency`, job type section `need_mb`.
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "need_mb and per-machine queue concurrency in claim_run".

### Task 4: Result cache by caller key

**Files:**

- Create: `control-plane/src/db/migrations/0020_result_cache.ts`, `control-plane/src/jobs/cache.ts`
- Modify: `control-plane/src/db/{schema.ts,migrations/index.ts}`, `control-plane/src/jobs/{batch-file.ts,enqueue.ts,
  enqueue.test.ts}`, `control-plane/src/runs/{view.ts,indicators.ts,indicators.test.ts}`,
  `control-plane/src/cli/commands.ts`, `web/src/{RunsPage.tsx,RunPage.tsx}`, `README.md`

**Interfaces:**

- Migration: `jobs.cache_key text null check (length(cache_key) between 1 and 200)`, index `jobs_cache_key on jobs
  (project_id, job_type_id, cache_key) where cache_key is not null`; `runs.cached_from_run_id uuid null`, FK
  `(tenant_id, cached_from_run_id) -> runs (tenant_id, id)`, index `(tenant_id, cached_from_run_id)`, check
  `cached_from_run_id is null or state = 'finished'`.
- `jobs/cache.ts`: `CACHE_WINDOW_DAYS = 7`; `findCachedRun(trx: Trx, projectId: string, jobTypeId: string, cacheKey:
  string): Promise<string | null>` (newest qualifying run by `finished_at`).
- `BatchJob.cache_key?`, `EnqueueInput.cacheKey?`. In `submitBatch` (and `enqueueRun`) a hit inserts the job with
  `state 'finished'` and its run `finished`, `cached_from_run_id`, `finished_at = now()`, nothing else stamped; no
  NOTIFY is needed for it alone. Extract `insertBatch(trx: Trx, ctx: Ctx, projectId: string, batchId: string, input:
  BatchInput, defaults?: { machineId?: string; queueKey?: string }): Promise<void>` for Task 5.
- `RunView.cachedFrom: string | null`; `BatchView.jobs[].cachedFrom: string | null`; `runIndicators` filters
  `r.cached_from_run_id is null`. CLI `run show` prints `cached from <id>`, `batch show` prints `cached`.

- [ ] **Step 1: Failing tests.** `enqueue.test.ts`: `a job whose cache_key matches a finished run of its job type ends
      finished at submit, cached from that run`; `its dependents are claimable at once`; `a failed source, a cached
      source, a source older than 7 days, another job type and another project are no hit` (Review Focus 5);
      `the newest of two sources is chosen`. `indicators.test.ts`: `cached runs are not counted in runs, run time or
      failure classes`.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement; README documents `cache_key` (the caller computes it; DevRounds never reads the repo).
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "Result cache by caller cache_key".

### Task 5: Gates with a per-worktree lock

**Files:**

- Create: `control-plane/src/db/migrations/0021_gates.ts`, `control-plane/src/gates/{file.ts,file.test.ts,service.ts,
  service.test.ts}`, `control-plane/src/api/gate-routes.ts`
- Modify: `control-plane/src/db/{schema.ts,migrations/index.ts}`, `control-plane/src/jobs/outcome.ts`,
  `control-plane/src/queues/service.ts`, `control-plane/src/api/server.ts`,
  `control-plane/src/errors/{codes.ts,words.ts}`, `docs/errors.md`

**Interfaces:**

- Table `gates(id, tenant_id, project_id, key text not null, machine_id uuid not null, cwd text not null, cwd_key text
  not null, head_sha text null, dirty boolean null, batch_id uuid not null unique, state text not null default
  'running' check in ('running','passed','failed','cancelled'), created_by uuid not null, created_at, finished_at
  null, unique (tenant_id, id))`, composite FKs to projects, machines, job_batches, members, FK indexes; `create
  unique index gates_worktree_lock on gates (project_id, machine_id, cwd_key) where state = 'running'`.
- `gates/file.ts`: `GateFile = { key: Key; queue?: Key; checks: GateCheck[] (1..200) }`, `GateCheck = { ref, job_type,
  args?, env?, cache_key?, depends_on?, task? }` (the `BatchJob` fields minus `cwd`, `machine`, `queue`);
  `parseGateFile(text): GateFile`; `GateInput = { file: GateFile; cwd: string; machine?: string; headSha?: string
  (^[0-9a-f]{7,64}$); dirty?: boolean }`; `normalizeCwd(cwd: string): string`.
- `gates/service.ts`: `GATES_QUEUE = 'gates'`; `submitGate(ctx: Ctx, projectKey: string, input: GateInput):
  Promise<GateView>` — one transaction: machine (call 3), `pg_advisory_xact_lock(hashtextextended('devrounds.gate:' ||
  project || ':' || machine || ':' || cwd_key, 0))`, holder → DR308, `insertBatch` with every check pinned and queued
  in `file.queue ?? 'gates'`, gate row, `settleGate` (all cached → passed at once), NOTIFY. `settleGate(trx: Trx,
  batchId: string): Promise<void>` — no open job left: any `failed`/`skipped` → failed, else any `stopped` →
  cancelled, else passed; `finished_at = now()`; only from `running`. `gateView(ctx: TenantCtx, projectKey: string,
  id: string): Promise<GateView>`; `waitForGate(ctx, projectKey, id, waitS: number, opts: { signal?: AbortSignal }):
  Promise<GateView>` (wakes on `runEvents` `changed`, as `waitForRun`).
- `GateView = { id, key, state: GateState, machine, cwd, headSha, dirty, batch, createdAt, finishedAt, wallMs: number |
  null, checks: { ref, jobType, state: JobState, runId, runState: RunState, attempt, cachedFrom: string | null,
  failureClass: FailureClass | null, failureSummary: string | null, durationMs: number | null }[] }` (checks by ref).
- `endJob` (outcome.ts) calls `settleGate(trx, batchId)` when the job has a batch. `ensureQueue` auto-creates
  `default` and `gates`.
- Routes under `/api/projects/:key`: `POST /gates` (body `GateInput`, `mutateIdempotent`), `GET /gates/:id?wait=0..60`.

- [ ] **Step 1: Failing tests.** `file.test.ts`: `normalizeCwd maps C:\Src\app\, c:/Src/app and c:\Src\app to one
      key and keeps c:\ as is`; `a gate file with an unknown field answers DR101 at its path`. `service.test.ts`:
      `a gate pins every check to its machine in queue gates with the depends_on edges and is running`;
      `a second gate on the same worktree spelled differently answers DR308 naming the first` (Review Focus 1);
      `two concurrent submits for one worktree make one gate and one DR308` (Review Focus 2); `another cwd or machine
      runs beside it`; `the gate passes when its last check finishes, and the worktree takes a new gate`;
      `a red check fails the gate once its dependents are skipped`; `a check stopped with nothing red ends it
      cancelled`; `a check retried by its policy keeps the gate running until the retry ends`; `a person's retry after
      the gate ended leaves it ended` (Review Focus 3); `every check cached passes the gate at submit`; `with two live
      machines and no --machine DR101 at /machine`; `a gate of another tenant answers DR201 kind gate`.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement; DR308 in words + `pnpm gen:errors`.
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "Gates with a per-worktree lock".

### Task 6: `gate run` and `gate show`

**Files:**

- Modify: `control-plane/src/cli/{commands.ts,cli.test.ts,output.ts}`, `README.md`, `AGENTS.md`

**Interfaces:**

- Consumes: Task 5 routes and `GateView`.
- `devrounds gate run <file.yaml> --cwd <path> [--machine <name>] [--head-sha <sha>] [--dirty] [--wait]
  [--wait-lock <s>|--no-wait-lock] [--json]`: parses the file locally (DR101 with its line), POSTs; on DR308 (unless
  `--no-wait-lock` or `--wait-lock 0`) waits on the holder with `GET /gates/<holder>?wait=25` and submits again with a
  new Idempotency-Key until the deadline (default 900 s), then rethrows DR308 (exit 1). `--wait` then polls `GET
  /gates/<id>?wait=25` until it ends. `devrounds gate show <id> [--wait] [--json]`.
- `gateShow(g: GateJson): Result` in `output.ts`: failures = one line per failed/skipped/stopped check `<ref>
  <runState> <class> <duration> <summary>` then `  log: devrounds run logs <runId>`; body = `gate <id> <state> ·
  <key> · <wall>` and the other checks (`<ref> finished 12.3 s`, `<ref> cached from <run>`, `<ref> queued`); next =
  first failure's `devrounds run logs <id>`, else `devrounds gate show <id> --wait` while running, else `devrounds
  plan show`. `--json` returns `raw` = the view's JSON and a newline.

- [ ] **Step 1: Failing tests.** `cli.test.ts`: `gate run --wait-lock waits for the holder to end and then submits`;
      `gate run --no-wait-lock exits 1 with DR308 and the holder id at once`; `gate run past --wait-lock exits 1 with
      DR308`; `gate show lists failed checks first with class, duration, summary and the run logs command`; `a cached
      check prints cached from its source run`; `gate show --json prints the gate view only`.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement; README gains a "Gates" section (file format, lock, cache, `--json`); AGENTS.md "Always"
      gains one line: run a repo gate with `devrounds gate run <file> --cwd <path> --wait` (failures first), and the
      x5x note is untouched (DR308/DR309 are not executor codes).
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "gate run and gate show with lock wait and failures first".

### Task 7: Gate indicators (P2-T10)

**Files:**

- Create: `control-plane/src/gates/{indicators.ts,indicators.test.ts}`
- Modify: `control-plane/src/api/view-routes.ts`, `control-plane/src/cli/commands.ts`, `README.md`

**Interfaces:**

- `gateIndicators(ctx: TenantCtx, projectKey: string, opts: { period: 'day' | 'week'; from: Date; to: Date }):
  Promise<{ gates: GateIndicatorRow[]; checks: CheckIndicatorRow[] }>`, periods cut as `runIndicators` (tenant zone,
  Monday weeks, by `gates.finished_at`, ended gates only).
  `GateIndicatorRow = { period, gate: string /* gates.key */, gates, passed, failed, cancelled, passRate: number | null
  /* passed / (passed + failed) */, cacheHitShare: number | null /* cached checks / checks */, wallP50Ms, wallP90Ms }`;
  `CheckIndicatorRow = { period, jobType, checks, red /* failed with class check_red */, failed, cached }` (a check =
  the job's latest run).
- `GET /indicators/gates?period=&from=&to=` through `periodWindow('gate indicators', ...)`; CLI `devrounds indicators
  --gates [--period day|week]`.

- [ ] **Step 1: Failing tests.** `pass rate counts passed over passed + failed, cancelled apart`; `cache hit share is
      cached checks over all checks`; `red counts check_red failures per job type, other classes only in failed`;
      `wall p50 and p90 interpolate created → finished`; `running gates are not counted`; `another tenant's gates are
      not seen`.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement; README indicators paragraph names `--gates`.
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "Gate indicators: pass rate, red per check, cache share, wall time".

### Task 8: DevRounds's own gates (P2-T11)

**Files:**

- Create: `roadmap/fixtures/job-types/{devrounds-test.yaml,devrounds-typecheck.yaml,devrounds-lint.yaml,
  devrounds-test-executor.yaml,devrounds-lint-executor.yaml}`, `roadmap/fixtures/gates/devrounds.yaml`
- Modify: `control-plane/src/gates/file.test.ts`, `README.md`

**Interfaces:**

- Job types: `program: pnpm`, args `[test]`, `[typecheck]`, `[lint]`, `[test:executor]`, `[lint:executor]`; env as
  `lint.yaml` plus `CARGO_HOME`, `RUSTUP_HOME` for the cargo ones; `devrounds-test` has `job_env:
  [DEVROUNDS_TEST_DATABASE_URL, DEVROUNDS_TEST_ADMIN_DATABASE_URL]` so a gate can point at a private test database;
  `classify: [{ class: check_red, exit_codes: [1] }]`; `timeout_s` 900 (cargo 1800).
- Gate file `devrounds.yaml`: `key: devrounds`, checks `typecheck`, `lint`, `test`, `test-executor`, and
  `lint-executor` with `depends_on: [test-executor]` (one cargo target directory).

- [ ] **Step 1: Failing test.** `file.test.ts`: `every gate fixture parses and names job types that exist in
      roadmap/fixtures/job-types` (reads the directory with async fs).
- [ ] **Step 2:** `pnpm test` → FAIL; write the fixtures; `pnpm test` → PASS.
- [ ] **Step 3 (controller, live):** after Tasks 1-7 land: `devrounds-admin migrate`, restart `DevRounds`, rebuild and
      `devrounds-executor service install`; `devrounds queue set gates`; `jobtype set` each fixture; `devrounds gate
      run roadmap/fixtures/gates/devrounds.yaml --cwd <repo> --wait` → `passed`. Check P2-T11 with the gate id
      (`note:`) and the commit.
- [ ] **Step 4:** README "Gates" gains the DevRounds gate command; commit "DevRounds's own gates".

### Task 9: Plan files carry links and unphased tasks (P2-T12)

**Files:**

- Modify: `control-plane/src/planning/{plan-file.ts,export.ts,import.ts,import.test.ts}`,
  `control-plane/src/cli/{output.ts,output.test.ts}`

**Interfaces:**

- `PlanFileSchema` gains top-level `tasks?: PlanFileTask[]` (unphased); `PlanFileTask` and `PlanFilePhase` gain
  `links?: { kind: Key; ref: Text; title?: string }[]`. `findIssue` checks key uniqueness across phases and
  `/tasks/<i>/key`.
- Export writes `tasks:` for `plan.unphased` and `links` where set (the "left out" comment goes). Import: top-level
  tasks have `phaseKey: null` in `fileTasks` (a phased DB task listed there moves out of its phase through the
  existing `editTask` path); a new `syncLinks` adds each file link missing by (kind, ref) through `addLink`, never
  deletes.
- `planShow` adds, after the current phase, `unphased:` and one line per unphased task not done or cancelled
  (`  <key> <state>  <title>`), with its open criteria.

- [ ] **Step 1: Failing tests.** `import.test.ts`: `export then import of a plan with links and unphased tasks changes
      nothing`; `import adds a link missing by kind and ref and never adds it twice`; `a top-level task is created
      without a phase, and a phased task listed at top level leaves its phase`; `a key at top level and in a phase
      answers DR101 at /tasks/0/key`. `output.test.ts`: `plan show lists open unphased tasks under unphased:`.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS; `devrounds plan export` of the live plan re-imports as a no-op.
- [ ] **Step 5:** Commit "Plan files carry links and unphased tasks".

### Task 10: Finding tasks by source key

**Files:**

- Create: `control-plane/src/db/migrations/0022_task_source_key.ts`, `control-plane/src/planning/{findings.ts,
  findings.test.ts}`
- Modify: `control-plane/src/db/{schema.ts,migrations/index.ts}`, `control-plane/src/planning/{service.ts,view.ts,
  plan-file.ts,export.ts,import.ts}`, `control-plane/src/api/routes.ts`, `control-plane/src/cli/commands.ts`,
  `control-plane/src/errors/{codes.ts,words.ts}`, `docs/errors.md`, `AGENTS.md`

**Interfaces:**

- Migration: `tasks.source_key text null check (length(source_key) between 1 and 300)`; `create unique index
  tasks_open_source_key on tasks (project_id, source_key) where source_key is not null and state not in ('done',
  'cancelled')`.
- `findings.ts`: `FINDING_KEY_PREFIX = 'F-'`; `openFinding(ctx: Ctx, projectKey: string, i: { sourceKey: string; title:
  string; description?: string; criteria?: string[] }): Promise<{ key: string; created: boolean; eventId: string |
  null }>` (project lock; an open task with the key → `created: false`, no event; else `addTask` unphased with the
  next `F-<4 digits>` and `sourceKey`). `addTask` input gains `sourceKey?: string`. `TaskView.sourceKey: string |
  null`; plan file task `source_key?` exported and set on create by import (never changed by import).
- A transition that reopens a task whose source key is open on another task answers DR309.
- `POST /findings` (idempotent); CLI `devrounds task open-finding --source-key <k> --title <t> [--description <text>]
  [--criterion <text>]...` prints `opened F-0003 <title>` or `already open F-0001 <sourceKey>`.

- [ ] **Step 1: Failing tests.** `findings.test.ts`: `a second open with the same source key returns the open task,
      created false, no event`; `after that task is done the key opens F-0002`; `reopening the done one while F-0002 is
      open answers DR309`; `concurrent opens of one key make one task`; `keys follow the highest F- key, not the
      count`; `a finding of another tenant is not seen`.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement; DR309 + `pnpm gen:errors`; AGENTS.md "Keys" line gains finding tasks (call 8: only with
      Guilherme's approval; otherwise leave AGENTS.md and flag it in the ledger).
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "Finding tasks deduplicated by source key".

### Task 11: Improvement report (P2-T13)

**Files:**

- Create: `control-plane/src/runs/{improvement.ts,improvement.test.ts}`, `control-plane/src/api/report-routes.ts`,
  `roadmap/fixtures/job-types/improvement-report.yaml`
- Modify: `control-plane/src/api/server.ts`, `control-plane/src/cli/commands.ts`, `README.md`

**Interfaces:**

- Consumes: `openFinding` route (Task 10).
- `improvementReport(ctx: TenantCtx, projectKey: string, day?: string /* YYYY-MM-DD, default yesterday local */):
  Promise<ImprovementReport>`; `ImprovementReport = { day, timeZone, slowestSteps: { jobType, step, p50Ms, runs }[] /*
  top 5 */, retries: { jobType, retries }[], unclassifiedShare: number | null, findings: Finding[] }`; `Finding = {
  sourceKey, kind: 'step_growth' | 'class_doubled' | 'unclassified_share', title, evidence: string }`. Steps are
  `run_steps` durations; a job type with no steps counts its run time as step `run`. Cached and skipped runs are left
  out. Source keys: `improvement:step:<jobType>:<step>`, `improvement:class:<jobType>:<class>`,
  `improvement:unclassified`. Constants in the file with the §6 values.
- `GET /reports/improvement?day=`; CLI `devrounds report improvement [--day <date>] [--open-tasks]`: findings as
  failures, the rest as body; `--open-tasks` opens each finding through `POST /findings` (title, evidence as
  description, criterion `explained or fixed, with evidence`).
- Fixture `improvement-report.yaml`: `program: node`, `args: [control-plane/src/cli/main.ts, report, improvement,
  --open-tasks]`, env as `lint.yaml` plus `DEVROUNDS_URL`, `DEVROUNDS_TOKEN`, `DEVROUNDS_PROJECT`; its comment and the
  README give the schedule: `devrounds schedule set improvement-report --job-type improvement-report --cwd <repo>
  --daily 06:00`.

- [ ] **Step 1: Failing tests.** `a step whose p50 grew 25 % and 12 s is a step_growth finding`; `30 % but 5 s, or 15 s
      but 10 %, is none`; `two samples on either side are not compared`; `a job type without steps is compared on
      step run`; `a class seen 4 times on the day against 7 over the 7 days before is doubled, 1 time is not`; `1
      unclassified of 10 failed is a finding, 0 is none`; `cached and skipped runs are left out`; `the day is the
      tenant's local day`; `report improvement --open-tasks opens each finding once across two runs` (cli.test.ts).
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "Daily improvement report with deduplicated finding tasks".

### Task 12: devlanes sync as a daily job (P2-T14)

**Files:**

- Create: `roadmap/fixtures/job-types/devlanes-sync.yaml`
- Modify: `scripts/devlanes-sync.ts`, `scripts/devlanes-sync.test.ts`, `README.md`

**Interfaces:**

- `findingsOf(pending: Pending[]): { sourceKey: string; title: string; description: string; criteria: string[] }[]` —
  one per commit (`devlanes:<sha>`, title `Port devlanes <short sha>: <subject>`, description lists the crates,
  criterion `ported or recorded as [[reviewed]] in executor/devlanes-sync.toml`). `openPendingTasks(pending,
  open: (f) => Promise<number /* CLI exit code */>): Promise<boolean>` calls `runCli(['task', 'open-finding', ...])`
  with the process env and `defaultConfigPath()`.
- `--open-tasks`: exit 0 when every pending commit has an open task, 1 when an open failed; without it, as today.
- Fixture: `program: pnpm`, `args: [devlanes-sync, --fetch, --open-tasks]`, env as `lint.yaml` plus `HOME`,
  `DEVROUNDS_URL`, `DEVROUNDS_TOKEN`, `DEVROUNDS_PROJECT`; `timeout_s: 900`; README gives `schedule set devlanes-sync
  ... --daily 06:30`.

- [ ] **Step 1: Failing tests.** `one finding per commit with its crates joined and key devlanes:<sha>`;
      `--open-tasks is green once every commit has a task and red when an open fails`.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test`, `pnpm devlanes-sync`, lint, typecheck → PASS.
- [ ] **Step 5 (controller, live):** set the two schedules on the live install; after the first fire check P2-T13
      and P2-T14 with the run ids (`note:`).
- [ ] **Step 6:** Commit "devlanes sync opens one task per pending upstream change".

### Task 13: Gate end to end

**Files:**

- Create: `roadmap/fixtures/job-types/gate-check.yaml`, `roadmap/fixtures/gates/e2e.yaml`
- Modify: `scripts/e2e/executor.e2e.ts`, `README.md`

**Interfaces:**

- `gate-check`: `program: tree-fixture`, `args: [--print-env]`, `args_from_job: true`, `job_env: [DR_E2E_MARK]`,
  `env: [PATH, PATHEXT, SystemRoot]`. `e2e.yaml`: checks `a` (args `[--run-ms, "4000"]`, env `DR_E2E_MARK`) and `b`
  `depends_on: [a]`; the e2e writes copies with its cache keys.
- Scenario `gate`: `queue set gates --machine-concurrency 2`; gate 1 submitted without `--wait`; `gate run
  --no-wait-lock` on the same cwd exits 1 with DR308 naming gate 1; gate 2 (other cache keys) with `--wait-lock 60
  --wait` passes and its `createdAt` ≥ gate 1's `finishedAt`; gate 3 with gate 1's keys passes at once with every
  check `cachedFrom` = gate 1's run; check `a`'s log has `DR_E2E_MARK=<value>`; `GET /indicators/gates` shows 3
  passed and a cache share above 0; the `cached` runs are absent from `GET /indicators`.

- [ ] **Step 1:** Write the scenario and fixtures; `pnpm e2e` → FAIL until Tasks 1-7 are in.
- [ ] **Step 2:** `pnpm e2e`, `pnpm test`, `pnpm test:executor`, both lints, typecheck → PASS.
- [ ] **Step 3:** README `pnpm e2e` paragraph and the e2e header list the gate scenario; commit "Gate end to end".

### Task 14: Stage review

- [ ] **Step 1:** Dispatch the whole-branch review (opus) over the stage range, with the ledger's parked lines.
- [ ] **Step 2:** One fix wave for Critical/Important; scoped re-review until clean.
- [ ] **Step 3:** Check the stage criterion with the review evidence; `devrounds task done P2-T23`.

---

## Order and parallelism

Main path (shared `enqueue.ts`, `outcome.ts`, migrations): Task 2 → 3 → 4 → 5 → 6 → 7 → 8 → 13. Task 1 first (small,
touches `commands.ts` early). Lane A: Task 9 → 10 → 11 → 12 (planning and report; migration 0022 renumbered to the
next free key if it lands after another), in a worktree with a private test database. Task 14 last.

## Not settled here

- The AGENTS.md "Keys" line for `F-` finding tasks (call 8) needs Guilherme's approval with MANIFESTO.md.
- `pnpm test` as a gate check shares `devrounds_test` with a developer's own `pnpm test`; `job_env` lets a gate point
  elsewhere, but nothing creates a second test database yet.
- The improvement report and devlanes jobs need an agent token for member `claude` as user variables
  (`DEVROUNDS_URL`, `DEVROUNDS_TOKEN`, `DEVROUNDS_PROJECT`) on the machine; a token in a user variable is readable by
  every process of the user.

---

## Tracker mapping

Apply before Task 1. Today P2-T03, T07, T08, T09, T10, T11, T15 are `blocked_by: [P2-T01]`, and T01 (Clickmax job
types) is stage 2, so none of the stage-1 tasks could start (DR302). Edits: `devrounds dep rm <task> --blocked-by
P2-T01` for T03, T07, T10, T11; T08, T09, T15 keep it (stage 2). P2-T01 gains `blocked_by: [P2-T20, P2-T18]`.

| Plan task | Key | Action |
|-|-|-|
| — | P2-T02 depends_on DAG | Close by evidence: P1 Task 1 (batches, `depends_on`) and P1 Task 4 (skip-on-red) commits, `note:` P1-T43/P1-T45 done |
| 1 | P2-T17 (new) Projects per tenant and `--project` | Add; criterion: project add creates a second project; `--project` reaches it with one login |
| 2 | P2-T18 (new) Job args and env values | Add; criteria: args appended only with args_from_job; env only for job_env names, reaching the child; executor without job-env gets no offer |
| 3 | P2-T19 (new) need_mb and per-machine queue cap | Add; criterion: need_mb holds until 3 samples; machine_concurrency caps a queue per machine. Engine part of T08 and T09 criterion 2 (their proofs stay stage 2) |
| 4 | P2-T07 Gate result cache | Close; criterion added: a cache_key hit within 7 days ends the check cached from the source run, excluded from indicators |
| 5 | P2-T03 Per-worktree lock | Close; criteria added: one running gate per normalized worktree, concurrent submits give one gate and DR308; the gate ends with its batch |
| 6 | P2-T20 (new) gate run and gate show | Add, blocked_by P2-T03; criterion: `gate run --wait` waits for the lock or refuses with `--no-wait-lock`, and prints failures first |
| 7 | P2-T10 Indicators | Close; criterion added: pass rate per gate key, red per check job type, cache hit share, wall p50/p90 |
| 8 | P2-T11 DevRounds's own gates | Close; criterion added: the devrounds gate (test, typecheck, lint, test:executor, lint:executor) passes on DevRounds through DevRounds |
| 9 | P2-T12 Plan links and unphased | Close (existing criterion) |
| 10 | P2-T21 (new) Finding tasks by source key | Add; criterion: one open task per source key; a closed finding opens a new one |
| 11 | P2-T13 Daily report | Close (existing criterion), blocked_by P2-T21 |
| 12 | P2-T14 devlanes sync | Close (existing criterion), blocked_by P2-T21 |
| 13 | P2-T22 (new) Gate end to end | Add, blocked_by P2-T20, P2-T07; criterion: `pnpm e2e` passes lock contention, a cache hit and job env |
| 14 | P2-T23 (new) Stage 1 review | Add, blocked_by every stage-1 key; criterion: no open Critical or Important finding |

Stage 2 keeps P2-T01, T04, T05, T06, T08 (proof), T09 (proof), T15, T16.
