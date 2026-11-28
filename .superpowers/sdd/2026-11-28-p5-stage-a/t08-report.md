# P5-T08 report (stage A2, R2 data layer)

Branch `lane-p5-t08` from `main` (9f3d0aa). `devrounds task start P5-T08` was accepted with no phase refusal, so the
phase was never edited. The task is not done and the branch is not pushed. No criterion check was recorded; record it
at merge with the merged commits as evidence.

## What changed

- `@tanstack/react-query` 5.108.4 in `web/package.json`.
- `data/query.tsx`: the one `QueryClient`, `DataProvider`, `queryKeyOf(name, params, query)` = `[project, name,
  params, query]`, so invalidation by `[project, name]` is ready for P5-T02. The defaults keep the old `useRemote`
  behavior: poll every 10 s (also in the background), no retry (a DR401 still shows at once), no refetch on focus or
  reconnect, previous data kept while a refresh fails.
- `data/resources.ts`: `useEndpoint` on `useQuery`, with the same `Remote<T>` shape and hook names, so pages did not
  change. Sign-in and sign-out clear the cache. `useWrite` adds an optimistic update with rollback and refresh keys.
  `useRunLog` is RunPage's log paging state machine, moved here unchanged. `useMemberPref` is a **stub**: P5-T11's
  `/prefs/:key` is not on main, so values live in localStorage under `devrounds.memberPref.<project>.<key>`. The
  comment there names the two functions that switch to the route, plus the contract entry to add.
- `data/http.ts`: `write()` sends `Idempotency-Key` (one per call) and `x-devrounds-action` (P5-T10's guard). Cookie
  writes still answer DR402 until T10 merges. `Endpoint.method` now also allows PUT and DELETE.
- `data/prefs.ts`: typed device prefs (`project`, `theme` under `devrounds.theme` for T07's pre-paint script,
  `asideWidth` for T09) with `get/set/useDevicePref`. `getProject`/`setProject` moved here from `http.ts`.
- Feature and app edits are import lines only (Login, ConventionsPage, main.tsx gets `<DataProvider>`), plus RunLog's
  state replaced by `useRunLog` in RunPage.
- `boundaries.test.ts`: `data/query.tsx` may be imported only by app and data, so features cannot reach the client.
  The existing rules (`@tanstack/` only in data, server types only through `data/contract.ts`) already cover the
  criterion.

## Validation

- `pnpm typecheck` ok; `node --test "web/src/**/*.test.ts" "scripts/**/*.test.ts"` 27/27 (boundaries and contract
  included); `biome check --error-on-warnings web` ok. Repo-wide `pnpm lint` fails on 3 files that already fail on
  main (p6/p7 design docs, `roadmap/fixtures/conventions/clickmax-v2.yaml`, added by 9f3d0aa), not on this branch.
- `pnpm -F web build` ok: app.js 563 KB on main, 597 KB here (+34 KB minified from TanStack Query).
- Pages: main's build and this build served on 5187/5188 by a throwaway static server that forwards only GETs to the
  live control plane with the CLI token (`t08-out/run.sh`, `preview.mjs`). Headless Edge `--dump-dom` of the same 12
  routes as P5-T06: 10 DOMs byte-identical, and the other 2 (`#/balance`, `#/machines`) differ only in live free-RAM
  figures. No DOM had an error box or was stuck loading. The run page rendered its log.

## Risks

- Behavior that changed: a page you come back to shows its cached data at once and then refetches, where it used to
  show "Loading..." first. Two components using one resource now share one request.
- `useMemberPref` does not sync across devices until T11. `write()` and `useWrite` have no consumer yet.
- Possible conflicts: `app/main.tsx` (one import plus the render wrapper) with T09, and `RunPage.tsx` (RunLog's
  head) with T07/T09.
