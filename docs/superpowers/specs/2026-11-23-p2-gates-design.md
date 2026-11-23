# DevRounds P2 Gates on DevRounds — design

Status: written 23/11 by Claude; Guilherme reviews after the fact (he asked on 17/11 not to wait for approval). Parent
spec: `C:/Users/Guilherme/Code/Clickmax/cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md` ("the
spec", §5.5, §11.1-§11.3, §11.7-§11.10, §16.4). P1 design: `2026-11-17-p1-foundation-design.md`. This document records
only what P2 settles on top of them.

## 1. What runs today (inventory, 23/11)

The Clickmax pre-PR gate is `monorepo/.claude/scripts/ship-preflight.sh` (796 lines), called by `/ship`. cx-env does
not run the script: its only part is the gate queue (`cx-env/scripts/cx-gate.sh` → daemon queue `gates`, at most 4
at once, RAM admission by p90 of the last 20 peaks, default 4000 MB, reserve 6000 MB, stall kill after 600 s with no
output and no CPU, timeout 3600 s → exit 124). The script routes five gates through it with `queued <key>`: `build`,
`build-deps`, `test-types`, `knip`, `vitest-related`. Everything else (biome, db-validate, openapi, route-capabilities,
the sdk-spec doctors) runs inline in the caller's shell.

The script owns scope (which gates run, from `git diff origin/trunk...HEAD`), red classification (`classify_red`:
real, windows-false-red, trunk-limit, stale-sdk, stale-artifact, unknown) and the one cure + retry for stale
artifacts. Results go to `pipeline-metrics.db` (`runs`/`steps`/`logs`, steps named `preflight:<gate>`): 782 ship runs
since 28/09, red classes real 274, windows-false-red 133, stale-sdk 81, stale-artifact 51, unknown 5. Averages of
green steps: biome 17 s, build 54 s, build-deps 41 s, test-types 54 s, knip 226 s, tests 378 s, cure 798 s.

Baseline caveat: `preflight:openapi` has failed on every run since 19/11 16:28 (`MODULE_NOT_FOUND` of `@bull-board/api`
under the pnpm global virtual store cx-env enabled on 19/11). Those openapi rows are not a correctness baseline; the
replay (§5) uses runs before that point or excludes the openapi check.

## 2. Calls (23/11, Claude)

1. **The script keeps scope, classification and the cure; DevRounds runs the checks.** Moving `classify_red` and the
   cure into DevRounds would put Clickmax-specific rules (package names, TS2590, doctor checks) into the engine, which
   AGENTS.md forbids, and would make the replay compare two different classifiers. A gate is planned by the caller
   (the repo's script computes which checks run and with which arguments) and executed by DevRounds (queue, worktree
   lock, memory admission, supervision, record). The script reads each check's outcome and log tail exactly as it
   reads cx-gate's today. Classification rules that are pure patterns (`windows-false-red` signatures, JS heap OOM →
   `memory`) are also written as job type `classify` rules so DevRounds' own indicators see them.
2. **Jobs carry arguments.** Checks differ per gate (`build` gets `--filter` per touched package, `test-types` the
   touched list, `vitest-related` the files). A job type opts in with `args_from_job: true` (max 200 args, each ≤ 4096
   chars), and the job's `args` are appended to the job type's. No templating.
3. **Jobs carry env values, only for names the job type allows.** `job_env: [CLICKMAX_DB_DATABASE]` lets a job set
   that variable; anything else is DR101. Job types also get `env_set` (constant values, e.g.
   `pnpm_config_verify_deps_before_run: "false"`, `CMM_APPEND_TEST_ENV: "1"`). Values set by a job are stored on the
   job (they are names of test databases and flags, not secrets; secrets stay on the machine through `env`, §11.7).
4. **A gate is an entity.** `gates`: project, machine (resolved at submit: the gate pins every check to one machine,
   since they share a worktree), `cwd`, `head_sha`, `dirty` (both reported by the caller; DevRounds never reads the
   repo in P2), the batch it created, state (`running | passed | failed | cancelled`) and timings. `devrounds gate run
   <file.yaml> --cwd <path> [--wait]` submits the gate's checks as one batch (`depends_on` from P1) and, with `--wait`,
   blocks until it ends and prints failures first: per check state, class, duration, summary, log command.
5. **Per-worktree lock.** At most one gate in `running` per (project, machine, normalized cwd): a unique partial index.
   A second submit for the same worktree waits for the first by default (`--wait-lock <s>`, default 900, then DR3xx
   with the holder gate id); `--no-wait-lock` refuses at once. Normalized cwd = lowercase drive letter, backslashes,
   no trailing separator. The lock is released by the gate's end; a gate whose batch has nothing left to run ends.
