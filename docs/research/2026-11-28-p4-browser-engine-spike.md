# P4-T04 browser engine spike (28/11/2026)

Question: which browser engine and process model should DevRounds use for agent browsing (today the cx-env hub's
`browser_*`), E2E against local lanes (today a Playwright MCP per `browser` agent) and screenshots/visual diffs (today
`cx-prints`)? Feeds P4-T05 (browser/playwright provider), P4-T06 (visual gate), P4-T07 (gallery) and P4-T09 (pool).
Measured on Guilherme's machine (Windows 11, Kaspersky). Nothing was logged in, no real profile was touched; scripts and
raw JSON are in `.superpowers/research/browser-spike/` (gitignored), profiles were deleted afterwards.

## What cx-env does today

- `src/hub/integrations/browser.ts` + `playwright-driver.ts`: `playwright-core` 1.64 drives the installed Chrome
  (`channel: 'chrome'`, headed, no download). One ephemeral Chrome for all agent MCP sessions, one isolated context per
  session (cap 4), started on the first call and closed after 10 min idle.
- Logins: the panel drawer runs a second Chrome with `launchPersistentContext` on `~/.cx-env/browser/profiles/panel`
  (dedicated dir, link/junction refused, ACL to the user, session cookies promoted to 30 days). Agents never see that
  profile; a human shares one origin at a time (`shared-logins.ts`, 30-day expiry) and the agent context gets only that
  origin's cookies/localStorage as `storageState`. Passwords live in a DPAPI vault.
- Cost (README, measured headed): +480 MB ephemeral Chrome, +460 MB persistent, both ~960 MB. The hub Node process
  itself was 89 MB private today with no Chrome open.
- E2E: the `browser` agent spawns `playwright run-test-mcp-server` only while it runs. Old Playwright MCP default
  profiles under `%LOCALAPPDATA%\ms-playwright\mcp-chrome-*` are left behind (one is 831 MB).

## Candidates

| Candidate                                                     | Notes                                                                                                 | License                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Playwright + `chrome-headless-shell` (rev 1254, Chromium 158) | Separate headless-only binary, 287 MB on disk                                                         | Apache-2.0 (Playwright), Chromium BSD + third party      |
| Playwright + full Chromium (rev 1254) headless                | Chrome for Testing build, 451 MB                                                                      | same                                                     |
| Playwright + system Chrome 158 / Edge 158 headless            | Nothing to download; version moves with auto-update                                                   | proprietary EULA, used as installed, never redistributed |
| System Chrome spawned by us + `connectOverCDP`                | What a Rust executor would do without Playwright launching                                            | as above                                                 |
| Playwright MCP 0.0.83 (`@playwright/mcp`)                     | Node MCP server per client, own browser                                                               | Apache-2.0                                               |
| Not measured: Chrome DevTools MCP                             | Puppeteer-based, one server per client like Playwright MCP                                            | Apache-2.0                                               |
| Not measured: Vercel `agent-browser`                          | Rust CLI + Rust daemon speaking CDP, accessibility snapshots with refs, Chrome for Testing by default | Apache-2.0                                               |
| Not measured: Stagehand / Browser Use                         | Agent frameworks on top of Playwright/CDP, not engines                                                | MIT                                                      |
| Not measured: Steel                                           | Hosted/self-hosted browser API (Docker); a future `browser/hosted` provider                           | Apache-2.0                                               |
| Rejected: Lightpanda                                          | AGPL-3.0-only; no official Windows build (WSL2 or a community port)                                   | AGPL                                                     |

## Measurements

Method: `scripts/measure.mjs` per candidate, Playwright 1.64.1 in-process in Node 24. Cold start = 3 launches, each on
a fresh user-data-dir, to the first `about:blank` page ready. Memory = sum over the browser process tree of private
bytes (`PrivatePageCount`, commit) and working set, sampled 3 s after load, Node driver and the measuring PowerShell
excluded. Local page = a 2,000-node static file; real site = 5 different Wikipedia articles. "5 contexts" = one
`launch()` with 5 `newContext()`, one real tab each (one context per agent/job). Viewport 1280x800. Single run per
candidate, so treat differences under ~10 % as noise.

