# AGENTS.md

Invariants derived from `MANIFESTO.md`. Change them only together with it, with Guilherme's approval.

## Every session

- Start with `devrounds plan show`.
- Record progress with `devrounds task start`, `devrounds task done`, `devrounds task block` and `devrounds criterion check`.
- The roadmap in DevRounds is the source of truth. Files under `roadmap/` are seeds or snapshots.

## Never

- Never call synchronous child-process or `*Sync` fs functions in `control-plane/src` outside tests (`no-sync.test.ts`).
- Never read or write tenant data outside `withTenant()`.
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

## Always

- Throw `DevRoundsError{code, data}`. Codes are `DR` plus 3 digits: 1xx input, 2xx not found, 3xx state conflict,
  4xx auth/permission, 5xx internal.
- CLI exit codes: 0 ok, 1 state conflict, 2 input/usage, 3 not found, 4 control plane unreachable, 5 auth/permission,
  6 internal.
- Agent output mode: failures first; body cut at 16384 bytes on a whole line, then
  `truncated; more: <exact command with --cursor N>`; last line `next: <command>`.
- Keys: project `devrounds`; phases `P0`..`P7`; tasks `P<phase>-T<two digits>`, unique per project.
- Accept `Idempotency-Key` on mutating API routes (same key and tenant within 24 h returns the stored response).
- Balance uses the tenant `timezone` (default `America/Sao_Paulo`), weeks start Monday, calendar days.
- Write identifiers, errors, docs and commit messages in English.
- Control plane listens on `127.0.0.1:4992`. Postgres is `devrounds-postgres` on host port 15433.

## Accepted P0 exceptions

- The web view uses a pasted API token instead of session login. Removed in P1 (Better Auth).
- The web view polls every 10 s instead of SSE. Removed in P5.
