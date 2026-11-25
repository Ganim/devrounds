# AGENTS.md

Invariants derived from `MANIFESTO.md`. Change them only together with it, with Guilherme's approval.

## Every session

- Start with `devrounds plan show`.
- Record progress with `devrounds task start`, `devrounds task done`, `devrounds task block` and `devrounds criterion check`.
- The roadmap in DevRounds is the source of truth. Files under `roadmap/` are seeds or snapshots.

## Invariants

<!-- devrounds:conventions begin version=2 sha256=638b2a4fe6868b55 -->
### Never

- Never call synchronous child-process or `*Sync` fs functions in `control-plane/src` outside tests. One blocked call stalls every tenant sharing the event loop. `no-sync.test.ts` checks every file; this rule points at the added line. (checked)
- Never read or write tenant data outside `withTenant()`, except owner-side `devrounds-admin` commands, which read as the owner. RLS reads `app.tenant_id`, which only `withTenant()` sets, for one transaction; outside it a query has no tenant.
- Never connect the server as the owner role; it uses `devrounds_app` (NOSUPERUSER, NOBYPASSRLS). The owner bypasses RLS. Migrations and admin commands use the owner URL. (checked by devrounds-test)
- Never create a table without `tenant_id uuid not null` (`tenants` uses `id`), RLS enabled and forced, and the tenant policy. The policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid` in USING and WITH CHECK is what isolates tenants; `isolate()` writes it and the catalog guard fails a table without it. (checked by devrounds-test)
- Never reference another tenant table with a single-column FK. Use `(tenant_id, x_id) -> (tenant_id, id)` and `unique (tenant_id, id)` on the parent, so a row can only point at a row of its own tenant.
- Never answer a cross-tenant access with a permission error; answer DR201 (not found). A permission error tells the caller the row exists in another tenant; a cross-tenant lookup looks like a missing row.
- Never put error text, hint or HTTP status outside `errors/words.ts`. One words layer documents every code in `docs/errors.md`. `errors.test.ts` fails a code without words, but not text or a status written elsewhere, so a reviewer reads for it.
- Never renumber a code. Agents and scripts depend on codes; a new meaning gets a new code.
- Never put a vendor, customer or tool name in engine code. Providers are adapters; the moment the core names one, a second customer needs a fork. (checked)
- Never rerun a flaky test; fix it. A rerun hides a race or a leak that fails again later; open a finding for it.
- Never suppress a lint rule inline. A false positive is fixed in the code or the rule. `no-suppressions.test.ts` fails an inline biome suppression and `executor-guards.test.ts` a Rust allow outside the FFI modules. (checked by devrounds-test)
- Never start a process in the executor outside `devrounds_sys_windows::spawn`. It is the one place that starts processes, hidden and inside a job; `executor-guards.test.ts` fails any other. (checked by devrounds-test)
- Never add a `*.test.ts` file outside `control-plane/src`, `web/src` and `scripts`. `pnpm test` runs only the tests under those three directories, so a test elsewhere never runs. (checked)

### Always

- Throw `DevRoundsError{code, data}`. Codes are `DR` plus 3 digits: 1xx input, 2xx not found, 3xx state conflict, 4xx auth/permission, 5xx internal. A plain `Error` carries no code, so the caller gets an internal error with no hint; this rule points at the added `throw`. (checked)
- CLI exit codes: 0 ok, 1 state conflict, 2 input/usage, 3 not found, 4 control plane unreachable, 5 auth/permission, 6 internal. Scripts and job types classify by exit code; `errors.test.ts` checks the range table. (checked by devrounds-test)
- Agent output mode: failures first; body cut at 16384 bytes on a whole line, then `truncated; more: <exact command with --cursor N>`; last line `next: <command>`. An agent reads the first lines and runs the last, so what failed comes first and every cut output says how to go on.
- Keys: project `devrounds`; phases `P0`..`P7`; tasks `P<phase>-T<two digits>`, unique per project; finding tasks (unphased, `task open-finding`) `F-<4 digits>`. Agents, commits and evidence name tasks by key, so a key reads the same everywhere.
- Accept `Idempotency-Key` on mutating API routes. The same key and tenant within 24 h returns the stored response, so a retried request never applies twice.
- Pair an executor with `devrounds machine pair-code --name <machine>` (human members only), then run the printed `devrounds-executor pair` on that machine. Only a human admits a machine to the tenant. Machine tokens and pairing codes are stored only as SHA-256.
- Run the executor as the `DevRoundsExecutor` scheduled task (`devrounds-executor service install`, after pairing). It starts hidden at logon, so runs never depend on an open shell. Check the idle budgets with `pnpm footprint` and the executor end to end through the scheduler with `pnpm e2e`.
- Run a job with `devrounds run start <jobType> --cwd <path> [--machine <name>]`, then read its outcome with `devrounds run show <id> --wait`. The run is queued and the scheduler offers it to a machine with room (`--machine` pins it); `run show` prints failures first: state, class, summary. List runs newest first with `devrounds run list [--state <s>] [--job-type <k>]` (failed, stopped and orphaned first; a cut output prints the `--cursor` that continues it).
- Queue several dependent jobs with `devrounds batch submit <file.yaml>`, recurring ones with `devrounds schedule set <key> --job-type <jt> --cwd <path> --every <s>`. `depends_on` is by ref, and a failed or stopped job skips its dependents; `--daily HH:MM` instead of `--every`. Shape queues with `devrounds queue set <key>`. Automatic retries come from the job type's `retry` (`max_attempts`, `backoff_s`, `on`). Read trends with `devrounds indicators`.
- Run a repo gate (its checks for one worktree, from a YAML file) with `devrounds gate run <file> --cwd <path> --wait`. Failures come first, each with its `devrounds run logs` command. Read one later with `devrounds gate show <id>`.
- Record a finding with `devrounds task open-finding --source-key <key> --title <text>`. While a task of that key is open it answers that task instead of a new one, so a tool that finds the same thing twice opens one task.
- Balance uses the tenant `timezone` (default `America/Sao_Paulo`), weeks start Monday, calendar days. A day is the team's local day, not UTC, so the balance and the indicators match what people saw.
- Write identifiers, errors, docs and commit messages in English. One language for every reader, human or agent, and for searching the code.
- Control plane listens on `127.0.0.1:4992`; Postgres is `devrounds-postgres` on host port 15433. Fixed local ports, so the CLI, the executor and the tests find them without configuration.
- Use the `x5x` block of each range for executor, protocol and run errors: DR150, DR151, DR152, DR153, DR350, DR351, DR352, DR450, DR451, DR452, DR453, DR550, DR551, DR552, DR553. The executor emits `DrError::new("DR###", data)` and prints `DR### <data json>` plus `see docs/errors.md`; text and hints stay in `errors/words.ts`.
<!-- devrounds:conventions end -->

## Accepted P0 exceptions

- Better Auth identity tables in schema `auth` (no `tenant_id`, no RLS); tenant data never goes there; the schema is
  created by `devrounds-admin migrate`, never by `serve`.
- The local Postgres owner is the `postgres` superuser (migrations, admin, tests). Removed in P6 (cloud, managed owner role).
- The web view polls every 10 s instead of SSE. Removed in P5.
- `#[allow(unsafe_code)]` on the FFI modules of `executor/crates/sys-windows/src/lib.rs`, each unsafe block with a
  SAFETY comment.
- The directory names `.git`, `node_modules` and `.superpowers` in `conventions/candidates.ts` (`SKIPPED_DIRS`), and
  `.git` with its 8.3 name `git~N` in `conventions/file.ts` (`targetPathIssue`): data the engine skips or refuses, not
  an adapter naming a tool. Added in P3.
