# DevRounds P2 Stage 2 (Clickmax) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Clickmax `/ship` pre-flight runs its heavy checks as DevRounds gates on Guilherme's machine (prepare,
install, build, build-deps, test-types, knip, vitest), with the same outcomes as cx-env on a replay of 10 recorded
gates, wall time at or under the cx-env baseline + 10 %, no run killed by memory, installs serialized per machine and
a fresh worktree built from the shared caches; then `/ship` uses DevRounds by default with cx-env as fallback, and the
global virtual store red (openapi since 19/11) is fixed by one monorepo PR.

**Architecture:** Nothing Clickmax-specific enters `control-plane/src`. The Clickmax job types and a small gate
helper live beside `ship-preflight.sh` in the monorepo's `.claude/` directory, which is its own local git repository
(no remote; excluded from the monorepo by `.git/info/exclude`, Guilherme's call of 11/08). `ship-preflight.sh` keeps
scope, `classify_red` and the cure (design call 1); only its `queued()` changes: with `CX_DEVROUNDS=1` each queued
check becomes a one-check DevRounds gate on the worktree root, and the helper writes the run's whole log to stdout and
returns the check's exit code, so `run_step`/`run_gate` read the same log and exit as with `cx-gate.sh`. The engine
gains two generic pieces the helper needs (exit code in the gate view, whole-log download) and the P2-T28 executor
fixes. The only GitHub PR is the monorepo's global virtual store fix (P2-T16).

**Tech Stack:** DevRounds as stage 1 (no new dependency). Monorepo side: Git Bash, `jq`, Node 24 (`node:sqlite` for
`pipeline-metrics.db`), the `devrounds` CLI on PATH.

**Spec:** `docs/superpowers/specs/2026-11-23-p2-gates-design.md` (§1 inventory, §2 calls 1, 9-12, §3 cut-over, §4
"Stage 2", §5 replay). Stage 1: `docs/superpowers/plans/2026-11-23-p2-stage-1-engine.md` and its ledger
`.superpowers/sdd/2026-11-23-p2-stage-1-engine/progress.md`. Study: `docs/research/2026-11-17-worktree-start-study.md`.
Paths are given per repository:

- `devrounds/` = `C:\Users\Guilherme\Code\devrounds`
- `monorepo/` = `C:\Users\Guilherme\Code\Clickmax\monorepo` (tracked, GitHub `bilhon-technologies/monorepo`)
- `dotclaude/` = `C:\Users\Guilherme\Code\Clickmax\monorepo\.claude` (local nested repo, no remote, no PR)
- `cx-env/` = `C:\Users\Guilherme\Code\Clickmax\cx-env` (read only in this stage)

## Facts found while planning (24/11)

- `ship-preflight.sh`, `commands/ship.md`, `pipeline/ship/*.md`, `work-setup.sh` and the doctor are in `dotclaude/`
  (last commit `4ca7f2d`), not in the monorepo's tracked tree. Design call 12 ("ships as a monorepo PR through
  `/ship`") cannot apply: those changes are local commits. See Calls 1.
- Routed through `cx-gate.sh` today: `build`, `build-deps`, `test-types`, `knip` (static stage) and `vitest-related`
  (tests stage, `cwd` = the package directory, inside `related_tests`). Inline: `.env` copy, `sdk-specs` (`doctor.sh
  --fix sdk-symlinks`), `sdk-spec-sync` (`doctor.sh --fix sdk-spec-stale`), biome, db-validate, openapi + drift
  classification, route-capabilities, the test DB reset, the cure and the on-red doctor. `work-setup.sh` routes `pnpm
  install` through cx-gate as `work:install`.
- `cx-gate.sh` forwards the caller's whole environment; cx-env's daemon adds `pnpm_config_verify_deps_before_run=false`,
  `pnpm_config_enable_global_virtual_store=true`, `pnpm_config_confirm_modules_purge=false`,
  `SKIP_INSTALL_SIMPLE_GIT_HOOKS=1` (`cx-env/src/headless-pnpm.ts`). `TURBO_CACHE_DIR=C:\Users\Guilherme\.cache\turbo-shared`
  is a user variable. `turbo.json` has `globalEnv: [DOTENV_KEY, CLICKMAX_ENV]` and a `globalPassThroughEnv` list; the
  remote cache (`turbo.clickmax.co`) token is in the main checkout's `.turbo/config.json`.
- `preflight:openapi` still fails on every run since 19/11 (28 fails, 0 ok through 24/11 22:24 UTC):
  `@clickmax/editor3-api#openapi-generate` → `MODULE_NOT_FOUND` raised from
  `@bull-board/api/dist/queueAdapters/bullMQ.js` inside the global virtual store. DEVOPS-568 (#9801) declared the
  type dependencies; this one is a runtime require of a package bull-board does not declare.
- `pipeline-metrics.db`: 802 ship runs; 305 of the 350 since 01/11 carry `head_sha`.
- Live DevRounds: one machine `guilherme-pc` (executor started by hand, P2-T28), queues `default` and `gates`, no
  `clickmax` project yet. P2-T22 (gate e2e) is in progress in `devrounds/` with uncommitted changes to `README.md` and
  `scripts/e2e/executor.e2e.ts`.
- The scheduler's reserve is `defaultReserve(total)` (a tenth, at most 2 GiB); cx-env reserves 6000 MB.
- `GateView.checks[]` has no exit code; `devrounds run logs` pages 16 KB per call.

## Scope

In: Clickmax project and queues on the live install; Clickmax job types (P2-T01); prepare (P2-T15); gate helper and
`queued()` switch behind `CX_DEVROUNDS=1` (new P2-T30); engine exit code + whole-log download (new P2-T29); executor
service and "no machine can take it" (P2-T28); shared store proof (P2-T09); learned-need proof (P2-T08); replay of 10
gates (P2-T04); wall time (P2-T06); default switch with fallback (P2-T05); global virtual store PR (P2-T16); stage
review (new P2-T32).

Out, with where it goes: routing biome, db-validate, openapi and route-capabilities through DevRounds (they stay
inline, as today; later, if indicators ask for it); `work-setup.sh` installs on DevRounds (P4, agent runs own worktree
creation); turning off cx-env's `gates` queue (new P2-T31, 14 days after the switch; P2 criterion 3); a gates page in
the web view (P5); moving `classify_red` into DevRounds (never, design call 1).

## File Structure

```
devrounds/
  control-plane/src/gates/service.ts            checks[].exitCode
  control-plane/src/cli/commands.ts, output.ts  run logs --out <file>; gate wait names a run no machine can take
  control-plane/src/scheduler/*                 (P2-T28) why a queued run is not placed
  executor/crates/executor/src/service*.rs      (P2-T28) service install survives a reboot
  docs/research/2026-11-2x-p2-replay.md         replay table (P2-T04/T06 evidence)
dotclaude/
  devrounds/job-types/clickmax-{prepare,install,build,build-deps,test-types,knip,vitest}.yaml
  devrounds/gate-check.sh                       one-check gate: file, cache key, gate run, log, exit code, fallback
  devrounds/README.md                           setup commands (jobtype set, queue set), fallback rules
  scripts/ship-preflight.sh                     queued() + prepare through gate-check.sh when CX_DEVROUNDS=1
  scripts/devrounds-replay.mjs                  P2-T04 replay driver
  commands/ship.md, pipeline/ship/preflight.md  one line each on CX_DEVROUNDS and the fallback (P2-T05)
monorepo/ (GitHub PR, P2-T16)
  pnpm-workspace.yaml                           packageExtensions for what the global virtual store cannot see
  pnpm-lock.yaml
```

## Global Constraints

- Every stage-1 Global Constraint still holds in `devrounds/`. No "clickmax", "pnpm", "turbo", "devlanes" in
  `control-plane/src` outside tests; Clickmax files live in `dotclaude/devrounds/` and the replay doc.
- Signed commits, English identifiers and messages in `devrounds/` and `dotclaude/`; `dotclaude/` changes are local
  commits (no PR, no push: there is no remote). Monorepo PR text in Portuguese per the monorepo's process.
- No new env var or secret in the monorepo. Job types take secrets only through the `env` allowlist from the machine
  (e.g. `DOTENV_KEY` if set as a user variable); `job_env` carries names and flags only (`CLICKMAX_DB_DATABASE`,
  `DOCTOR_ONLY_ROOT`, `CLICKMAX_SCRIPTS_DIR`).
- Every gate's `cwd` is the worktree top level (`git rev-parse --show-toplevel`), never a package directory, so the
  per-worktree lock means one worktree.
- `cache_key` only on read-only checks (`test-types`, `knip`, `vitest`); never on prepare, install, build,
  build-deps (they leave state in the worktree that later checks read; turbo's own cache already covers them). The key
  is `sha256(normalized cwd, tree hash, job type file bytes, job args, job env)`; the tree hash comes from a copy of
  the worktree's index (`cp index` then `GIT_INDEX_FILE=<copy> git add -A && git write-tree`), so untracked and dirty
  files count and the real index is untouched.
- `CX_DEVROUNDS=1` is the only switch until P2-T05; with it unset, `ship-preflight.sh` behaves byte for byte as
  `4ca7f2d` (cx-gate).
- Fallback to `cx-gate.sh` (spec §3): CLI exit 4 or 6, CLI missing from PATH, a check ended with class `infra`, a
  command whose prefix the helper does not know, or DR308 after `--wait-lock`. Each prints one warning line to stderr.
- Replays and proofs write metrics to a separate `PIPELINE_METRICS_DB` and use tags `DRREPLAY-<n>` / `DRPROOF-<n>`,
  so `pipeline-metrics.db` (the baseline) never sees them; their test databases are dropped afterwards.
- Heavy live work (proofs, replay) runs with no `/ship` in flight and cx-env's `gates` queue idle: the two admission
  ledgers do not see each other.
- Monorepo PR rules (`monorepo/AGENTS.md`): Linear card first, cx-env queue (`cx-env flow run task-to-pr`), `/ship`,
  branch `ganim/<slug>`, worktree under `WorkTree/`, agent and model disclosed in the PR body; internal tooling, so no
  `pages/docs` change.
- Tracker: as stage 1 (`task start` at dispatch, criteria checked with `commit:`/`gate:`/`url:`/`note:` evidence,
  `task done` by the controller). Apply "Tracker mapping" before Task 1.

## Review Focus

1. With `CX_DEVROUNDS` unset, the script is unchanged in behavior (diff review + one `--plan` and one static run on
   a scratch worktree, cx-gate path).
2. A check that fails on DevRounds produces the same `$LOG_DIR/<name>.log` content classes as cx-gate (turbo
   `Failed:` line, `error TS` lines with paths), so `classify_red` gives the same class. Task 5 compares one real red.
3. A cache hit never skips a check whose side effects a later check reads (Global Constraints); a hit is printed as
   such in the log the script keeps.
4. Every fallback path warns once and returns the command's own exit code, never the CLI's.
5. Job type env allowlists: the check sees every variable it read under cx-gate that matters (inventory in Task 2).
6. `classify` rules in job types only add `memory` (and `check_red` by exit code); they never mark a run green.

## Calls made

Each by Claude under Guilherme's standing DevRounds rule; the ones that change the design say so.

1. **`dotclaude/` changes are local commits, not monorepo PRs** (changes design call 12 and §4's "each monorepo change
   is a monorepo PR"). `.claude/` is excluded from the monorepo and is its own repo without a remote by Guilherme's
   decision of 11/08; putting it through `/ship` would need reverting that decision. Each such task gets the SDD
   review instead. Cost if wrong: the scripts move to a tracked path in a later PR. Flag to Guilherme.
2. **The Clickmax job types live in `dotclaude/devrounds/`**, beside the script that generates the gate files (design
   call 9 "written by the repo"). Not in `devrounds/roadmap/fixtures`: that would make DevRounds carry a customer's
   checks and split one change across two repos.
3. **One gate per check, not one gate per stage** (changes call 9's "every other check depends on prepare"). The
   script runs checks one at a time and classifies, cures and retries between them; a stage-wide DAG would skip
   everything behind a red that the script later accepts (windows-false-red, trunk-limit) and would need a second
   gate for the rest. Prepare is its own gate at the start of the static stage; order comes from the script. A
   check with no `depends_on` can be a cache hit under stage 1's DAG rule. Gate keys are `clickmax-<check>`, so gate
   indicators read per check like `preflight:<check>` today.
4. **Cache only on read-only checks, keyed by worktree as well as tree** (narrows call 6). Prepare, install, build
   and build-deps materialize files that later checks read; skipping them in a fresh worktree would turn a cache hit
   into a false red. Worktree in the key also keeps cf-typegen's generated files honest. Cost: no reuse across
   worktrees on the same sha (rare: replays only).
5. **biome, db-validate, openapi and route-capabilities stay inline.** Spec §3 switches `queued()` only; these are
   1-17 s, and openapi's drift handling restores files in the worktree between commands.
6. **`windows-false-red` stays in the script only.** Its rule needs "no `error TS` line from that package"; a job type
   rule is one regex and would mark a real red as `environment` in indicators. Job types add `memory` patterns only
   (`VirtualAlloc failed`, `JavaScript heap out of memory`, `ENOMEM`) (narrows call 1).
7. **The vitest check runs from the worktree root** through `bash -c 'cd "$1" && shift && exec pnpm exec vitest run
   --passWithNoTests "$@"' vitest <pkgdir> <files…>`, so the lock and cache see the worktree, not the package.
8. **The helper maps a known command prefix to a job type** (`pnpm turbo run build` → `clickmax-build` + the rest as
   job args, etc.) and falls back to cx-gate on an unknown prefix, so call sites in `ship-preflight.sh` stay as they
   are and a later edit of one cannot silently run a different command.
9. **Two engine additions, generic:** `exitCode` on each gate check, and `devrounds run logs <id> --out <file>` (the
   whole log to a file, one summary line out, keeping the agent-output cut). The script needs both; parsing paged
   text would cost tens of CLI calls per red build log.
10. **DR308 after the lock wait falls back to cx-gate** (today there is no lock, so this is today's behavior), with a
    warning naming the holder gate.
11. **The replay is A/B, not recorded-vs-DevRounds only** (adds to §5). Agreement is measured against the recorded
    outcome as §5 says, but wall time compares cx-gate and DevRounds on the same sha and the same quiet machine, in
    alternating order, each in a fresh worktree: the recorded baseline ran under a busy fleet and would flatter
    DevRounds. Per-check outcome compares the final verdict (the `-retry` row wins after a cure). openapi is inline
    on both sides and so not part of the comparison.
12. **`need_mb` seeds come from cx-env's learned p90 per key** (`preflight:build`, `preflight:build-deps`, ...), not a
    flat 4000, so the first three runs of a heavy check are not admitted below their real peak.
13. **The reserve stays as it is unless the proof says otherwise.** If the P2-T08 proof shows a `memory` run or free
    memory under 1 GiB at a peak, Task 7 adds a per-machine `reserve_mb` (generic engine setting) and reruns.
14. **P2-T16 does not wait for P2-T09.** The global virtual store is already on for cx-env's agents and gates (cx-env
    `5e35732`); the PR only declares what the store cannot see. `dep rm P2-T16 --blocked-by P2-T09`.
15. **P2-T05 waits for P2-T06 and P2-T28** (adds edges): defaulting to DevRounds with a wall time regression or an
    executor that disappears after a reboot would make every `/ship` pay the fallback path.

---

### Task 1: Clickmax project, queues and tracker (live, controller only)

**Repo:** `devrounds/` (live install), tracker.

- [ ] **Step 1:** Apply "Tracker mapping" below (`task add`, `criterion add`, `dep add/rm`).
- [ ] **Step 2:** `devrounds-admin project add --tenant <tenant> --key clickmax --name "Clickmax monorepo"`;
      `devrounds plan show --project clickmax` answers.
- [ ] **Step 3:** `devrounds queue set gates --project clickmax` (no caps: learned need decides, P2-T08) and
      `devrounds queue set installs --project clickmax --machine-concurrency 1`.
- [ ] **Step 4:** Ledger line with the event ids.

### Task 2: Clickmax job types (P2-T01)

**Repo:** `dotclaude/` (files), `devrounds/` live (`jobtype set`).

**Files:** Create `dotclaude/devrounds/job-types/clickmax-{install,build,build-deps,test-types,knip,vitest}.yaml`,
`dotclaude/devrounds/README.md`. (`clickmax-prepare.yaml` is Task 3.)

**Interfaces:**

- Shared by all: `env` = `PATH, PATHEXT, SystemRoot, ComSpec, USERPROFILE, HOME, APPDATA, LOCALAPPDATA, TEMP, TMP,
  TURBO_CACHE_DIR` plus every `turbo.json` `globalEnv`/`globalPassThroughEnv` name set on the machine (inventory,
  Step 1); `env_set` = `pnpm_config_verify_deps_before_run: "false"`, `pnpm_config_enable_global_virtual_store:
  "true"`, `pnpm_config_confirm_modules_purge: "false"`, `SKIP_INSTALL_SIMPLE_GIT_HOOKS: "1"`; `classify` = memory
  pattern rule first, then `check_red` on exit 1; `timeout_s: 3600` (cx-gate's).
- `clickmax-install`: `pnpm install --reporter=append-only`, `env_set` adds `CI: "true"` (work-setup's frozen
  lockfile), queue `installs`, `retry: { on: [infra, environment], max_attempts: 2 }` (work-setup's one retry),
  `timeout_s: 1800`.
- `clickmax-build`: `pnpm turbo run build`, `args_from_job: true` (the `--filter=` list).
- `clickmax-build-deps`: `pnpm build-deps`.
- `clickmax-test-types`: `pnpm turbo run cf-typegen test-types --only --continue=dependencies-successful`,
  `args_from_job: true` (filters).
- `clickmax-knip`: `pnpm lint-knip`.
- `clickmax-vitest`: Calls 7 command, `args_from_job: true`, `job_env: [CLICKMAX_DB_DATABASE]`, `env_set` adds
  `CMM_APPEND_TEST_ENV: "1"`, `VITEST_MAX_WORKERS: "4"`.
- `need_mb` per heavy type from cx-env's learned p90 (Calls 12); `clickmax-install` 2000 until learned.

- [ ] **Step 1: Env inventory.** On a scratch worktree, print the env cx-gate's child sees (a `cx-gate.sh --key
      inventory -- bash -c env` run) and a DevRounds run of a `--print-env`-like command with the shared allowlist;
      list names present only under cx-gate and decide each (allowlist, `env_set`, or irrelevant) in the README.
      Check the remote turbo cache reaches a worktree (`.turbo/config.json` is per checkout) and record the answer.
- [ ] **Step 2:** Write the files; `devrounds jobtype set <file> --project clickmax` each (live).
- [ ] **Step 3: Smoke (live).** Fresh worktree `WorkTree/dr-smoke` at `origin/trunk`: `devrounds run start
      clickmax-install --project clickmax --cwd <wt> --queue installs`, then build-deps, build with one `--arg
      --filter=@clickmax/slug-utils`, test-types with the same filter, knip, vitest with one libs test file. Each
      `run show --wait` finished; compare each run's duration with the same command under cx-gate.
- [ ] **Step 4:** Commit in `dotclaude/` "DevRounds job types for the pre-flight checks"; check P2-T01 criterion 1
      with `note:` run ids + `dotclaude` sha.

### Task 3: Checkout preparation (P2-T15)

**Repo:** `dotclaude/`, `devrounds/` live. Parallel with Task 2 (disjoint files; explicit staging).

**Files:** Create `dotclaude/devrounds/job-types/clickmax-prepare.yaml`.

**Interfaces:** `program: bash`, `args: [-c, 'exec bash "$CLICKMAX_SCRIPTS_DIR/doctor.sh" --fix sdk-symlinks
sdk-spec-stale']`, `job_env: [CLICKMAX_SCRIPTS_DIR, DOCTOR_ONLY_ROOT]`, shared env/env_set (Task 2), `timeout_s:
600`, no `cache_key`. The `.env` copy stays inline in the script (it reads the main checkout and is milliseconds).

- [ ] **Step 1:** Fresh worktree under `core.symlinks=false` (the machine default) at `origin/trunk`, not installed.
      Before: `sdk/*/openapi.yaml` are path stubs (count them).
- [ ] **Step 2 (live):** run `clickmax-prepare` with `--env CLICKMAX_SCRIPTS_DIR=<dotclaude>/scripts --env
      DOCTOR_ONLY_ROOT=<wt>`; after: every `sdk/*/openapi.yaml` is a real spec (size > 1 KB, parses as YAML).
- [ ] **Step 3 (live):** stdin and prompts: run `clickmax-build-deps` on that worktree before any install; it ends
      (red, missing modules) within a minute instead of waiting on pnpm's install prompt; then install, prepare,
      build-deps green. Record durations.
- [ ] **Step 4:** Commit in `dotclaude/`; check P2-T15 with `note:` run ids.

### Task 4: Exit code and whole-log download (new P2-T29)

**Repo:** `devrounds/`. Starts once P2-T22 is committed (shares `README.md`); before the stage-1 review is fine.

**Files:** Modify `control-plane/src/gates/service.ts` (+ test), `control-plane/src/cli/commands.ts`,
`control-plane/src/cli/output.ts`, `control-plane/src/cli/cli.test.ts`, `README.md`.

**Interfaces:**

- `GateView.checks[].exitCode: number | null` (the latest run's `exit_code`; null for queued, skipped, cached, or a
  run without one). A cached check shows the source run's exit code (0).
- `devrounds run logs <id> --out <file>`: fetches every page through the existing API and writes the log bytes to the
  file (created or replaced), prints `wrote <bytes> bytes to <file>` and `next: devrounds run show <id>`; without
  `--out`, unchanged. DR101 at `--out` when the directory does not exist.

- [ ] **Step 1: Failing tests.** `gate view carries each check's exit code, null for skipped and queued`; `run logs
      --out writes a 3-page log byte for byte and prints one line`.
- [ ] **Step 2:** `pnpm test` → FAIL. **Step 3:** Implement. **Step 4:** `pnpm test`, `rtk proxy pnpm lint`,
      `pnpm typecheck` → PASS; own gate `devrounds gate run roadmap/fixtures/gates/devrounds.yaml --cwd <repo> --wait`.
- [ ] **Step 5:** Commit "Gate checks carry exit codes; run logs writes a whole log to a file"; restart the live CP
      (controller); check P2-T29.

### Task 5: Pre-flight checks through DevRounds behind `CX_DEVROUNDS=1` (new P2-T30)

**Repo:** `dotclaude/`. Needs Tasks 2, 3, 4.

**Files:** Create `dotclaude/devrounds/gate-check.sh`. Modify `dotclaude/scripts/ship-preflight.sh`.

**Interfaces:**

- `gate-check.sh --key <queued key> --cwd <dir> -- <command…>`: maps the key and command prefix to a job type
  (`build` + `pnpm turbo run build` → `clickmax-build`, `build-deps` + `pnpm build-deps`, `test-types` + `pnpm turbo
  run cf-typegen test-types`, `knip` + `pnpm lint-knip`, `vitest-related` + `pnpm exec vitest run`, `prepare`), takes
  the rest as job args (dropping the fixed flags the job type already has), writes
  `$GIT_DIR/ship-preflight/devrounds/<key>.gate.yaml` (key `clickmax-<key>`, one check, `cache_key` per Global
  Constraints for read-only types), runs `devrounds gate run <file> --project clickmax --cwd <toplevel> --head-sha
  <HEAD> [--dirty] --wait --json`, then `devrounds run logs <runId> --out <tmp>` and prints a header line
  (`devrounds gate <id> check <key> run <runId>[ cached from <id>]`) followed by the log to stdout. Exit: the check's
  `exitCode`; `124` for class `timeout`; fallback (Global Constraints) = run `cx-gate.sh` with the original
  arguments and return its code.
- `ship-preflight.sh`: `queued()` calls `gate-check.sh` when `CX_DEVROUNDS=1`, else today's body. The `sdk-specs` and
  `sdk-spec-sync` steps become one `run_step prepare queued prepare bash "$SCRIPTS_DIR/doctor.sh" --fix sdk-symlinks
  sdk-spec-stale` under `CX_DEVROUNDS=1` (same warn-not-fail handling); unchanged otherwise. `related_tests` passes
  `CLICKMAX_DB_DATABASE` through (the helper forwards it as `--env`).

- [ ] **Step 1:** `--plan` and a full `--stage all` with `CX_DEVROUNDS` unset on a scratch worktree: same summary
      lines as before the change (Review Focus 1).
- [ ] **Step 2 (live):** same worktree with `CX_DEVROUNDS=1`: green; `devrounds indicators --gates --project
      clickmax` lists the `clickmax-*` gates; a second run on the same tree shows `test-types`, `knip`, `vitest` cached.
- [ ] **Step 3 (live):** a deliberate red (type error in a touched file): `classify_red` says `real` on both paths,
      and the two logs carry the same `Failed:` line. Stop the executor and run once more: one warning, cx-gate
      fallback, same outcome.
- [ ] **Step 4:** Commit in `dotclaude/` "ship-preflight runs its queued checks as DevRounds gates (CX_DEVROUNDS=1)";
      check P2-T30 and P2-T01 criterion 2.

### Task 6: Shared store and build cache proof (P2-T09)

**Repo:** `devrounds/` live, scratch worktrees. Needs Task 2 (Task 5 not needed).

- [ ] **Step 1:** Warm base: a worktree at `origin/trunk`, installed and `build-deps` once through DevRounds (seeds
      `TURBO_CACHE_DIR`). Store: confirm one pnpm store path for every worktree (`pnpm store path` in two).
- [ ] **Step 2:** Fresh worktree at the same sha: gate `install → build-deps` with `TURBO_CACHE=local:rw` set for
      the proof (remote cache off, so the hit is the shared local cache). Criterion 1: turbo prints `N cached, N
      total` with N the full task count (170 in the study; record today's number).
- [ ] **Step 3:** Three more fresh worktrees: submit three install runs at once on `installs`. Criterion 2: run
      intervals do not overlap (`run list --job-type clickmax-install`), each install ≤ 60 s with the virtual
      store, total ≪ 550 s.
- [ ] **Step 4:** Keep the four worktrees for Task 7; check both P2-T09 criteria with `note:` run ids.

### Task 7: Learned needs proof (P2-T08)

**Repo:** `devrounds/` live; engine change only if Calls 13 triggers. Needs Task 6 and ≥ 3 `clickmax-build-deps`
samples (Tasks 2, 6 give them).

- [ ] **Step 1:** Quiet machine (no `/ship`, cx-env `gates` idle, Claude sessions as usual). Edit one line in
      `libs/slug-utils/src/index.ts` in each of the four worktrees (the study's round of 4).
- [ ] **Step 2:** Submit four `clickmax-build-deps` gates at once. Record from `#/machines` and `run list`: which
      runs were offered when, the need used (learned, not `need_mb`), free memory at each offer, peaks.
- [ ] **Step 3:** Criterion: no run of class `memory`, no `VirtualAlloc failed` in any log, at least one run held by
      memory while another ran (if all four fit, rerun with a fifth gate or with a second heavy job type in flight to
      show the hold). If memory failed: Calls 13 (`reserve_mb` per machine, migration + `machine set`, generic),
      then repeat.
- [ ] **Step 4:** Check P2-T08 with `note:`; remove the four worktrees.

### Task 8: Replay of 10 gates and wall time (P2-T04, P2-T06)

**Repo:** `dotclaude/` (script), `devrounds/` (result doc). Needs Tasks 3, 5 (and Task 7's quiet-machine rule).

**Files:** Create `dotclaude/scripts/devrounds-replay.mjs`, `devrounds/docs/research/2026-11-2x-p2-replay.md`.

**Interfaces:** `node devrounds-replay.mjs --count 10 [--from <run id>] --out <md>`: picks the last ship runs whose
`head_sha` object exists locally (`git cat-file -e`) and that reached at least `preflight:build-deps`; for each sha and
side (`cx-gate`, `devrounds`; order alternates per sha) creates `WorkTree/drreplay-<n>-<side>` at the sha, installs
(through DevRounds `installs` on both sides, so installs never overlap and do not count), runs `ship-preflight.sh
--tag DRREPLAY-<n> --stage static` then `--stage tests` with `PIPELINE_METRICS_DB=<replay db>` and `CX_DEVROUNDS`
0/1, reads per-check outcome and stage wall time, removes the worktree and drops `clickmax_v2_test_drreplay_<n>`.
Output: a table per sha (check × recorded / cx-gate / DevRounds outcome, classes, wall per stage), the agreement
verdict (every routed check same outcome except `windows-false-red`/`unknown` on either side, listed) and the median
wall per side.

- [ ] **Step 1:** Write the script; dry run with `--count 1`.
- [ ] **Step 2 (live, elapsed ~5 h):** run it as a DevRounds job on `default` (job type `clickmax-replay`, `timeout_s:
      28800`) or detached; read the table.
- [ ] **Step 3:** Disagreements: each explained (machine state at record time, stale artifact, a real difference)
      in the doc; a real difference is fixed and its sha replayed.
- [ ] **Step 4:** Commit the doc in `devrounds/`; check P2-T04 (`commit:`) and P2-T06 (`commit:`, DevRounds median
      ≤ cx-gate median × 1.10).

### Task 9: Executor service and silent waits (P2-T28)

**Repo:** `devrounds/`; Step 1 needs Guilherme (admin or reboot).

- [ ] **Step 1 (Guilherme):** delete the orphan `TaskCache\Tree\DevRoundsExecutor` key as admin (or reboot), then
      `devrounds-executor service install`; reboot once; the executor reconnects with no shell open (criterion 1).
      Kaspersky: the app stays "trusted, do not monitor activity" (ledger 24/11).
- [ ] **Step 2:** If install still fails, make `service install` tolerate the orphan key (diagnose
      `Get-ScheduledTask` enumeration vs `schtasks /Query /TN`), with a test; else record that no code change was needed.
- [ ] **Step 3:** Criterion 2: `run show --wait` and `gate run|show --wait` print, while a run stays queued with no
      live machine able to take it, one line naming why (no machine connected / machine pinned is offline / need
      above free memory), refreshed at most every 30 s. Failing tests first (`cli.test.ts`, scheduler unit), then
      implement, own gate, commit "Waits say why a run is not placed"; CP + executor reinstall (controller).

### Task 10: Default switch with fallback (P2-T05)

**Repo:** `dotclaude/`. Needs P2-T04, P2-T06, P2-T28.

- [ ] **Step 1:** `ship-preflight.sh`: `CX_DEVROUNDS` defaults to 1; `CX_DEVROUNDS=0` keeps cx-gate. `ship.md` and
      `pipeline/ship/preflight.md`: one line each (DevRounds runs the queued checks; fallback rules; how to opt out).
- [ ] **Step 2 (live):** the next three real `/ship` runs: their `clickmax-*` gates in `indicators --gates`, fallback
      warnings counted (expected 0).
- [ ] **Step 3:** Commit in `dotclaude/` "ship pre-flight defaults to DevRounds gates"; check P2-T05; start the 14
      day clock of P2-T31 (`note:` date).

### Task 11: Global virtual store PR (P2-T16, monorepo)

**Repo:** `monorepo/` through its own process (Linear card → cx-env queue → `/work` → `/ship` → PR). Independent of
every task above.

**Card (controller writes it; not written by this plan):** team DEVOPS (as DEVOPS-568), a DEVOPS project, assignee
Guilherme. Problem: under `enableGlobalVirtualStore`, `@clickmax/editor3-api#openapi-generate` fails with
`MODULE_NOT_FOUND` thrown from `@bull-board/api/dist/queueAdapters/bullMQ.js` (every `/ship` openapi step red since
19/11). Fix: declare what the virtual store cannot see (`packageExtensions` in `pnpm-workspace.yaml`, as DEVOPS-568
did for types), then sweep on a fresh worktree with the virtual store on: `pnpm install`, `pnpm build`, `pnpm
openapi-generate`, `pnpm test-types` green, and install ≤ 50 s. Repo default stays off (devs, CI, Docker keep the
normal layout).

- [ ] **Step 1 (controller):** card + `cx-env flow run task-to-pr <TAG>`.
- [ ] **Step 2:** PR merged; check P2-T16 with `url:` of the PR, plus the install time in a `note:`.

### Task 12: Stage review (new P2-T32)

- [ ] **Step 1:** Whole-stage review (opus): `devrounds/` range of Tasks 4 and 9, `dotclaude/` range of Tasks 2, 3,
      5, 8, 10, the replay doc, the ledger's parked lines.
- [ ] **Step 2:** One fix wave for Critical/Important; scoped re-review until clean; check P2-T32.

---

## PR decomposition (monorepo)

One GitHub PR: Task 11 (P2-T16), a single concern (dependency declarations for the global virtual store), not
stacked, no dependency on DevRounds work and nothing in DevRounds waits for it (openapi runs inline on both replay
sides). If the sweep finds declarations in many packages, they stay in this one PR: they share one cause and one
verification.

Everything else that touches the Clickmax checkout is in `dotclaude/` (Calls 1) and ships as local commits in this
order: Task 2 → Task 3 (parallel, disjoint files) → Task 5 → Task 8 script → Task 10. No cx-env change in this stage;
P2-T31 (switch cx-env's `gates` queue off) is a cx-env commit later.

## Order and parallelism

```
Task 1 (setup, minutes) ──┬── Task 2 job types ──┬── Task 6 store proof ── Task 7 need proof ──┐
                          ├── Task 3 prepare ────┤                                              │
P2-T22 commit ── Task 4 ──┴──────────────────────┴── Task 5 CX_DEVROUNDS=1 ── Task 8 replay ────┴── Task 10 switch ── Task 12
Task 9 step 1 (Guilherme) ── Task 9 steps 2-3 (devrounds, after Task 4) ─────────────────────────┘
Task 11 (monorepo PR, own process) ── independent
```

`devrounds/` engine tasks run one at a time (stage-1 Ruling 5-6): P2-T22 → Task 4 → Task 9 code; P2-T23 (stage-1
review) can slot in anywhere on that line. `dotclaude/` tasks can run beside engine tasks (different repos). Live
proofs (Tasks 6, 7, 8) run one at a time on the machine, never beside a `/ship`.

Parallel start today: Task 1; Task 2; Task 3; Task 11 Step 1; Task 9 Step 1 (needs Guilherme); Task 4 as soon as
P2-T22 is committed.

## What can finish today vs needs elapsed time

Today (24/11 evening, local): Task 1 (minutes); Task 2 and Task 3 (authoring + smoke, ~1-2 h each, in parallel);
Task 11 Step 1 (card + queue); Task 4 (~1-2 h after P2-T22); Task 6 (~1 h once Task 2 lands). Task 5 is possible late
today if Task 4 lands; then Task 8 can start overnight.

Needs elapsed time:

- Task 8 replay: 10 shas × 2 sides × ~14 min (install + static ~7 min + tests ~6 min) ≈ 5 h of machine time on a
  quiet machine → overnight 24-25/11, read 25/11.
- Task 7: needs three learned samples of `clickmax-build-deps` (Tasks 2, 6, or the replay) and a quiet window
  (~30 min) → 25/11.
- Task 9 Step 1: Guilherme's admin action or a reboot; the reboot test itself needs a reboot.
- Task 11: CI, Kody, review and merge of a monorepo PR → 1-2 days.
- Task 10 Step 2: three real `/ship` runs after the switch → a day of normal work.
- P2-T31: 14 days after the switch without a fallback (≈ 10/12 if the switch lands 26/11); not part of this stage's
  done, but it is P2 criterion 3.

## Risks

- `dotclaude/` has no remote: the job types, the helper and the replay script live on one disk. Mitigation: this plan
  and the replay doc in `devrounds/` describe them; Guilherme decides whether `.claude/` gets a backup remote.
- Env differences: cx-gate forwards the whole session env, a job type passes an allowlist. A missing name gives a
  false red or a slower build (no remote turbo cache). Task 2 Step 1 inventories it; Task 8 agreement is the check.
- Executor availability (P2-T28): it runs by hand today and dies with the shell; queued gates wait silently. Until
  Task 9, live proofs are watched by the controller and the switch waits for it.
- Kaspersky HIPS flagged the executor binary (behavior verdict, 24/11). If it inspects processes spawned by the
  executor more than those of cx-env's node daemon, builds slow down and Task 8's wall time shows it.
- Two admission ledgers during migration: cx-env and DevRounds each read free memory and ignore the other's
  reservations. Proofs and the replay run with cx-env's `gates` idle; after the switch only fallbacks use cx-env.
- Reserve 2 GiB vs cx-env's 6000 MB: memory taken by Claude sessions after an admission is not reserved for. Task 7
  measures it (Calls 13).
- The study saw cache misses when two worktrees built the same task at once (round of 2); the replay is serial, the
  learned-need proof is not and may show it in duration, not in outcome.
- Replay realism: recorded reds from stale artifacts or a busy fleet will not reproduce on a fresh worktree; they are
  listed, not counted against agreement, when classified `windows-false-red`/`unknown`, and explained otherwise.
  Old shas may be gone from the object store; the script skips them and goes further back.
- A headless `/ship` session may not have `devrounds` on PATH; the helper treats it as unreachable (fallback, warn).

## Not settled here

- Whether `.claude/` gets a remote or the pre-flight moves into the tracked tree (Calls 1, Guilherme).
- Whether the installs of `work-setup.sh` move to DevRounds before P4.
- How long the replay's private test databases may live if a replay stops halfway (the script drops them at the end;
  a crash leaves them for the next run to drop).

---

## Tracker mapping

Apply before Task 1 (controller). P2-T01, T04, T05, T06 have no criteria today.

| Plan task | Key                                                                 | Action                                                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2, 5      | P2-T01 Gate job types mirroring the /ship pre-flight                | Criteria: (1) the clickmax job types (prepare, install, build, build-deps, test-types, knip, vitest) are set on project clickmax and each ran green on trunk; (2) with CX_DEVROUNDS=1 ship-preflight runs every queued check as a DevRounds gate with the same log and exit code as cx-gate. Add blocked_by P2-T29 (criterion 2 needs it) |
| 3         | P2-T15 Checkout preparation                                         | Keep criterion; keep blocked_by P2-T01 → change to none (prepare does not need the other job types)                                                                                                                                                                                                                                       |
| 4         | P2-T29 (new) Gate exit codes and whole-log download                 | Add; criterion: gate view carries each check's exit code and run logs --out writes the whole log                                                                                                                                                                                                                                          |
| 5         | P2-T30 (new) ship-preflight through DevRounds behind CX_DEVROUNDS=1 | Add, blocked_by P2-T01, P2-T15, P2-T29; criterion: unset = unchanged; set = green run, cache hits on a second run, same classify_red on a real red, fallback on an unreachable CP                                                                                                                                                         |
| 6         | P2-T09 Shared package store and build cache                         | Keep criteria; blocked_by P2-T01 stays                                                                                                                                                                                                                                                                                                    |
| 7         | P2-T08 Learned needs for heavy checks                               | Keep criterion; add blocked_by P2-T09 (uses its worktrees and samples)                                                                                                                                                                                                                                                                    |
| 8         | P2-T04 Replay comparison of 10 gates                                | Criterion: 10 replayed gates, every routed check the same outcome as recorded except windows-false-red/unknown, listed with explanations in docs/research. Replace blocked_by (P2-T02, P2-T03 done) with P2-T30                                                                                                                           |
| 8         | P2-T06 Wall time at or under baseline +10%                          | Criterion: DevRounds median wall per gate ≤ cx-gate median × 1.10 on the same shas, same machine                                                                                                                                                                                                                                          |
| 9         | P2-T28 Executor service                                             | Keep criteria                                                                                                                                                                                                                                                                                                                             |
| 10        | P2-T05 /ship switch and fallback                                    | Criterion: ship-preflight defaults to DevRounds and falls back to cx-gate on exit 4/6, infra or an unknown command, with a warning; three real /ship runs used DevRounds. Add blocked_by P2-T06, P2-T28                                                                                                                                   |
| 11        | P2-T16 pnpm global virtual store for Clickmax                       | Keep criterion; dep rm --blocked-by P2-T09 (Calls 14)                                                                                                                                                                                                                                                                                     |
| —         | P2-T31 (new) cx-env gates queue switched off                        | Add, blocked_by P2-T05; criterion: 14 days of /ship on DevRounds with no fallback, then cx-env's gates queue removed                                                                                                                                                                                                                      |
| 12        | P2-T32 (new) Stage 2 review                                         | Add, blocked_by P2-T01, T04, T05, T06, T08, T09, T15, T28, T29, T30; criterion: no open Critical or Important finding                                                                                                                                                                                                                     |
