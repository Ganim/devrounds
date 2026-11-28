# DevRounds P5 Interface — design

Status: written 28/11 by Claude; Guilherme reviews after the fact (he asked on 17/11 not to wait for approval). Parent
spec: `C:/Users/Guilherme/Code/Clickmax/cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md` ("the
spec", §9 step 5, §10 "Terminals", §14 "Live UI from the event log", "Visible (P1/P5)"). P4 design
(`2026-11-28-p4-agent-runs-design.md`) is written in parallel and did not exist when this was written; every P4 data
dependency below names the P4 task, not that document, and is rechecked when it lands.

Roadmap (28/11): P5 goal "The web UI shows operations live and edits visual flows"; tasks P5-T01 full operational
view, T02 SSE live UI, T03 visual flows, T04 node catalog (after T03), T05 messaging with Slack; phase criteria: live
over SSE replacing the 10 s polling, a flow built in the visual editor runs, final review. Phase edge: blocked by P4.

Guilherme's ask (28/11): to use DevRounds for real he needs everything the cx-env panel shows today, in DevRounds,
built on a structure that does not repeat the current web code's mess. The final visual design comes later; this
document fixes the structure pages are built on and the order they are built in.

## 1. What exists today (inventory, 28/11)

**DevRounds web (`web/src`, 2040 lines).** React 19, esbuild (`web/build.ts`, one bundle, `style.css` → `app.css`),
flat folder: 10 pages, `api.ts` (fetch + `useRemote` polling every 10 s + `usePages`), `ui.tsx` (Pill, StackedBar,
ErrorBox, Loading, `when`), `style.css` (306 lines, 8 variables, light only), three pure modules with node tests.
Routing is a hash `if/else` chain in `main.tsx`. Response types are imported from `control-plane/src` (type-only) and
mapped by `Wire<T>`. The browser session cookie only reads: any non-GET by cookie is DR402
(`control-plane/src/api/members.ts`, P1 plan call 13), so the web view cannot act on anything. What makes it messy:
pages mix fetching, layout and inline styles (`style={{...}}` in RunPage and others), one global stylesheet with page
selectors, no shared list/detail layout, no place for a primitive to live except `ui.tsx`.

**DevRounds API the web can already read (P1-P3).** `/plan`, `/phases/*`, `/tasks/*`, `/criteria`, `/events`,
`/links`, `/findings`, `/balance`, `/indicators` (+ `/gates`, `/now`), `/runs`, `/runs/:id`, `/runs/:id/logs`,
`/jobs`, `/queues`, `/schedules`, `/batches/:id`, `/gates/:id` (no gate list), `/job-types/:jobType`, `/conventions/*`,
`/api/machines` (free/reserved/reserve bytes, `lastReport` with `cpu_percent`, `memory_pressure`, commit charge).
Postgres `LISTEN/NOTIFY` is already used for the scheduler (`scheduler/notify.ts`, payload = tenant id only). The
executor already sends live `LogChunk` output beside durable `LogSegment`s.

**cx-env panel.** `src/ui/page-v2.html` (14 830 lines, served at `/`; v1 `page.html` at `/v1/`, still the target of
several v2 links) plus the React Flow canvas `src/ui/canvas/` ("esteira"). One HTML file of string templates, redrawn
whole by `draw()` and patched by a keyed DOM morph (`morph()`, L3538). Live state = SSE `/events` pushing the full
`DashboardSnapshot` (`src/ui/dashboard.ts:95-146`) on change (1 s signature check), plus per-feature polling (Slack 5 s,
inbox 30 s, flow reads 15 s). Writes are POSTs with header `x-cx-env-action` (custom header + Origin check as CSRF
guard, `dashboard.ts:1272`). Dark and light themes (`html[data-theme]`, key `devrounds.theme`), one breakpoint at 900 px
(aside panel ↔ bottom sheet), dialogs become sheets on phones, `visualViewport` drives keyboard-aware layout, PWA
manifest + web push service worker. Screenshots: `C:/Users/Guilherme/Code/Clickmax/monorepo/cxenv-*.png` (left rail
Tasks/Slots/Computador/Fila, CPU/RAM/Docker ring strip, card list with drag grip and progress bar, right panel with
chips, subagents, conversation and composer, slash list, model sheet on phone).

## 2. Parity inventory

Status: **exists** (DevRounds shows it today), **partial** (some of it, or the data but no screen), **missing**.
Data phase: where the backend data comes from. "P5 (new)" = this phase adds backend work. Source pointers are
`cx-env/src/ui/page-v2.html` line or function unless a file is named.

### 2.1 Shell and global

| #   | cx-env screen / feature                                                            | Source                                       | DevRounds                             | Data needed                       | Data phase                                 |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------- | --------------------------------- | ------------------------------------------ |
| 1   | App shell: rail (desktop), bottom nav and "…" menu (phone), breadcrumbs title row  | `v2NavHtml` L4177, `v2Title` L4298           | partial (top nav only)                | none                              | —                                          |
| 2   | Header live dot ("ao vivo", N online), CPU/RAM/Docker ring strip                   | `v2Header` L4217, `machineMeters`            | missing                               | machine reports; docker size      | P1 (CPU/RAM); P5 (new, by-category report) |
| 3   | Project switcher, project avatars with online/waiting counts, project CRUD dialogs | `v2ProjectsHtml` L3708, `openProjects` L7224 | partial (localStorage key, no UI)     | projects list; per-project counts | P2 (projects); P4-T08 (counts)             |
| 4   | Theme toggle dark/light, no-flash inline script                                    | page-v2 L11                                  | missing (light only)                  | none                              | —                                          |
| 5   | Toasts, full-screen viewer (table/image), Esc layering, resizable aside            | L6949, `openViewer` L14799, L14776           | missing                               | none                              | —                                          |
| 6   | Live updates (SSE snapshot + on-demand reads)                                      | `connect()` L14756, `dashboard.ts` H1153     | missing (10 s polling)                | event stream                      | P5-T02                                     |
| 7   | Remote access through Cloudflare Access, kill switch, audit log                    | `src/ui/access.ts`                           | partial (Better Auth login, loopback) | auth                              | P6-T01                                     |
| 8   | PWA manifest, web push devices and prefs                                           | `flowAlertsScreen` L10853, `src/ui/sw.js`    | missing                               | push subscriptions                | P5 (new, messaging provider)               |
| 9   | Notification dock (per-source bubbles, read, read all, join call)                  | `v2InboxHtml` L7783                          | missing                               | notifications feed                | P5-T05 + P4-T02                            |

### 2.2 Agent sessions (cx-env "Tasks"/"Terminais")

| #   | cx-env screen / feature                                                                           | Source                                                   | DevRounds | Data needed                        | Data phase             |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------- | ---------------------------------- | ---------------------- |
| 10  | Session list: cards with status dot, stage, ctx %, cost, progress bar; filters all/active/offline | `terminalsScreen` L5211, `cardOf`; `src/ui/terminals.ts` | missing   | session records + cockpit report   | P4-T08                 |
| 11  | Drag reorder of cards and sections, user sections with saved routines                             | L13556, L13626, `sectionBlock` L5365                     | missing   | member prefs (order, sections)     | P5 (new, member prefs) |
| 12  | Rename / remove name of a session (inline and dialog)                                             | `startTitleEdit` L7102                                   | missing   | member prefs (names)               | P5 (new, member prefs) |
| 13  | Session panel: chips, description, model, PR, subagents, close session                            | `terminalPanel` L6018                                    | missing   | report, children, PR link          | P4-T08, P4-T11         |
| 14  | Conversation thread with folds, paging, copy, forward                                             | `threadOf`, `openForward` L13521                         | missing   | turns                              | P4-T08                 |
| 15  | Question card (answer a blocked agent)                                                            | L5969                                                    | missing   | pending question + answer route    | P4-T08                 |
| 16  | Composer: optimistic bubbles, queue (merge/cancel/send now), drafts, Enter rules                  | L14100-14720, `src/ui/optimistic.ts`                     | missing   | instruction inbox                  | P4-T08                 |
| 17  | Slash-command list with prefix-then-contains filter and source labels                             | `loadCommands` L14196; `src/ui/commands.ts`              | missing   | commands of the session's cwd      | P4-T08                 |
| 18  | Model picker dialog / phone sheet with search                                                     | `openModelPicker` L7034; `src/ui/models.ts`              | missing   | model list from the agent provider | P4-T03                 |
| 19  | Attachments (paste, picker, drop), uploads                                                        | L14363-14412; `src/ui/uploads.ts`                        | missing   | upload store                       | P4-T08                 |
| 20  | Voice input (record, transcribe, polish)                                                          | L14414-14710                                             | missing   | transcription provider             | P5 (new)               |
| 21  | Unstick (interrupt/restart), end-session modes                                                    | `openUnstick` L6004, L13750                              | missing   | session control routes             | P4-T08                 |
| 22  | Launch dialog, closed tabs reopen/dismiss, daily routines                                         | `launchTerminal` L8714, `renderClosedTabs` L5347         | missing   | session start + closed list        | P4-T08                 |
| 23  | Attach to a hidden terminal (xterm.js)                                                            | parent spec §10                                          | missing   | PTY stream                         | P4-T08                 |

### 2.3 Tasks, boards, PRs

| #   | cx-env screen / feature                                                               | Source                                                        | DevRounds                                                 | Data needed                         | Data phase                 |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- | -------------------------- |
| 24  | Roadmap, phase page, dependency graph                                                 | — (DevRounds only)                                            | exists                                                    | plan                                | P0-P2                      |
| 25  | Tarefas kanban: configurable columns, card actions, bulk bar, column drawer           | `kanbanScreen` L4664, `kbOpenEditor` L4782                    | missing                                                   | plan tasks + runs + PRs             | P1 (tasks); P4-T10, P4-T11 |
| 26  | Board-task modal: card, progress (stepper, Gantt, tries), actions (merge box, thread) | `boardTaskPanel` L5015                                        | partial (phase page lists tasks)                          | task, runs, PR, turns               | P1; P4-T10, P4-T11         |
| 27  | Task panel: runs, sessions, agents, ask agent                                         | `taskPanel` L6156                                             | missing                                                   | task ↔ runs ↔ sessions              | P1; P4-T08                 |
| 28  | Architect board (triage items, plans, promote, auto-run)                              | `architectScreen` L6534; `src/ui/board.ts`                    | missing                                                   | triage items                        | P4-T10                     |
| 29  | Linear screens (projects, mine, loose, card panel, field edits, play, new task)       | `linearScreen` L11790, `openLinearNew` L12367                 | partial (DevRounds plan replaces Linear for its own work) | issue-tracker provider reads/writes | P4-T02                     |
| 30  | PR list, PR detail, merge box, conflicts, Slack RFR publish, settings                 | `prsScreen` L9504, `prStrip` L3844; `src/ui/pull-requests.ts` | missing                                                   | PR facts, checks, conflicts         | P4-T11; P5-T05 (RFR)       |
| 31  | Balance, history                                                                      | — (DevRounds only)                                            | exists                                                    | plan events                         | P1                         |
| 32  | Conventions (versions, proposal diff, approve)                                        | — (DevRounds only)                                            | partial (read-only, approve needs a write)                | conventions                         | P3                         |

### 2.4 Runs, flows, metrics

| #   | cx-env screen / feature                                                                  | Source                                             | DevRounds                                      | Data needed                                | Data phase                      |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ | ------------------------------- |
| 33  | Run list and run detail (timeline, resources, steps, delays, log)                        | `traceScreen` L9051, `traceRunScreen` L9095        | exists (polling, log by "more")                | runs, logs                                 | P1                              |
| 34  | Live log tail                                                                            | job log tail `/logs/:jobId`                        | missing                                        | `LogChunk` stream                          | P1 data; P5-T02                 |
| 35  | Run actions: stop, retry, prioritize                                                     | flow-routes.ts:183-188, `/api/jobs/:id/prioritize` | missing                                        | stop exists; retry/prioritize              | P1 (stop); P5 (new, prioritize) |
| 36  | Pipeline steps vs 7-day p50/p90, token split                                             | `traceRunScreen` L9095                             | partial (steps, no baseline)                   | step stats, tokens                         | P1; P4-T03 (tokens)             |
| 37  | Queues: depth, pause/resume/drain                                                        | flow screens; flow-routes.ts:193                   | partial (list, read-only)                      | queues                                     | P1 (+ pause, P5 new)            |
| 38  | Jobs / batches / schedules ("Gatilhos" list, detail, pause, fire)                        | `triggersScreen` L10272                            | partial (jobs page; no schedules/batches page) | schedules, batches                         | P1                              |
| 39  | Gates list and detail                                                                    | — (cx-env gates queue)                             | missing (no list route)                        | gates                                      | P2 (+ list route, P5 new)       |
| 40  | Flow home: overview, attention, proposals, alerts, digest, agents kill switch            | `flowHomeScreen` L10509                            | missing                                        | findings, improvement report, agent policy | P2 (findings); P4-T14; P4-T02   |
| 41  | Visual flow editor (build/observe, palette, inspector, plan/apply/rollback, run overlay) | `src/ui/canvas/App.tsx`, `Inspector.tsx`           | missing                                        | flow definitions + runs                    | P4-T10 engine; P5-T03, P5-T04   |
| 42  | Métricas: lead time, phases, PRs/day, rework, bottlenecks, spend                         | `metricsScreen` L10170; `src/stats/`               | partial (indicators via CLI only)              | indicators; PR facts; spend                | P1-P3; P4-T11; P4-T03           |

### 2.5 Machines and environments

| #   | cx-env screen / feature                                                                            | Source                                                               | DevRounds                          | Data needed                | Data phase                        |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------- | -------------------------- | --------------------------------- |
| 43  | Machines list                                                                                      | —                                                                    | exists                             | machines                   | P1                                |
| 44  | System view: rings, memory by category, top consumers, per-project use, Docker, health             | `systemScreen` L5512, `memoryCard`                                   | partial (free/reserved bytes only) | per-category memory report | P5 (new, executor report)         |
| 45  | Optimize memory, restart daemon                                                                    | `openOptimize` L8950, `restartDaemon` L8911                          | missing                            | executor control           | P4-T13 (restart); P5 (new, sweep) |
| 46  | Admission view: RAM gate, delays, waiting queue                                                    | `slotsScreen` L5450, `queueScreen` L5583                             | partial (delays on run page)       | admission state            | P1                                |
| 47  | Slots grid + slot panel: services start/stop/restart, admin, regenerate, kill, preserve/unpreserve | `slotPanel` L6228                                                    | missing                            | environments               | P4-T12                            |
| 48  | Worktrees: inventory, scan, bulk delete with pause/resume/cancel, post-merge sweep                 | `worktreesScreen` L10924; `src/ui/worktrees.ts`, `worktree-sweep.ts` | missing                            | worktree inventory         | P4-T12                            |

### 2.6 Hub apps

| #   | cx-env screen / feature                                                          | Source                      | DevRounds | Data needed             | Data phase     |
| --- | -------------------------------------------------------------------------------- | --------------------------- | --------- | ----------------------- | -------------- |
| 49  | Integrations page (connect API key / OAuth, disconnect)                          | `integrationsScreen` L11161 | missing   | vault + hub             | P4-T01, P4-T02 |
| 50  | Browser drawer (streamed browser, bookmarks, shared logins, viewports, devtools) | `openBrowserDrawer` L13028  | missing   | browser pool stream     | P4-T09         |
| 51  | Artifact gallery, visual baselines approval                                      | (cx-prints today)           | missing   | artifacts, baselines    | P4-T06, P4-T07 |
| 52  | Slack app (sidebar, conversation, threads, reactions, edit, forward)             | `slackScreen` L8291         | missing   | messaging provider      | P5-T05         |
| 53  | Google mail and calendar                                                         | `googleScreen` L7609        | missing   | mail/calendar providers | P4-T02         |

**Counts: 53 rows; exists 4 (24, 31, 33, 43), partial 12 (1, 3, 7, 26, 29, 32, 36, 37, 38, 42, 44, 46), missing
37.** By what blocks the screen: 19 can be built now on P1-P3 data plus small P5 backend additions (1, 2, 4, 5, 6,
24, 31-39, 42, 43, 44, 46); 28 wait for a P4 task (3, 10-19, 21-23, 25-30, 40, 45, 47-51, 53); 5 wait for P5's own
engines (8, 9, 20, 41, 52); 1 waits for P6 (7).

Not carried over: v1-only screens (`/v1/`), the legacy rail and phone Tools dialog, cx-env's per-slot port warnings
(devlanes owns ports since 16/11), and the Clickmax-specific prompt files under `src/ui/architect-*` (provider/job-type
content, not UI). Linear stays a provider (row 29): DevRounds's own plan is the task model, Linear screens render
provider data through the same task components.

## 3. Calls (28/11, Claude)

1. **React 19 + esbuild stay.** Both are in place, React Flow (`@xyflow/react`) is React, xterm.js has a React-free
   API, and the parent spec lists React Flow and xterm.js. esbuild gains `splitting: true` and lazy chunks for the
   flow editor, the dependency graph (dagre) and the terminal, and a `dev` script (esbuild watch; the control plane
   serves `web/dist` as now). No Vite, no Next. _Cost if wrong:_ moving to Vite later replaces `build.ts` and nothing
   under `src`.

2. **Folder structure with enforced layers.**

   ```
   web/src/
     app/        main.tsx, Shell (rail, bottom nav, title row), routes.ts, providers.tsx
     ui/         tokens.css, base.css, primitives/ (one file + one css each), patterns/, icons.tsx, index.ts
     data/       http.ts, contract.ts, resources.ts, live.ts, prefs.ts
     features/   planning/ balance/ history/ conventions/ machines/ runs/ queues/ jobs/ gates/
                 sessions/ environments/ prs/ flows/ hub/ notifications/   (one folder per area)
     lib/        pure helpers (format, segments, filters)
   ```

   Imports go downward only: `app → features → (ui, data, lib)`; `ui` imports only `ui` and `lib`; `data` imports
   only `data`, `lib` and, type-only, `control-plane/src` (only `data/contract.ts` does); a feature never imports
   another feature (shared pieces move to `ui/patterns` or `lib`). `web/src/boundaries.test.ts` reads every import
   and fails a violation, the same way `no-sync.test.ts` guards the control plane (manifesto §10, §11). _Why:_ the
   current mess is pages that fetch, lay out and style in one file; a checked layer rule keeps parity work from
   re-growing it. _Cost if wrong:_ a rule that blocks a legitimate import is relaxed in the test, one line.

3. **Design system inside the repo: tokens, primitives, patterns.** No external component library (none matches the
   cx-env look, and the final design comes later; tokens let it change in one file).
   - `ui/tokens.css`: CSS custom properties only. Raw scale (`--gray-0..12`, `--blue-*`, `--green-*`, `--amber-*`,
     `--red-*`, spacing `--space-1..8`, radius, font sizes, shadows, z-layers) and semantic tokens components use
     (`--bg`, `--surface-1..3`, `--border`, `--text`, `--text-muted`, `--accent`, `--state-ok|info|warn|danger|idle`).
     Components read semantic tokens only; a domain state (task `blocked`, run `orphaned`) maps to a semantic state
     in its feature, never to a color.
   - `ui/primitives`: Button, IconButton, Badge/Chip, Card, Ring (gauge), ProgressBar, Segmented (filter tabs),
     Toggle, Input/Textarea, Select, Table, Dialog (native `<dialog>`; a bottom sheet under 900 px), Popover,
     Combobox (search + keyboard list; used by the slash list and the model picker), Menu, Toast, Tooltip, Spinner,
     EmptyState, ErrorBox, Mono, Time (relative, refreshed every 10 s). No data, no domain words.
   - `ui/patterns`: AppPage (title row + actions), MasterDetail (list + aside panel ↔ sheet), ListCard (grip, dot,
     title, meta line, edge progress), StatStrip, SortableList (pointer drag with keyboard fallback), Thread +
     Bubble, ComposerShell (textarea, attach, send, suggestion slot), Kanban (columns, drag), LogView (virtualized
     tail), Graph (React Flow wrapper, lazy).
   - CSS: one plain `.css` file per primitive/pattern, class prefix `dr-`, imported by its component (esbuild bundles
     them). No Tailwind, no CSS-in-JS, no inline `style` except computed geometry (widths, positions). Icons: the
     needed subset of Lucide (ISC) copied into `ui/icons.tsx` with its license header.
     _Cost if wrong:_ the final design replaces token values and primitive CSS; pages built on primitives do not move.

4. **Data layer: hand-written typed contract + TanStack Query.**
   - `data/contract.ts` is the only file importing server types; it keeps `Wire<T>` and declares each endpoint once
     (method, path template, params, response type). No OpenAPI generation: routes do not schematize responses and
     the type-import path already gives end-to-end types without a generator. `web/src/contract.test.ts` builds the
     server (`buildServer` without listening) and fails when a contract path has no registered route, so a renamed
     route breaks the test, not the page.
   - `data/http.ts`: `request()` (as today), `ApiError`, an `Idempotency-Key` per mutation (AGENTS invariant), the
     write header of call 6.
   - `data/resources.ts`: query keys and hooks per resource (`useRuns(filters)`, `useRun(id)`, `useMachines()` …)
     and mutations with optimistic update + rollback (cx-env shows the revert on failure,
     `cxenv-03c-tasks-reverted.png`). TanStack Query (MIT) gives cache shared between list and detail panel, dedupe,
     invalidation by key and optimistic rollback; features never import it directly (boundary test), only
     `data/resources.ts` hooks. _Cost if wrong:_ the dependency is replaced inside `data/` only.
   - Paging keeps the keyset cursors of `view-routes.ts` (`usePages` moves into `data/`).

5. **SSE invalidation, not pushed state (P5-T02).** One stream per tab: `GET /api/live?project=<key>` (cookie or
   Bearer, tenant fixed at open). Writers call `notifyLive(trx, tenantId, topic, key)` →
   `pg_notify('devrounds_live', '{tenant,project,topic,key}')` inside the writing transaction, so the event fires
   only on commit; the payload carries ids only, like `notifyScheduler`. The server holds one `LISTEN` connection and
   fans out to the connections of that tenant. The client maps `topic` to query keys and invalidates; the refetch
   goes through the normal tenant-scoped routes, so RLS stays the only read path. Topics: `plan`, `task`, `run`,
   `job`, `queue`, `machine` (throttled to one per machine per 5 s), `gate`, `conventions`, later `session`,
   `session-turn`, `environment`, `pr`, `flow-run`, `notification`. Heartbeat comment every 15 s; the server
   re-checks the session every 60 s and closes the stream when it is gone; the client reconnects with backoff,
   invalidates every active query on reconnect and polls every 30 s while disconnected. Two exceptions push content:
   run log lines (`GET /runs/:id/logs/live`, SSE fed from `LogChunk`, resumes from the last seq) and the P4 terminal
   PTY stream (WebSocket, owned by P4-T08). When this ships, the "web view polls every 10 s" P0 exception is removed
   from `AGENTS.md`. _Why not a snapshot like cx-env:_ a full snapshot per change does not scale past one machine and
   would need its own tenant filter; invalidation reuses the routes. _Cost if wrong:_ a topic that refetches too much
   is narrowed by adding a key; pushing payloads later is additive.

6. **The web view writes, guarded against cross-site requests.** Parity needs writes from the page (rename, reorder,
   preserve, send an instruction, stop a run, approve a convention). Proposal: a cookie request may mutate when it
   carries `x-devrounds-action: <name>` (a custom header, so a cross-site form cannot send it and the server grants
   no CORS), its `Origin`, when present, equals the server's origin, and `Sec-Fetch-Site`, when present, is
   `same-origin`; the session cookie is `SameSite=Lax` (Better Auth default). Otherwise DR402 as today. This is the
   model cx-env runs (`dashboard.ts:1272`). It reverses P1 plan call 13, so it is **Guilherme's call** (§8); nothing
   in stage A1 needs it, so it does not block the foundation. _Cost if wrong:_ a CSRF hole; the guard is one hook
   with its own tests.

7. **Routing: typed hash route table.** `app/routes.ts` declares every route once: pattern, param parser, lazy page,
   nav entry (rail group, phone placement). Hash routes stay (fastify-static serves `/` without an SPA fallback; P6
   can switch to paths). Selection lives in the route (`#/runs/<id>` renders the list with the run in the aside),
   filters in the query part (`#/runs?state=failed`). No router library: ~25 routes and a parser with tests.
   _Cost if wrong:_ swapping to TanStack Router later replaces `routes.ts` and the Shell's link component.

8. **State: server cache, URL, prefs; no global store.** Server data lives only in the query cache. Navigation,
   selection and filters live in the URL. Device-local preferences (theme, aside width, drafts, open folds) in one
   `data/prefs.ts` over localStorage. Member-shared preferences (card order, custom names, sections, board columns)
   in a new `member_prefs` table (tenant, member, project, `key`, `value jsonb`, RLS) behind `GET/PUT /prefs/:key`,
   because cx-env shares order and names across devices. _Cost if wrong:_ prefs are opaque JSON per key, so a shape
   change is local to one feature.

9. **Layout: one breakpoint at 900 px, master-detail everywhere.** ≥ 900 px: left rail, main column, resizable aside
   (320-720 px, default 420, stored per device). < 900 px: bottom nav, the aside becomes a bottom sheet, dialogs
   become sheets, `visualViewport` sets `--vvh` and `--kb` so the composer follows the keyboard. Same split as
   cx-env (`page-v2.html` L1910), so the screenshots are the reference. Desktop details open in the aside or a modal,
   never in a drawer (Guilherme's standing rule).

10. **Dark and light from the first primitive; dark default.** `html[data-theme]` set by an inline script before
    paint from localStorage `devrounds.theme`, else `prefers-color-scheme`; toggle in the header. Every primitive is
    reviewed in both themes. _Cost if wrong:_ none worth noting; skipping it now would mean revisiting every
    primitive later.

11. **Copy in English, inline.** AGENTS.md: identifiers and docs in English; the parent spec defers UI localization.
    No i18n library until a second tenant needs another language (P6). _Cost if wrong:_ string extraction later is
    mechanical.

12. **Tests.** Node `node:test` only (no DOM runner, consistent with `pnpm test`): pure logic (route parsing, topic →
    query keys, optimistic reducers, slash filter ranking, formatters) and meta-tests (boundaries, contract vs
    server routes, every route has a page and a nav entry, no inline `style` with colors). Rendering is checked by
    the P4 `visual` gate (P4-T06) once it exists: one baseline per route × {desktop 1280, phone 390} × {dark,
    light}. Until then each page PR attaches those screenshots. Server side: SSE fan-out, tenant isolation of the
    stream (a second tenant's write never reaches the first tenant's stream) and the write guard get control-plane
    tests. _Cost if wrong:_ a visual regression slips until the visual gate exists.

13. **Bundle budget.** Initial chunk (shell + current route) ≤ 250 KB gzip; `build.ts` fails above it. Flow editor,
    graph and terminal load on demand. Same spirit as the footprint budgets (spec "Visible", P1 exit criterion).

14. **cx-env's interaction details are requirements, not inspiration.** Where cx-env solved a problem (optimistic
    bubbles that settle against server baselines, `optimistic.ts`; Enter vs Ctrl+Enter on touch; drafts per
    session; second-click confirms for destructive actions; Esc closes the topmost layer; folds keep open state
    across refreshes), the DevRounds feature reuses the rule and cites the cx-env source in a comment. The pure
    modules (`optimistic.ts`, `trace-format.ts`, `pr-format.ts`) are ported, with their tests, into `lib/` or the
    feature, minus Clickmax names (AGENTS "never name a vendor in engine code" applies to `lib/`).

## 4. Refactor path for the existing pages

Each step is one PR, keeps every page working and changes no behavior unless stated.

- **R0 Restructure (first, alone).** Create the folders; move pages into `features/*`, `format.ts`/`segments.ts`/
  `conventions.ts` into `lib/`, split `api.ts` into `data/http.ts` + `data/contract.ts` + `data/resources.ts`
  (keeping `useRemote` as a thin adapter, still polling 10 s), `ui.tsx` into `ui/primitives`. Route `if/else` →
  `app/routes.ts`. Add `boundaries.test.ts` and `contract.test.ts`. Verify: `pnpm typecheck`, `pnpm test`,
  `pnpm -F web build`, every route loads.
- **R1 Tokens and primitives.** `style.css` → `tokens.css` + `base.css` + per-primitive CSS; dark theme added. Pages
  keep their markup; only class names change where a primitive replaces markup.
- **R2 Query.** `useRemote` and `usePages` internals move onto TanStack Query with `refetchInterval: 10_000`; pages
  do not change.
- **R3 Shell.** Rail, bottom nav, title row, MasterDetail; runs/jobs/machines/phase use the aside for detail.
- **R4 Page ports**, one PR per feature folder: inline styles out, primitives in, list/detail on MasterDetail.
- **R5 Live.** SSE on; polling becomes the disconnected fallback; P0 exception removed from AGENTS.md.

R1, R2 and R3 touch different folders and run in parallel after R0. R4 per feature runs in parallel after R1-R3.

## 5. Stages and parallelism

**Stage A — now, needs no P4 (P1-P3 data).** Units are independent worktrees once A0 merges.

| Unit | Content                                                                                                                          | After                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| A0   | R0 restructure + boundary and contract meta-tests                                                                                | —                                             |
| A1   | Tokens, primitives, patterns, icons, theme (R1)                                                                                  | A0                                            |
| A2   | Data layer on Query, prefs module, optimistic helpers (R2)                                                                       | A0                                            |
| A3   | Shell, route table, MasterDetail, responsive layout (R3)                                                                         | A0                                            |
| A4   | SSE server (`notifyLive`, `/api/live`, log live tail) + client `live.ts` (P5-T02)                                                | A0 (server part needs nothing)                |
| A5   | Web write guard (call 6), once Guilherme agrees                                                                                  | —                                             |
| A6   | Member prefs table + routes                                                                                                      | —                                             |
| A7   | Port existing pages (R4): planning, balance/history, conventions (+ approve after A5), runs, jobs, queues, machines              | A1-A3                                         |
| A8   | Ops completion: gates list route + page, schedules, batches, indicators/metrics page, findings, run stop/prioritize, queue pause | A1-A3 (writes after A5)                       |
| A9   | Plan board: tasks kanban, task panel (criteria, links, events, runs), transitions by drag                                        | A1-A3, A5, A6                                 |
| A10  | System view: executor reports memory by category and top consumers; header ring strip; admission view                            | A3 (executor report is protocol feature work) |

**Stage B — after the P4 task named.** Each unit waits only for its P4 task, not for P4 to close.

| Unit | Content                                                                                                                                               | Needs                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| B1   | Agent sessions: list, panel, thread, composer, slash list, model picker, attachments, question card, rename, reorder, sections, unstick/close, launch | P4-T08, P4-T03, A5, A6 |
| B2   | Terminal attach (xterm.js, lazy)                                                                                                                      | P4-T08                 |
| B3   | task-to-pr board and board-task modal; triage board                                                                                                   | P4-T10                 |
| B4   | PRs: list, detail, merge box, conflicts                                                                                                               | P4-T11                 |
| B5   | Environments (slots, services, preserve) and worktrees                                                                                                | P4-T12                 |
| B6   | Integrations + vault UI; Linear/issue-tracker screens                                                                                                 | P4-T01, P4-T02         |
| B7   | Browser drawer; artifact gallery; visual baseline approval                                                                                            | P4-T09, P4-T07, P4-T06 |

**Stage C — P5's own engines.** C1 visual flow editor (P5-T03, needs the flow definitions P4-T10 brings) → C2 node
catalog (P5-T04); C3 Slack messaging provider (P5-T05) → notification dock, web push, PR RFR publish, Slack screen;
C4 voice input (after B1); C5 mail and calendar screens (P4-T02 providers), last and the first to cut if time is short.

**Phase edge.** P5 is `blocked_by: P4` as a phase, so every P5 task answers DR304 until P4 closes, and stage A needs
nothing from P4. Proposal (Guilherme's call, spec §15, as P3 §8 did): drop the phase edge and put task edges on the
stage B/C units instead.

## 6. Tracker mapping (not executed)

```sh
# Phase edge -> task edges (Guilherme's call, §8.1)
devrounds phase dep rm P5 --blocked-by P4 --reason "Stage A of P5 needs only P1-P3 data; stage B tasks carry task edges on P4"
# No replacement phase edge: P3's open task is Clickmax stage 2, and a P3 edge would hold stage A for nothing.

devrounds phase edit P5 --reason "P5 design 28/11: parity with the cx-env panel on a layered web app" \
  --goal "The web UI covers everything the cx-env panel does, live over SSE, on a layered app, and edits visual flows."
devrounds criterion add P5 --text "Every row of the P5 parity table (spec 2026-11-28-p5-interface-design.md §2) exists in DevRounds or is dropped by a recorded decision"
devrounds criterion add P5 --text "web/src import layers and the API contract are checked by meta-tests"

devrounds task edit P5-T01 --reason "P5 design 28/11" --description "Parity acceptance: closes when every parity row is exists or dropped. Umbrella over P5-T06..P5-T24."
devrounds criterion add P5-T01 --text "Guilherme runs a full working day on DevRounds without opening the cx-env panel"
devrounds task edit P5-T02 --reason "P5 design 28/11" --description "notifyLive + /api/live invalidation stream, log live tail, client live.ts with polling fallback (§3 call 5)."
devrounds criterion add P5-T02 --text "A write by one tenant never reaches another tenant's stream (control-plane test)"
devrounds criterion add P5-T02 --text "The P0 polling exception is removed from AGENTS.md"

# Stage A
devrounds task add P5-T06 --phase P5 --title "Web restructure into app/ui/data/features/lib" \
  --criterion "boundaries.test.ts and contract.test.ts pass; every existing page still loads"
devrounds task add P5-T07 --phase P5 --title "Design tokens, primitives and patterns, dark and light" --blocked-by P5-T06 \
  --criterion "Every primitive renders in both themes; no color outside tokens.css"
devrounds task add P5-T08 --phase P5 --title "Data layer on TanStack Query with typed contract and prefs" --blocked-by P5-T06 \
  --criterion "Features import no query library and no server type directly (boundary test)"
devrounds task add P5-T09 --phase P5 --title "App shell, route table and responsive master-detail" --blocked-by P5-T06 \
  --criterion "Every route works at 1280 and 390 px wide; details open in the aside or a bottom sheet"
devrounds task add P5-T10 --phase P5 --title "Web writes by session with a cross-site guard" \
  --criterion "A cookie write without x-devrounds-action or with a foreign Origin answers DR402 (test)"
devrounds task add P5-T11 --phase P5 --title "Member preferences API" \
  --criterion "Order and names saved on one device show on another"
devrounds task add P5-T12 --phase P5 --title "Port existing pages onto the new structure" \
  --blocked-by P5-T07 --blocked-by P5-T08 --blocked-by P5-T09 \
  --criterion "No inline style with colors or spacing in features/"
devrounds task add P5-T13 --phase P5 --title "Ops pages: gates list, schedules, batches, metrics, findings, run and queue actions" \
  --blocked-by P5-T12 --blocked-by P5-T10
devrounds task add P5-T14 --phase P5 --title "Plan board: tasks kanban and task panel" \
  --blocked-by P5-T12 --blocked-by P5-T10 --blocked-by P5-T11
devrounds task add P5-T15 --phase P5 --title "System view: memory by category, consumers, admission" --blocked-by P5-T09 \
  --criterion "Memory by category from the executor report matches Task Manager within 10 %"
devrounds dep add P5-T02 --blocked-by P5-T08 --reason "The client half invalidates query keys"

# Stage B (task edges on P4)
devrounds task add P5-T16 --phase P5 --title "Agent sessions screen with composer, slash list and model picker" \
  --blocked-by P4-T08 --blocked-by P4-T03 --blocked-by P5-T10 --blocked-by P5-T11 --blocked-by P5-T12
devrounds task add P5-T17 --phase P5 --title "Terminal attach with xterm.js" --blocked-by P4-T08 --blocked-by P5-T09
devrounds task add P5-T18 --phase P5 --title "task-to-pr board, board-task modal and triage board" --blocked-by P4-T10 --blocked-by P5-T14
devrounds task add P5-T19 --phase P5 --title "Pull requests view" --blocked-by P4-T11 --blocked-by P5-T12
devrounds task add P5-T20 --phase P5 --title "Environments and worktrees view" --blocked-by P4-T12 --blocked-by P5-T10
devrounds task add P5-T21 --phase P5 --title "Integrations, vault and issue-tracker screens" --blocked-by P4-T02 --blocked-by P5-T12
devrounds task add P5-T22 --phase P5 --title "Browser drawer, artifact gallery and visual baseline approval" \
  --blocked-by P4-T09 --blocked-by P4-T07 --blocked-by P5-T12

# Stage C
devrounds dep add P5-T03 --blocked-by P4-T10 --reason "Flow definitions come with task-to-pr"
devrounds dep add P5-T03 --blocked-by P5-T09 --reason "Editor mounts in the shell"
devrounds task add P5-T23 --phase P5 --title "Notifications: dock, web push, Slack screen and PR publish" --blocked-by P5-T05 --blocked-by P5-T12
devrounds task add P5-T24 --phase P5 --title "Voice input in the composer" --blocked-by P5-T16
devrounds task add P5-T25 --phase P5 --title "Mail and calendar screens" --blocked-by P4-T02 --blocked-by P5-T23

# Umbrella edges
for t in P5-T12 P5-T13 P5-T14 P5-T15 P5-T16 P5-T17 P5-T18 P5-T19 P5-T20 P5-T21 P5-T22 P5-T23 P5-T24 P5-T25; do
  devrounds dep add P5-T01 --blocked-by $t --reason "Parity acceptance"
done
```

## 7. Left to the builder

Exact token values (start from the cx-env screenshots), primitive APIs, which Lucide icons, the SSE topic list beyond
§3 call 5, virtualization of long lists, chart rendering for metrics (follow the dataviz palette rules), task order
inside stage A after A0, how `member_prefs` keys are named.

## 8. Decisions taken 28/11

Guilherme asked for the full cx-env visual layer and for every task that does not wait on design to move now; under
the DevRounds rule (decide, record, implement) these were settled on that basis. Each one is reversible as noted.

1. **Stage A starts before P4 closes.** The phase edge is replaced by task edges (§6, first command); A0-A10 need none
   of P4. Reverting = `phase dep add P5 --blocked-by P4`.
2. **Web writes by session cookie (call 6), with the cross-site guard of P5-T10.** This reverses P1 plan call 13.
   Without it rows 11, 12, 15, 16, 21, 25, 30, 35, 37, 45, 47 cannot reach parity, and the alternative, a per-browser
   API token, is what P1 removed on purpose. The guard (`x-devrounds-action` header plus an Origin check, DR402) is
   the condition: no cookie write ships without its test.
3. **Hub apps (rows 52, 53) stay in scope** as the last unit (P5-T25 and part of P5-T23), since the ask was
   everything. Dropping them is one `task cancel`.
