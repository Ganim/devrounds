# P1 spike: queue/scheduler and auth, build vs adopt (P1-T02)

Status: ruled 17/11 by the controller under Guilherme's pre-approval of 17/11 (recorded in the P1 stage-1 progress
log): own scheduler on the P0 Postgres; Better Auth identity-only, with its global identity tables in schema `auth`
accepted as an exception to "every table has `tenant_id` + forced RLS". Inputs: P1 design §5, parent spec §5.1,
§11.2, §14, §16. Measured 17/11/2026 on Guilherme's machine (Windows 11, Node 24.22.1, Postgres 17.11 in
`devrounds-postgres`).

## 1. Result

- **Queue/scheduler: build it on the P0 Postgres.** None of the four engines fits RAM-aware placement and the P0 schema
  rules without either giving up placement or carving tenant data out of RLS; the build option measured +1.4 MB and
  one extra Postgres connection. Hatchet's in-budget cost (`supervise` + `serve`) is +69.6 MB of the 116.9 MB
  headroom, but on the machine it costs ~368 MB with its engine container and the Postgres growth. Machine RAM is the
  binding resource (spec §16); that and fit are what made Hatchet lose.
- **Better Auth: yes, for identity only, without the organizations plugin.** Login, sessions and accounts come from
  Better Auth in schema `auth`; `tenants` and `members` stay the P0 tables. Its organizations plugin fails under
  forced RLS (measured, §5). Identity-only measured +18.6 MB.

## 2. Licenses

Read from the LICENSE file in the installed package and the GitHub repository's license (`gh api repos/<r>`), not from
memory. Transitive dependencies were listed from each install's `node_modules` package.json files.

| Option                                           | Version                     | License (file)                                                                                                                                    | Transitive                              | Verdict                                                                                                                                       |
| ------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Hatchet (engine + `@hatchet-dev/typescript-sdk`) | engine v0.114.2, SDK 1.47.4 | MIT (`hatchet-dev/hatchet` LICENSE, "Copyright (c) 2023-present Hatchet Technologies Inc."); SDK package.json MIT, no LICENSE file in the package | MIT, Apache-2.0, BSD-3-Clause, ISC      | allowed                                                                                                                                       |
| pg-boss                                          | 12.38.2                     | MIT (`LICENSE`, Tim Jones)                                                                                                                        | MIT, Apache-2.0, ISC, MIT/CC0           | allowed                                                                                                                                       |
| Graphile Worker                                  | 0.18.0                      | MIT (`LICENSE.md`, Benjie Gillam)                                                                                                                 | MIT, ISC, 0BSD, Python-2.0 (`argparse`) | allowed                                                                                                                                       |
| DBOS Transact (`@dbos-inc/dbos-sdk`)             | 5.6.0                       | MIT (`LICENSE`, DBOS, Inc.)                                                                                                                       | MIT, ISC, MIT/CC0                       | allowed; its optional peer `@dbos-inc/dbos-enterprise` is under the proprietary "DBOS Conductor Software License" and must never be installed |
| Better Auth                                      | 1.7.25                      | MIT (`LICENSE.md`, Bereket Engida)                                                                                                                | MIT only                                | allowed; telemetry is off unless `telemetry.enabled` or `BETTER_AUTH_TELEMETRY` is set                                                        |
| Own scheduler                                    | —                           | ours                                                                                                                                              | `pg`, `kysely` already in P0            | allowed                                                                                                                                       |

## 3. Measurements

Method: a harness (`.superpowers/spike/harness.ts`, gitignored) builds the P0 server (`buildServer` + Kysely pool) as
`serve` does, loads one candidate, runs one job end to end, then sits idle for 5 minutes; then
`Get-Process -Id <pid> | Select PrivateMemorySize64`. Each candidate ran alone against the scratch database
`devrounds_spike` on port 15433, torn down before the next. 1 MB = 1 000 000 bytes. One sample per candidate: Node's
private bytes moved by ~30 MB between 5 s and 5 min (garbage collection), and two harness-only runs measured 93.8 and
91.1 MB, so differences under ~5 MB are noise.

Reference, the live P0 control plane on the same machine: `supervise` 66.5 MB + `serve` 116.6 MB = **183.1 MB of
300 MB**, leaving **116.9 MB** for everything P1 adds (executor gateway, run record, logs, scheduler, auth).