| Candidate                      | Cold start ms (3 runs) | Idle, 1 blank tab | 1 local tab | 5 local tabs | 1 real tab | 5 real tabs | Browser, no context | 5 contexts × 1 real tab | Processes (idle / 5 ctx) | Profile dir |
| ------------------------------ | ---------------------- | ----------------- | ----------- | ------------ | ---------- | ----------- | ------------------- | ----------------------- | ------------------------ | ----------- |
| headless shell                 | 268, 215, 238          | **75** / 179      | 92          | 254          | 137        | 507         | **50**              | **494**                 | 4 / 8                    | 13 MB       |
| full Chromium                  | 1607*, 605, 754        | 240 / 430         | 276         | 456          | 465        | 829         | 105                 | 1042                    | 8 / 16                   | 19 MB       |
| system Chrome                  | 514, 328, 441          | 242 / 432         | 276         | 474          | 477        | 836         | 107                 | 1009                    | 8 / 16                   | 22 MB       |
| system Edge                    | 819, 363, 413          | 247 / 430         | 282         | 456          | 455        | 780         | 128                 | 910                     | 9 / 12                   | 21 MB       |
| Chrome, raw spawn + CDP attach | 438, 498, 748          | 341 / 636         | 398         | 544          | 471        | 837         | —                   | —                       | 14 (4 `updater.exe`)     | 86 MB       |

MB private bytes; "idle" also shows working set. *First exec of that binary on this machine; the headless shell's first
exec (an earlier run) was 1,292 ms. Both look like an on-access AV scan of a new executable.

Other numbers:

- Per extra real tab ≈ 90 MB on every engine. Per extra context: ~90 MB on the headless shell, ~180 MB on full
  Chrome/Chromium (more utility/renderer processes per context). `newContext()` takes 5-9 ms everywhere.
- Screenshots (headless shell / Chrome): viewport 71 / 61 ms, full page of a long article 502 / 392 ms.
- Node driver (`playwright-core` in-process): 100-130 MB private, constant.
- Playwright MCP: server ready in 551 ms, 100 MB private before any browser. With system Chrome: first navigate 688 ms,
  tree 467 MB with one real tab. With `--executable-path` headless shell: tree 263 MB (server 113 MB).
- Raw spawn without Playwright's switches: Chrome starts its updater (4 `updater.exe`), downloads components into the
  profile (86 MB vs 22 MB) and runs 14 processes. Whoever spawns the browser must carry Playwright's default switch set
  (`--disable-background-networking`, `--disable-component-update`, ...).
- Job object (`jobharness`, a 50-line Rust bin over `devrounds-sys-windows`: `Job::create(kill_on_close)` +
  `spawn(no_window)` of the Node script): Chrome's sandboxed children run fine as members of the nested job (19
  members for Chrome, 11 for the shell), no window appeared, peak job commit 738 MB (shell) / 1,258 MB (Chrome) for the
  whole script including Node. `Job::terminate` mid-run left 0 active members and no orphan process.
- Pixel diff of the same viewport (`scripts/diff.mjs`): headless shell vs full Chromium 7.98 % pixels differ (0.14 % by
  more than 16/255, text antialiasing); Chromium vs Chrome 0.04 %; Chrome vs Edge 0.04 %.
- Antivirus: ~30 launches across 4 browser binaries, Playwright MCP and the unsigned harness; Kaspersky blocked
  nothing. The binaries' `ABOUT` says Google (Chrome for Testing builds); the Authenticode check could not run here
  (PowerShell Security module failed to load), so verify signatures in P4-T05 with `sys-windows::trust`.

## Recommendation

