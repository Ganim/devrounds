# P5-T10 and P5-T11 report (28/11)

Branch `lane-p5-t10` from `main` 9f3d0aa, worktree `devrounds-lanes/p5-t10`. Both tasks in_progress, criterion 1
checked (events 1101, 1102), not done.

## Commits

- `1cb5337` Let the web view write by session cookie behind a cross-site guard (P5-T10)
- `9314392` Save member preferences per project for every device (P5-T11)

## P5-T10

`api/members.ts` `crossSiteRefusal()`: a cookie write (non-GET/HEAD, no Authorization) needs a non-blank
`x-devrounds-action`; `Origin`, when present, must be one of `SessionAuth.origins` (`webOrigins(port)`, the same
list Better Auth trusts); `Sec-Fetch-Site`, when present, must be `same-origin`. Otherwise DR402, checked before the
session lookup. DR402 gained a `reason` key and new words (`docs/errors.md` regenerated). Token auth is untouched:
an Authorization header still decides alone. Admitted cookie writes run the same routes, so `memberCtx` +
`withTenant` + RLS apply; tested by a cross-tenant cookie write answering DR201. README updated.

## P5-T11

Migration `0053_member_prefs`: PK `(tenant_id, member_id, project_id, name)`, composite FKs to members and projects,
`isolate()` (forced RLS + tenant policy), FK index on project, name check. `prefs/service.ts` + `api/pref-routes.ts`:
`GET /api/projects/:key/prefs`, `GET|PUT /api/projects/:key/prefs/:name` (body `{ value }`, ≤ 64 KiB JSON, name
`^[a-z][a-z0-9.-]{0,99}$`, Idempotency-Key accepted, last write wins, unset reads `{ value: null, updatedAt: null }`).
Scoped to the calling member.

## Tests (private DB devrounds_test_p5_t10)

- `node --test control-plane/src/auth/session.test.ts` 14/14 (2 new, 1 updated)
- `node --test control-plane/src/api/pref-routes.test.ts control-plane/src/tenancy/scope.test.ts` 19/19
- `pnpm test` 568/568; `pnpm typecheck` clean; biome clean on touched files (`pnpm lint` fails on main already:
  p6/p7 specs and `clickmax-v2.yaml` formatting, from 9f3d0aa).

## For P5-T08 to wire

- `data/http.ts`: send `x-devrounds-action: <name>` (e.g. `task.add`) on every non-GET, plus the Idempotency-Key;
  the current docstring "the cookie only reads" is stale.
- `data/contract.ts`: `listPrefs` GET `/prefs`, `getPref` GET `/prefs/:name`, `setPref` PUT `/prefs/:name`
  (project routes). `request()` must allow `PUT`.
- `web/src/contract.test.ts`: the fake `SessionAuth` now needs `origins: []` (one line, done here).
- `ConventionsPage.tsx` "(the web view only reads)" copy becomes stale once approve moves to the page.

## Risks

- Migration order: `migrate.ts` uses Kysely's default `allowUnorderedMigrations: false`. A DB that applies 0053 before
  P4's 0029-0052 exist will refuse those later ("corrupted migrations"). Merge this after P4's migrations, or enable
  unordered migrations in `migrate.ts` first. Includes the shared `devrounds_test` DB.
- Requests with neither Origin nor Sec-Fetch-Site pass on the action header alone (spec call 6); safe while CORS is
  never granted.
