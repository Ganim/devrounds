# AGENTS.md

Invariants derived from `MANIFESTO.md`. Change them only together with it, with Guilherme's approval.

## Every session

- Start with `devrounds plan show`.
- Record progress with `devrounds task start`, `devrounds task done`, `devrounds task block` and `devrounds criterion check`.
- The roadmap in DevRounds is the source of truth. Files under `roadmap/` are seeds or snapshots.

## Never

- Never call synchronous child-process or `*Sync` fs functions in `control-plane/src` outside tests (`no-sync.test.ts`).
- Never read or write tenant data outside `withTenant()`, except owner-side `devrounds-admin` commands, which read as the owner.
- Never connect the server as the owner role; it uses `devrounds_app` (NOSUPERUSER, NOBYPASSRLS). Migrations and admin
  commands use the owner URL.
- Never create a table without `tenant_id uuid not null` (`tenants` uses `id`), RLS enabled and forced, and the policy
  `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid` in USING and WITH CHECK.
- Never reference another tenant table with a single-column FK. Use `(tenant_id, x_id) -> (tenant_id, id)` and
  `unique (tenant_id, id)` on the parent.
- Never answer a cross-tenant access with a permission error. Answer DR201 (not found).
- Never put error text, hint or HTTP status outside `errors/words.ts`. Never renumber a code.
- Never put a vendor, customer or tool name in engine code. Providers are adapters.
- Never rerun a flaky test; fix it. Never suppress a lint rule inline.
- Never start a process in the executor outside `devrounds_sys_windows::spawn`.

## Always

- Throw `DevRoundsError{code, data}`. Codes are `DR` plus 3 digits: 1xx input, 2xx not found, 3xx state conflict,
  4xx auth/permission, 5xx internal.
- CLI exit codes: 0 ok, 1 state conflict, 2 input/usage, 3 not found, 4 control plane unreachable, 5 auth/permission,
  6 internal.
- Agent output mode: failures first; body cut at 16384 bytes on a whole line, then
  `truncated; more: <exact command with --cursor N>`; last line `next: <command>`.
- Keys: project `devrounds`; phases `P0`..`P7`; tasks `P<phase>-T<two digits>`, unique per project; finding tasks (unphased, `task open-finding`) `F-<4 digits>`.
- Accept `Idempotency-Key` on mutating API routes (same key and tenant within 24 h returns the stored response).
- Pair an executor with `devrounds machine pair-code --name <machine>` (human members only), then run the printed
  `devrounds-executor pair` on that machine. Machine tokens and pairing codes are stored only as SHA-256.
- Run the executor as the `DevRoundsExecutor` scheduled task (`devrounds-executor service install`, after pairing).
  Check the idle budgets with `pnpm footprint` and the executor end to end through the scheduler with `pnpm e2e`.
- Run a job with `devrounds run start <jobType> --cwd <path> [--machine <name>]` (queued; the scheduler offers it to a
  machine with room, `--machine` pins it), then read its outcome with `devrounds run show <id> --wait` (failures
  first: state, class, summary). List runs newest first with `devrounds run list [--state <s>] [--job-type <k>]`
  (failed, stopped and orphaned first; a cut output prints the `--cursor` that continues it).
- Queue several dependent jobs with `devrounds batch submit <file.yaml>` (`depends_on` by ref; a failed or stopped job
  skips its dependents), recurring ones with `devrounds schedule set <key> --job-type <jt> --cwd <path> --every <s>`
  (or `--daily HH:MM`), and shape queues with `devrounds queue set <key>`. Automatic retries come from the job type's
  `retry` (`max_attempts`, `backoff_s`, `on`). Read trends with `devrounds indicators`.
- Run a repo gate (its checks for one worktree, from a YAML file) with `devrounds gate run <file> --cwd <path> --wait`;
  failures come first, each with its `devrounds run logs` command. Read one later with `devrounds gate show <id>`.
- Record a finding with `devrounds task open-finding --source-key <key> --title <text>`; while a task of that key is
  open it answers that task instead of a new one.
- Balance uses the tenant `timezone` (default `America/Sao_Paulo`), weeks start Monday, calendar days.
- Write identifiers, errors, docs and commit messages in English.
- Control plane listens on `127.0.0.1:4992`. Postgres is `devrounds-postgres` on host port 15433.
- Use the `x5x` block of each range for executor, protocol and run errors: DR150, DR151, DR152, DR153, DR350, DR351,
  DR352, DR450, DR451, DR452, DR453, DR550, DR551, DR552, DR553. The executor emits `DrError::new("DR###", data)`
  and prints `DR### <data json>` plus `see docs/errors.md`; text and hints stay in `errors/words.ts`.

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