| Option                                                           | `serve` private bytes after 5 min | Δ vs harness          | Extra processes                                          | Postgres backends held            | First job round trip                   |
| ---------------------------------------------------------------- | --------------------------------- | --------------------- | -------------------------------------------------------- | --------------------------------- | -------------------------------------- |
| Harness, nothing loaded                                          | 93.8 MB (rerun: 91.1 MB)          | —                     | —                                                        | 0                                 | —                                      |
| Own scheduler (SKIP LOCKED claim + LISTEN/NOTIFY)                | 95.2 MB                           | +1.4                  | none                                                     | 1 (LISTEN)                        | 10 ms                                  |
| Graphile Worker (LISTEN, concurrency 1)                          | 97.0 MB                           | +3.2                  | none                                                     | 2                                 | 125 ms                                 |
| DBOS (one queue, one workflow)                                   | 101.7 MB                          | +7.9                  | none                                                     | 3                                 | 1 011 ms                               |
| pg-boss (one queue, `work`)                                      | 103.5 MB                          | +9.7                  | none                                                     | 2                                 | 2 047 ms (2 s poll)                    |
| Better Auth with organizations plugin (app's Kysely)             | 114.0 MB                          | +20.2                 | none                                                     | 0 (shares the app pool)           | sign-up + create org + session read OK |
| Better Auth identity-only (schema `auth`, own 2-connection pool) | 109.6 MB                          | +18.6 (vs 91.1 rerun) | none                                                     | 0 idle (pool max 2)               | sign-up + session read OK              |
| Hatchet (TS SDK worker in `serve`)                               | 163.4 MB                          | +69.6                 | `hatchet-lite` container: 104.1 MB (cgroup anon 62.0 MB) | 21 (with `DATABASE_MAX_CONNS=10`) | 116 ms                                 |

Hatchet's engine has no Windows build (the Windows release asset is the CLI, which starts the Docker image), so it runs
inside Docker Desktop's VM and its memory is not a Windows process: measured with `docker stats` and the container's
`memory.stat`. It also grew the Postgres container from 57.5 MB to 251.8 MB (+194 MB) idle, created 261 tables in
`public`, and used 3.2 % CPU idle. Against the control-plane budget (`supervise` + `serve`) Hatchet costs +69.6 MB of
the 116.9 MB headroom, so it fits that budget. On the machine it costs ≈ 70 + 104 + 194 = ~368 MB, because the engine
and the Postgres growth sit outside the two processes the budget counts. Machine RAM is the resource DevRounds exists to
save (spec §16), so the machine total is the number that weighs against it. The other library options add their
tables only: pg-boss 13, DBOS 14, Graphile 6.

Projected control plane idle (live 183.1 MB + Δ): own 184.5, Graphile 186.3, DBOS 191.0, pg-boss 192.8, Hatchet 252.7
(plus ~298 MB outside the budget). The ruled combination, own scheduler + Better Auth identity-only, projects to
183.1 + 1.4 + 18.6 = **~203 MB of 300 MB** (~205 MB with the organizations-plugin figure).

## 4. Fit with the needs

Own-scheduler cells were run (§4.1). Cells for the four engines marked _(docs)_ come from their documentation or the
installed type definitions, not from a run; sources in §4.2. The license and RAM row is measured.

| Need                                                                                 | Hatchet                                                                                                                                                                                                                                                                               | pg-boss                                                                                                                                                                                                             | Graphile Worker                                                                | DBOS                                                                                                                                                                                                | Own on P0 Postgres                                                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| RAM-aware placement (machine by reported free memory and learned need)               | Poor _(docs [H1])_. Placement is Hatchet's: `desiredWorkerLabels` with comparators (beta) are set in the task definition, so "free memory ≥ need for this (project, job type, machine)" cannot be expressed; the spec already noted adopting it trades this control.                  | Partial _(docs [P1])_. `fetch` claims a job before we know a machine fits it; its options filter by priority and batch size, not by need, so a big job blocks or must be re-queued. Placement would be ours on top. | Partial _(docs [G1])_. Same as pg-boss; claims filter by task name/queue only. | Partial _(docs [D1])_. Dequeue is internal; placement would live in workflow code; queue limits are queue-wide (`concurrency`) or per worker process (`workerConcurrency`), not per machine memory. | Good _(run)_. The claim filters `need <= free_bytes` for the offering machine in one `UPDATE … FOR UPDATE SKIP LOCKED`.                        |
| Executor dials out, no worker library on the executor                                | Poor _(docs [H2])_. Workers are SDK processes (Go, Python, Ruby, TypeScript; no Rust) over gRPC: either a sidecar on each machine (breaks the 50 MB executor budget and the Rust-only executor) or a relay worker in `serve`, which makes Hatchet a second state machine beside ours. | Neutral. Worker runs in the control plane and relays over our WebSocket; the library job stays `active` while the executor runs it, so timeouts and heartbeats must be mapped to offer/admission states.            | Neutral, as pg-boss.                                                           | Neutral, as pg-boss; a workflow would block in a step for the whole run.                                                                                                                            | Good. Offer/Admitted/Delayed/RunFinished already are the job states.                                                                           |
| P0 schema (`tenant_id`, forced RLS, composite FKs)                                   | Poor _(run: 261 tables in `public`, own tenant seeded)_. Own `Tenant` model, no RLS; realistically needs its own database.                                                                                                                                                            | Poor _(run: 13 tables in its schema)_. No `tenant_id`/RLS; tenant payloads would sit outside RLS, an exception to the P0 rule.                                                                                      | Poor _(run: 6 tables)_, as pg-boss.                                            | Poor _(run: 14 tables)_. Workflow inputs and outputs are stored in its tables outside RLS.                                                                                                          | Good _(run)_. Forced RLS on `jobs` holds for a non-superuser role; the cross-tenant claim is a security definer function like `resolve_token`. |
| `depends_on` DAG (§11.2: offer only when deps green, red dep → dependents `skipped`) | Partial _(docs [H3])_. Native DAGs (`parents`), declared in worker code at registration; a gate's checks are per-tenant data, so it needs child spawning.                                                                                                                             | Good-ish _(docs [P2])_. `flow()` takes `dependsOn` refs per request (`blocked`, `pending_dependencies`); skip-on-red semantics not verified.                                                                        | Poor _(docs [G2])_. No dependencies (only `job_key` and serial queues).        | Partial _(docs [D2])_. Dependencies are workflow code awaiting children.                                                                                                                            | Good _(run)_, ours to write: `depends_on` checked in the claim; skip-on-red is one transition, not yet written.                                |
| License / idle RAM _(measured)_                                                      | MIT / +69.6 MB in budget, ~368 MB on the machine                                                                                                                                                                                                                                      | MIT / +9.7 MB                                                                                                                                                                                                       | MIT / +3.2 MB                                                                  | MIT (enterprise peer proprietary) / +7.9 MB                                                                                                                                                         | ours / +1.4 MB                                                                                                                                 |

### 4.1 Own scheduler, what was run

`.superpowers/spike/own/rls-check.ts`, connected as a role with `rolsuper = false, rolbypassrls = false`, two tenants,
`jobs` with forced `tenant_isolation`, claim function owned by the superuser (as `resolve_token` is):

- cross-tenant insert → `new row violates row-level security policy for table "jobs"`; no tenant set → 0 rows; tenant
  A sees only its own `build`, `test`;
- claim with 1 GB free → `build`; again → nothing (`test` waits on `build` through `depends_on`, the other tenant's
  `big` needs 4 GB); after `build` finished → `test`; with 8 GB free → `big` (other tenant, through the security
  definer); then nothing.

The idle measurement in §3 used the same tables and a LISTEN/NOTIFY wake-up (10 ms from NOTIFY to claimed job).

### 4.2 Sources for _(docs)_ cells

- [H1] Hatchet worker affinity:
  <https://github.com/hatchet-dev/hatchet/blob/main/frontend/docs/content/docs/v1/advanced-assignment/worker-affinity.mdx>;
  `desiredWorkerLabels` in `@hatchet-dev/typescript-sdk` 1.47.4 `v1/task.d.ts`.
- [H2] Hatchet SDKs: <https://github.com/hatchet-dev/hatchet/tree/main/sdks> (go, python, ruby, typescript variants).
  The spike's worker ran in `serve` through the TS SDK over gRPC.
- [H3] Hatchet DAG parents: `parents?: CreateWorkflowTaskOpts[]` in `@hatchet-dev/typescript-sdk` 1.47.4
  `v1/task.d.ts`.
- [P1] pg-boss `fetch(name, options)` and `JobFetchOptions` (`batchSize`, `minPriority`, `orderByCreatedOn`,
  `ignoreStartAfter`) in pg-boss 12.38.2 `dist/index.d.ts`, `dist/types.d.ts`; <https://github.com/timgit/pg-boss>.
- [P2] pg-boss `flow(jobs: FlowJob[])`, `FlowJob.dependsOn` in `dist/types.d.ts`; `blocked`, `pending_dependencies`
  columns in `dist/plans.js`; README feature "Job dependency workflow orchestration".
- [G1], [G2] Graphile Worker 0.18.0 `dist/index.d.ts` (no dependency option in its job spec);
  <https://worker.graphile.org/docs>.
- [D1], [D2] DBOS `WorkflowQueue` (`concurrency` queue-wide, `workerConcurrency`) in `@dbos-inc/dbos-sdk` 5.6.0
  `dist/src/wfqueue.d.ts`, `DBOS.registerQueue`/`startWorkflow` in `dist/src/dbos.d.ts`;
  <https://github.com/dbos-inc/dbos-transact-ts>.

## 5. Better Auth

Measured: Better Auth 1.7.25 runs on a Kysely instance it is given (`database: { db, type: 'postgres' }`). With the
organizations plugin it shared the app's own Kysely; sign-up, organization creation and session read worked end to end
through Fastify (`toNodeHandler` behind `/api/auth/*`); `generateId: 'uuid'` gives uuid keys; +20.2 MB idle.
Identity-only (no plugin, its own 2-connection pool with `search_path=auth`, the recommended shape): tables `user`,
`session`, `account`, `verification` created in schema `auth`, sign-up and session read OK, +18.6 MB idle.

- **Organizations plugin → `tenants`/`members`: does not fit.** Model and field names can be remapped (spike:
  `organization` → `ba_tenants`, `member.organizationId` → `tenant_id`), but the shape is Better Auth's:
  `session."activeOrganizationId"` is `text`, member FKs are single-column, `invitation` has no `tenant_id`. With the
  P0 `tenant_isolation` policy forced on its org and member tables and a non-superuser role (as `serve` connects),
  `createOrganization` failed with `new row violates row-level security policy for table "ba_tenants"` and
  `listOrganizations` returned 0 rows: Better Auth queries outside `withTenant()`, so it never sets `app.tenant_id`.
- **Session tables under RLS: not possible as designed.** `user`, `session`, `account`, `verification` are global by
  nature (a person logs in before a tenant is chosen and may belong to several), so they cannot carry
  `tenant_id not null`. They hold identity, not tenant data. Ruled an accepted exception (header).
- **Coexistence with P0 API tokens: fine.** Tokens (`drt_`, SHA-256, `resolve_token`) stay the agent/CLI path; the
  auth hook checks a Bearer token first and falls back to the session cookie. Better Auth's `bearer` plugin is not
  used.
- **Shape that fits:** Better Auth owns identity in schema `auth`, organizations plugin off; P0 `members` gains
  `user_id` (nullable, human members only); after login a security definer `resolve_session` maps
  session → (tenant, member) the way `resolve_token` does, and every tenant query still goes through `withTenant()`.

## 6. Recommendation (ruled, see header)

1. **Build the scheduler on the P0 Postgres.** Claim with `FOR UPDATE SKIP LOCKED` inside a security definer function
   that filters by queue, priority/FIFO, per-queue concurrency, `depends_on` and `need <= free memory - reserve` of the
   offering machine; wake on `LISTEN/NOTIFY` with a slow poll as fallback. Reasons: the only option that keeps
   placement ours (spec §5.1), keeps every row under P0 RLS, needs nothing on the executor side, and costs ~1 MB and
   one connection. pg-boss and Graphile Worker are reference designs for the claim SQL and the LISTEN wake-up, not
   dependencies.
2. **Adopt Better Auth for identity only**, in schema `auth`, organizations plugin off, when session login is built.
   The `auth` schema is the ruled exception to the P0 table rule. Fallback if it has to be undone: a small own session
   table under P0 rules with password login for the one human member.
3. Not adopted: Hatchet (machine RAM, Docker on Windows, placement and schema), DBOS and pg-boss (schema outside RLS,
   placement on top anyway), Graphile Worker (same, and no DAG).

## 7. What the stage-2 re-plan must cover

- Tables: queues (priority, concurrency cap, allowed job types), jobs (state machine of spec §5.4, `depends_on` edges
  within one gate, attempts, `need` snapshot), offers with expiry; all with `tenant_id`, forced RLS, composite FKs.
- `depends_on` cycle check when a gate's jobs are created (the request is rejected, nothing inserted), plus the
  same-gate rule.
- The claim function: security definer, `search_path` pinned, execute only to the app role; inputs = machine id, last
  reported free memory, reserve; learned need per (project, job type, machine), default 512 MiB; ordering priority
  then FIFO; concurrency caps counted in the same statement.
- Wake-up: one dedicated LISTEN connection in `serve` (counts against Postgres connections, not the pool); fallback
  poll interval; NOTIFY on enqueue, on run finish and on `MachineReport`.
- Offer timeout → back to queue; executor `Delayed` keeps the offer; disconnect handling for offered/admitted jobs.
- Crash recovery: on `serve` start, jobs left `offered` by a claim whose offer never reached an executor (or expired
  while `serve` was down) go back to `queued`; admitted/running jobs are reconciled with the executor's `Hello` and
  outbox, never re-offered blindly.
- Retry/backoff and max attempts per job type as separate runs (P1 design §3.1); skip-on-red propagation to dependents.
- Idempotency key on enqueue; transactional outbox for events.
- Scheduled jobs (the P2 daily improvement report needs one): a small schedule table driven by the same scheduler,
  not a library cron.
- A budget test on the whole control plane idle with the scheduler loaded (≤ 300 MB).
- Better Auth, when login is planned: schema `auth` created by `devrounds-admin migrate` (owner role) with Better Auth's
  migrations, never by `serve`; `devrounds_app` granted usage on `auth` and select/insert/update/delete on its tables
  (plus default privileges for later Better Auth migrations); `members.user_id`, `resolve_session`, auth hook order
  (token first, then cookie), cookie settings for the loopback host.
