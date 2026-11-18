# P1 spike: queue/scheduler and auth, build vs adopt (P1-T02)

Status: recommendation for Guilherme's ruling. Inputs: P1 design §5, parent spec §5.1, §11.2, §14, §16. Measured
17/11/2026 on Guilherme's machine (Windows 11, Node 24.22.1, Postgres 17.11 in `devrounds-postgres`).

## 1. Result

- **Queue/scheduler: build it on the P0 Postgres.** None of the four engines fits RAM-aware placement and the P0 schema
  rules without either giving up placement or carving tenant data out of RLS; the build option measured +1.4 MB and
  one extra Postgres connection. Hatchet alone costs more than the whole remaining control-plane budget.
- **Better Auth: yes, for identity only, without the organizations plugin.** Login, sessions and accounts come from
  Better Auth in their own schema; `tenants` and `members` stay the P0 tables. Its organizations plugin fails under
  forced RLS (measured, §5).

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
private bytes moved by ~30 MB between 5 s and 5 min (garbage collection), so differences under ~5 MB are noise.

Reference, the live P0 control plane on the same machine: `supervise` 66.5 MB + `serve` 116.6 MB = **183.1 MB of
300 MB**, leaving **116.9 MB** for everything P1 adds (executor gateway, run record, logs, scheduler, auth).

