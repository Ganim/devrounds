# P5-T09 report (stage A3, R3 shell)

Branch `lane-p5-t09` from `main` (9f3d0aa). `devrounds task start P5-T09` accepted with no phase refusal, so no phase
edit. Not done, not pushed. Only `web/src/app/` changed.

## What changed

- `app/routes.ts`: one table, per route: pattern, title, `master` (a detail route opens beside that list), nav entry
  (rail group `plan`/`operate`, phone placement `bar`/`more`). `NAV` is derived from it. Adds `hrefOf`, `navOf`, and the
  alias `/run/:id` -> `run` because feature pages still link there.
- `app/Shell.tsx` + `shell.css`: cx-env split at 900 px. Wide: rail (logo, two groups with a divider, sign out),
  title row (project, page title, totals), main column, and when a detail is selected a third grid column for the
  aside: 320-720 px, default 420, drag the left edge, double-click resets, kept in localStorage `devrounds.aside`.
  Phone: floating bottom bar (4 entries + More), "More" bottom sheet (other entries + sign out), and the detail in a
  bottom sheet over a backdrop, lifted by `--kb`/`--vvh`. The detail is one element; CSS moves it.
- Detail close (X, backdrop, Esc) goes to the list with its filters. A detail opened from a link without filters
  (`#/run/<id>` from Jobs or the list) shows the list with the last filters seen on it (per page load, cx-env tab memory).
- `app/layers.ts`: Esc closes the topmost layer only (More sheet before the detail). `app/viewport.ts`: publishes
  `--vvh`/`--kb` from `visualViewport`. `app/aside.ts`: width clamp and storage. `app/icons.tsx`: Lucide subset (ISC).
- `app/routes.test.ts`: parsing, `hrefOf` round trip, every route lights a nav entry (directly or via its master), a
  detail's master is a list, phone bar <= 4 entries, aside clamp.

## Route table

| Route | Pattern | Opens | Nav (rail group / phone) |
| ----- | ------- | ----- | ------------------------ |
| roadmap | `/` | main | plan / bar |
| phase | `/phase/:key` | aside over roadmap | lights Roadmap |
| balance, history, conventions | `/balance` `/history` `/conventions` | main | plan / more |
| machines, jobs, runs | `/machines` `/jobs` `/runs?state&jobType&queue` | main | operate / bar |
| queues | `/queues` | main | operate / more |
| run | `/runs/:id?<runs filters>` (alias `/run/:id`) | aside over runs | lights Runs |

## Validation

- `pnpm typecheck` ok. `node --test "web/src/**/*.test.ts" "scripts/**/*.test.ts"` 31/31.
- `pnpm lint`: 3 format errors, all in files this branch does not touch and already failing on `main` after 9f3d0aa
  (`docs/superpowers/specs/2026-11-28-p6-*.md`, `...-p7-*.md`, `roadmap/fixtures/conventions/clickmax-v2.yaml`).
  `biome check web/src/app` clean.
- `pnpm -F web build` ok (app.js 557 KB minified; T06 reported 561 KB).
- Preview on 4987 (static `web/dist`, GETs only forwarded to the live control plane with the CLI token, session
  stubbed), Playwright (cx-env's playwright-core, Edge) at 1280x900 and 390x844 mobile emulation, 14 routes each
  (`/`, `/phase/P5`, `/phase/P1`, balance, history, conventions, machines, queues, jobs, runs, `runs?state=failed`,
  `runs/<id>`, `run/<id>`, `runs/<id>?state=finished`): no page errors, no error box, no stuck loading, document width
  equals the viewport on every route, aside at x=860 w=420 on desktop and a fixed 390x776 sheet on phone.
- Interactions: More opens; Esc closes More, then the detail (`#/runs?state=finished` kept); tapping a row opens the
  sheet; backdrop closes it; resize to 600 px persists across reload; double-click resets to 420; desktop Esc closes.
- Headless Edge `--window-size=390` is not a phone viewport (it floors near 500 px); use Playwright emulation.
- Screenshots and scripts: `.superpowers/sdd/2026-11-28-p5-stage-a/t09-out/` (ignored, not committed).

## For other tasks

- P5-T07: replace `app/icons.tsx` with `ui/icons.tsx`; `shell.css` reads `--bg`, `--surface-1/2`, `--border`, `--text`,
  `--text-muted`, `--accent`, `--on-accent`, `--backdrop`, `--shadow-2/3`, `--z-nav`, `--z-sheet` with light
  fallbacks. The old `header.top`, `nav a`, `main` rules in `ui/style.css` are now dead. The detail aside/sheet here is
  app-level; a `ui/patterns` MasterDetail can absorb it later. No theme toggle here (theme is T07).
- P5-T08: the aside width key moves into `data/prefs.ts` (same key).
- P5-T12: feature links should use `hrefOf`-shaped `#/runs/<id>?<filters>`; then the `/run/:id` alias can go. Wide
  tables (runs, phase tasks) scroll sideways inside the main column/sheet on a phone.

## Risks

- The detail sheet covers the phone bottom bar (as cx-env's sheet does); nav from a detail means closing it first.
- The phase page in a 420 px aside scrolls its task table sideways; widen the aside or port the page (T12).
- A lane merging `routes.ts` in parallel (T07/T08 should not) would conflict on `NAV`'s shape (now derived, no `active`).