6. **Result cache by input hash.** A check may carry `cache_key` (the caller computes it; Clickmax uses the tree hash
   of the worktree — `git stash create` or `write-tree` of the index plus untracked — plus the check's args and env).
   If a `finished` run of the same (project, job type, cache_key) exists within 7 days, the job ends at once as
   `cached`, pointing to that run, and is shown as cached in the gate; it does not count as a run for indicators.
   DevRounds does not compute hashes in P2 (§11.1: it never reads the repo); moving that into the `vcs` engine later
   keeps the same column.
7. **Learned needs for heavy checks.** P1 already admits by learned need (p90 of recent peaks) and the start-gate. P2
   adds `need_mb` on job types as the starting need before three samples exist (Clickmax heavy checks: 4000, as
   cx-env), and proves the criterion with a replay of four concurrent `build-deps` on one machine (§5).
8. **Per-machine concurrency on queues.** `queues.machine_concurrency` caps runs of a queue on one machine (installs:
   1), beside the existing global `concurrency`. Checks the gate submits go to the project's `gates` queue.
9. **Checkout preparation is a job type, written by the repo.** Clickmax's `clickmax-prepare` runs the sdk-symlink and
   sdk-spec doctors with `core.symlinks=false` handling; stdin is already null for every spawn (executor
   `spawn.rs`), and `env_set` carries `pnpm_config_verify_deps_before_run=false`, `pnpm_config_confirm_modules_purge=false`,
   `SKIP_INSTALL_SIMPLE_GIT_HOOKS=1`. The gate file lists it first; every other check depends on it.
10. **Shared store and build cache.** `TURBO_CACHE_DIR` is already a Windows user variable (17/11) and the pnpm store is
    one per machine; P2's job is to pass them (`env: [TURBO_CACHE_DIR, ...]`) and prove the criterion with a fresh
    worktree. `pnpm install` runs as job type `clickmax-install` on queue `installs` (`machine_concurrency: 1`).
11. **The global virtual store (P2-T16) is a Clickmax PR, not DevRounds code.** It is the cause of the openapi red
    since 19/11; it goes through the monorepo's own process (Linear card + cx-env queue + `/ship`), and DevRounds
    tracks it as a task with the PR as evidence.
12. **Agent-facing changes in the monorepo** (`ship-preflight.sh` calling DevRounds, fallback to cx-gate) also ship as
    monorepo PRs through `/ship`, one PR for the switch (P2-T05).
13. **Projects.** `devrounds-admin project add --tenant <id> --key clickmax --name "Clickmax monorepo"` (owner-side,
    like bootstrap), plus `devrounds --project <key>` per command so one login reaches both projects. Machines are
    tenant-scoped already.
14. **Improvement report and devlanes sync run through the executor as ordinary scheduled jobs.** The job runs the
    DevRounds CLI (`devrounds report improvement --open-tasks`, `devrounds devlanes-sync --open-tasks`) with
    `DEVROUNDS_URL`/`DEVROUNDS_TOKEN` passed through `env` from the machine (an agent token for member `claude`, set
    as a user variable). The control plane computes the report (`GET /reports/improvement?day=`); the CLI opens one
    task per finding, deduplicated by a finding key stored in the task (`source_key`, unique per project among open
    tasks).
15. **Plan files carry links and unphased tasks (P2-T12)** as already specified in the task criterion; no design.

## 3. Cut-over (spec §11.3, unchanged) and what "switched off in cx-env" means

`ship-preflight.sh`'s `queued()` calls `devrounds gate`-backed checks when `CX_DEVROUNDS=1` (replay) and by default
after the switch, falling back to `cx-gate.sh` only when the DevRounds CLI exits 4 (unreachable) or 6 (internal), or
the check ended with class `infra`. cx-env's `gates` queue is switched off after two weeks without a fallback.

## 4. Stages

- **Stage 1 — engine (this repo only):** project add + `--project`; job args and env; `need_mb`; per-machine queue cap;
  gates with lock, `gate run --wait`, cache; gate indicators (P2-T10); DevRounds's own gates (P2-T11); plan links and
  unphased tasks (P2-T12); improvement report (P2-T13); devlanes sync job (P2-T14). All testable without Clickmax.
- **Stage 2 — Clickmax:** Clickmax job types and gate file generator in the monorepo, prepare (P2-T15), shared store
  proof (P2-T09), learned-need proof (P2-T08), replay of 10 gates (P2-T04), wall time (P2-T06), switch (P2-T05), global
  virtual store (P2-T16). Each monorepo change is a monorepo PR through its own process.

## 5. Replay (P2-T04, P2-T06)

A script in the monorepo (`.claude/scripts/devrounds-replay.mjs`) reads the last 10 `ship` runs with `head_sha` from
`pipeline-metrics.db` (skipping openapi rows after 19/11 16:28), creates one replay worktree per sha under
`WorkTree/`, runs the static and tests stages through DevRounds one at a time (`CX_DEVROUNDS=1`), and writes a table
of per-check outcome (recorded vs DevRounds) and wall time. Agreement target: every check same outcome, except reds
classified `windows-false-red`/`unknown` on either side, which are listed. Wall time target: DevRounds median ≤
baseline median +10% (spec §11.9).

## 6. Left to the builder

Exact migration shapes, the gate view layout, the finding key format, the report's thresholds (start: a step whose
p50 grew > 20 % and > 10 s, a class whose count doubled, unclassified share > 5 %), task order inside each stage.