| Option                                            | `serve` private bytes after 5 min | Δ vs harness | Extra processes                                          | Postgres backends held            | First job round trip                   |
| ------------------------------------------------- | --------------------------------- | ------------ | -------------------------------------------------------- | --------------------------------- | -------------------------------------- |
| Harness, nothing loaded                           | 93.8 MB                           | —            | —                                                        | 0                                 | —                                      |
| Own scheduler (SKIP LOCKED claim + LISTEN/NOTIFY) | 95.2 MB                           | +1.4         | none                                                     | 1 (LISTEN)                        | 10 ms                                  |
| Graphile Worker (LISTEN, concurrency 1)           | 97.0 MB                           | +3.2         | none                                                     | 2                                 | 125 ms                                 |
| DBOS (one queue, one workflow)                    | 101.7 MB                          | +7.9         | none                                                     | 3                                 | 1 011 ms                               |
| pg-boss (one queue, `work`)                       | 103.5 MB                          | +9.7         | none                                                     | 2                                 | 2 047 ms (2 s poll)                    |
| Better Auth (app's Kysely, orgs plugin)           | 114.0 MB                          | +20.2        | none                                                     | 0 (shares the app pool)           | sign-up + create org + session read OK |
| Hatchet (TS SDK worker in `serve`)                | 163.4 MB                          | +69.6        | `hatchet-lite` container: 104.1 MB (cgroup anon 62.0 MB) | 21 (with `DATABASE_MAX_CONNS=10`) | 116 ms                                 |

Hatchet's engine has no Windows build (the Windows release asset is the CLI, which starts the Docker image), so it runs
inside Docker Desktop's VM and its memory is not a Windows process: measured with `docker stats` and the container's
`memory.stat`. It also grew the Postgres container from 57.5 MB to 251.8 MB (+194 MB) idle, created 261 tables in
`public`, and used 3.2 % CPU idle. Total Hatchet cost ≈ 70 + 104 + 194 = ~368 MB, above the full 300 MB budget before
counting what P0 already uses. The other library options add their tables only: pg-boss 13, DBOS 14, Graphile 6.

Projected control plane idle (live 183.1 MB + Δ): own 184.5, Graphile 186.3, DBOS 191.0, pg-boss 192.8, Hatchet
~252.7 in `serve` alone plus the engine and Postgres growth outside it. Better Auth adds 20.2 on top of whichever is
chosen.

## 4. Fit with the needs

| Need                                                                                 | Hatchet                                                                                                                                                                                                                                                      | pg-boss                                                                                                                                                                                                  | Graphile Worker                                                  | DBOS                                                                                                                             | Own on P0 Postgres                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAM-aware placement (machine by reported free memory and learned need)               | Poor. Placement is Hatchet's: worker labels with comparators (beta) are fixed in the task definition, so "free memory ≥ need for this (project, job type, machine)" cannot be expressed; the spec already noted adopting it trades this control.             | Partial. `fetch` claims a job before we know a machine fits it; no claim filtered by need, so a big job blocks or must be re-queued. Placement would be ours on top.                                     | Partial. Same as pg-boss; claims filter by task name/queue only. | Partial. Dequeue is internal; placement would live in workflow code, and its concurrency is per worker process, not per machine. | Good. The claim query filters `need <= free_bytes` for the offering machine (spike: one `UPDATE … FOR UPDATE SKIP LOCKED` in a security definer function). |
| Executor dials out, no worker library on the executor                                | Poor. Workers are SDK processes (TS/Python/Go/Ruby, no Rust) over gRPC: either a sidecar on each machine (breaks the 50 MB executor budget and the Rust-only executor) or a relay worker in `serve`, which makes Hatchet a second state machine beside ours. | Neutral. Worker runs in the control plane and relays over our WebSocket; the library job stays `active` while the executor runs it, so timeouts and heartbeats must be mapped to offer/admission states. | Neutral, as pg-boss.                                             | Neutral, as pg-boss; a workflow would block in a step for the whole run.                                                         | Good. Offer/Admitted/Delayed/RunFinished already are the job states.                                                                                       |
| P0 schema (`tenant_id`, forced RLS, composite FKs)                                   | Poor. Own `Tenant` model and 261 tables in `public` of its database, no RLS; realistically needs its own database.                                                                                                                                           | Poor. Own schema, no `tenant_id`/RLS; tenant payloads would sit outside RLS, an exception to the P0 rule.                                                                                                | Poor, as pg-boss.                                                | Poor. Workflow inputs and outputs are stored in its tables outside RLS.                                                          | Good. Tables follow P0; the cross-tenant claim is a security definer function like `resolve_token` (spike ran it with forced RLS on `jobs`).               |
| `depends_on` DAG (§11.2: offer only when deps green, red dep → dependents `skipped`) | Partial. Native DAGs, but declared in worker code at registration; a gate's checks are per-tenant data, so it needs child spawning.                                                                                                                          | Good-ish. `flow()` takes `dependsOn` refs per request (`blocked`, `pending_dependencies`); skip-on-red semantics not verified.                                                                           | Poor. No dependencies (only `job_key` and serial queues).        | Partial. Dependencies are workflow code awaiting children.                                                                       | Good, ours to write: `depends_on` checked in the claim (spike), skip-on-red is one transition.                                                             |
| License / idle RAM                                                                   | MIT / ~368 MB total                                                                                                                                                                                                                                          | MIT / +9.7 MB                                                                                                                                                                                            | MIT / +3.2 MB                                                    | MIT (enterprise peer proprietary) / +7.9 MB                                                                                      | ours / +1.4 MB                                                                                                                                             |

## 5. Better Auth

Measured: Better Auth 1.7.25 runs on the app's own Kysely instance (`database: { db, type: 'postgres' }`), so it opens
no pool of its own; sign-up, organization creation and session read worked end to end through Fastify
(`toNodeHandler` behind `/api/auth/*`); `generateId: 'uuid'` gives uuid keys; +20.2 MB idle.

- **Organizations plugin → `tenants`/`members`: does not fit.** Model and field names can be remapped (spike:
  `organization` → `ba_tenants`, `member.organizationId` → `tenant_id`), but the shape is Better Auth's:
  `session."activeOrganizationId"` is `text`, member FKs are single-column, `invitation` has no `tenant_id`. With the
  P0 `tenant_isolation` policy forced on its org and member tables and a non-superuser role (as `serve` connects),
  `createOrganization` failed with `new row violates row-level security policy for table "ba_tenants"` and
  `listOrganizations` returned 0 rows: Better Auth queries outside `withTenant()`, so it never sets `app.tenant_id`.
- **Session tables under RLS: not possible as designed.** `user`, `session`, `account`, `verification` are global by
  nature (a person logs in before a tenant is chosen and may belong to several), so they cannot carry
  `tenant_id not null`. They hold identity, not tenant data.
- **Coexistence with P0 API tokens: fine.** Tokens (`drt_`, SHA-256, `resolve_token`) stay the agent/CLI path; the
  auth hook checks a Bearer token first and falls back to the session cookie. Better Auth's `bearer` plugin is not
  used.
- **Shape that fits:** Better Auth owns identity in its own schema (`auth`), organizations plugin off; P0 `members`
  gains `user_id` (nullable, human members only); after login a security definer `resolve_session` maps
  session → (tenant, member) the way `resolve_token` does, and every tenant query still goes through `withTenant()`.

## 6. Recommendation

1. **Build the scheduler on the P0 Postgres.** Claim with `FOR UPDATE SKIP LOCKED` inside a security definer function
   that filters by queue, priority/FIFO, per-queue concurrency, `depends_on` and `need <= free memory - reserve` of the
   offering machine; wake on `LISTEN/NOTIFY` with a slow poll as fallback. Reasons: the only option that keeps
   placement ours (spec §5.1), keeps every row under P0 RLS, needs nothing on the executor side, and costs ~1 MB and
   one connection. pg-boss and Graphile Worker are reference designs for the claim SQL and the LISTEN wake-up, not
   dependencies.
2. **Adopt Better Auth for identity only**, in schema `auth`, organizations plugin off, when session login is built.
   This needs an explicit P0 rule exception (§7). If Guilherme rejects the exception, the fallback is a small own
   session table under P0 rules with password login for the one human member.
3. Not adopted: Hatchet (RAM, Docker on Windows, placement and schema), DBOS and pg-boss (schema outside RLS, placement
   on top anyway), Graphile Worker (same, and no DAG).

## 7. What the stage-2 re-plan must cover

- Tables: queues (priority, concurrency cap, allowed job types), jobs (state machine of spec §5.4, `depends_on` edges
  within one gate, attempts, `need` snapshot), offers with expiry; all with `tenant_id`, forced RLS, composite FKs.
- The claim function: security definer, `search_path` pinned, execute only to the app role; inputs = machine id, last
  reported free memory, reserve; learned need per (project, job type, machine), default 512 MiB; ordering priority
  then FIFO; concurrency caps counted in the same statement.
- Wake-up: one dedicated LISTEN connection in `serve` (counts against Postgres connections, not the pool); fallback
  poll interval; NOTIFY on enqueue, on run finish and on `MachineReport`.
- Offer timeout → back to queue; executor `Delayed` keeps the offer; disconnect handling for offered/admitted jobs.
- Retry/backoff and max attempts per job type as separate runs (P1 design §3.1); skip-on-red propagation to dependents.
- Idempotency key on enqueue; transactional outbox for events.
- Scheduled jobs (the P2 daily improvement report needs one): a small schedule table driven by the same scheduler,
  not a library cron.
- A budget test on the whole control plane idle with the scheduler loaded (≤ 300 MB).
- Better Auth, when login is planned: the ruling on global identity tables in schema `auth` without `tenant_id`/RLS,
  `members.user_id`, `resolve_session`, auth hook order (token first, then cookie), cookie settings for the loopback
  host, and Better Auth migrations run by `devrounds-admin migrate` (owner role), never by `serve`.