1. Engine: Chromium driven by `playwright-core`, one browser revision pinned per DevRounds release. Default binary
   = `chrome-headless-shell` for agents, the pool and screenshots (3x less idle RAM, half the RAM per context, 0.2 s
   start). Full Chrome for Testing of the same revision is the fallback per profile class, for sites that detect the
   shell or need features it lacks; system Chrome only as an explicit `browser/cdp` provider, never the default
   (auto-updates break pinning and visual baselines).
2. Process model: the browser is a long-lived provider unit of the executor (its own Job, `CREATE_NO_WINDOW`), not a
   per-run spawn and not an MCP server per agent session. One Node sidecar holding `playwright-core` serves the browser
   engine API to the machine's hub; it owns the browsers and hands out one context per job. Project E2E suites are
   ordinary runs that launch their own browser through the project's own Playwright version, outside the pool.
3. Logins: persistent profiles only for the human-facing drawer, one per (tenant, user), on a dedicated dir. Agents get
   fresh contexts seeded with per-origin `storageState` taken from the vault under policy, as cx-env's shared logins do
   today. Storage state is portable JSON; a Chrome profile is not (DPAPI-bound cookies) and must never be shared between
   agents.
4. Headless everywhere, including the drawer (CDP screencast works headless); headed only as an opt-in debug mode.
5. Not now: Playwright MCP or Chrome DevTools MCP per session (~100 MB server each plus a browser), raw CDP from Rust,
   Lightpanda. `agent-browser` (Apache-2.0, Rust-native CDP daemon, same snapshot/ref model) is the alternative to
   revisit if the Node sidecar's ~110 MB starts to matter.

Cost if wrong:

- Shell turns out too limited: switching the pool to full Chrome for Testing is a different `executablePath` per
  profile class; RAM roughly doubles (75 → 240 MB idle, ~90 → ~180 MB per context) and visual baselines must be
  re-approved (8 % of pixels differ between the two).
- Node sidecar turns out too heavy or awkward to supervise: the provider is rewritten over CDP in Rust (agent-browser
  or chromiumoxide), about the size of cx-env's `playwright-driver.ts` (343 lines); the engine API, the pool and the
  gallery stay. Loses Playwright's auto-wait, locators and trace viewer, which is why it is not the first choice.
- Sharing one browser process across tenants is a weaker boundary than contexts suggest (one browser process, shared
  caches); hence the pool key below includes the tenant. Being wrong in the other direction costs ~50 MB per extra
  tenant browser.

## What P4-T05 and P4-T09 should build on this

P4-T05 (`browser/playwright` provider):

- Port cx-env's driver interfaces (`PageDriver`/`ContextDriver`/`BrowserDriver`) and the ref-based snapshot; keep the
  panel-write guard and the profile-dir rules (`profile-dir.ts`) as they are.
- Launch the pinned headless shell by `executablePath`; install it at executor setup (`playwright install
  chromium-headless-shell` into a DevRounds-owned path, not the user's `ms-playwright` cache) and GC old revisions.
  This machine holds 6 Chromium + 5 shell revisions today. Prefetch also absorbs the first-exec AV scan (~1.3 s).
- Never spawn a browser without Playwright's default switches; verify the binary's Authenticode signature before
  first use.
- Artifacts per call: screenshot (viewport ~70 ms, full page ~0.5 s), trace and HAR on demand; paths go to P4-T07.
- P4-T06: baselines are keyed by engine revision, binary kind (shell or full), viewport and theme; a revision bump
  is a baseline re-approval event, never silent.

P4-T09 (shared pool):

- One browser per (machine, tenant, binary kind), started on demand, closed after idle (cx-env: 10 min); one context per
  job, closed when the job ends. Admission by RAM with the measured costs: shell base 50 MB + ~90 MB per context with
  a real page (full Chrome: 105 MB + ~180 MB), Node sidecar ~110 MB.
- The sidecar runs as an executor unit in its own Job; killing the unit must kill every browser (verified above), and
  the pool reports members and peak commit from the Job, not by walking process names.
- The drawer's persistent profiles are separate browsers outside the context pool (one user-data-dir per Chrome).
