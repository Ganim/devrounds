# DevRounds P1 Stage 1 (Executor, Pairing and Run Record) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rust executor built from copied devlanes crates pairs with the P0 control plane, receives a job through a
direct dispatch, runs it hidden inside its own Job Object behind the memory start-gate, and every run lands in a
tenant-scoped run record (timeline, steps, outcome, failure class, summary, resources, attempts, log segments), within
the P1 footprint budgets.

**Architecture:** `executor/` is a Cargo workspace next to `control-plane/`: copied and renamed devlanes crates
(`devrounds-core`, `-sys-windows`, `-shell-windows`, `-runner-windows`, `-start-gate`, `-metrics`, `-metrics-windows`,
`-logs`) plus new crates (`-protocol`, `-store`, `-executor`) and one binary `devrounds-executor`. The executor dials
out over WebSocket to `/api/executor/connect`; the control plane gains machines/pairing, job types, jobs, runs and log
segments (all tenant-scoped with RLS), a gateway that turns executor events into the run record, and a direct dispatch
(`devrounds run start`) that writes a run and sends `Offer`. The scheduler of the stage-2 re-plan replaces direct
dispatch; nothing else in this plan changes when it lands.

**Tech Stack:** Rust 1.99.1 edition 2024 (tokio, tokio-tungstenite with rustls, serde/serde_json, rusqlite `bundled`,
windows-sys 0.61, zstd, ureq, opentelemetry + opentelemetry-otlp), Node ≥24 TypeScript, Fastify 5 +
`@fastify/websocket`, TypeBox, Kysely/pg, Postgres 17, `smol-toml`, `@opentelemetry/*` (loaded only when enabled),
`node:test`, Biome 2.6.8, cargo clippy/fmt.

**Spec:** `docs/superpowers/specs/2026-11-17-p1-foundation-design.md` (binding, §3.1, §4, §7) and its parent
`C:/Users/Guilherme/Code/Clickmax/cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md` (§5.1-5.4,
§5.7, §6, §7, §8, §11, §13, §14, §16). Paths below are relative to `C:\Users\Guilherme\Code\devrounds`.

## Scope

In: the build-vs-adopt spike (P1-T02), the executor and its copied crates, Job Object supervision, hidden spawn,
start-gate + AIMD, footprint by private bytes, protocol `Hello`/features/seq, machine pairing, executor local store and
outbox, the run record of design §3.1, direct dispatch, log segments, orphans, `isolation/none`, the devlanes-sync
check, the OpenTelemetry exporter (off by default), the executor login service, and the end-to-end proof with the P1
exit criteria.

Out (planned after the spike's recommendation is approved, as a re-plan of P1): queues, scheduler, placement, offer
admission timeout and requeue, control-plane transactional outbox and idempotent executor commands (P1-T13),
`learned_needs` as a table (this plan computes the need on read), Workspace/Checkout tables, Better Auth session login
(P1-T16), the operational view (P1-T15) and indicators (P1-T18) beyond the CLI output the end-to-end proof needs.
Direct dispatch is the smallest path that hands one job to one named machine; the scheduler replaces it.

## File Structure

```
executor/
  Cargo.toml, rust-toolchain.toml, LICENSE (Apache-2.0, from devlanes), NOTICE, devlanes-sync.toml
  crates/core            copied devlanes-core: clock, gate, runtime, stop; new error.rs (DrError)
  crates/sys-windows     copied: console, file, job, proc, security, spawn, system, token, usage, util, window
  crates/shell-windows   copied as is (cmd/MSYS quoting the runner needs)
  crates/runner-windows  copied: command, ctrl, exit, orphan, runtime, spawn, stop, unit (no ConPTY, no ports, no power)
  crates/start-gate      copied; StartRequest {run, job_type, order, memory_need}
  crates/metrics         copied: ring, sketch, run (RunTracker); no lane history
  crates/metrics-windows copied; footprint = private bytes
  crates/logs            copied: framing, level, storage (LogLine moved in); no query/grep
  crates/protocol        new: messages, features, fixtures/*.json shared with the control plane
  crates/store           new: SQLite on a dedicated thread (runs in flight, identities, outbox)
  crates/executor        new: config, pair, connection, admission, isolation, runs, steps, output, sampler,
                         orphans, telemetry, service, supervise
  crates/test-fixtures   new: bin tree-fixture (child trees, output, allocation, Ctrl-C, breakaway attempts)
  bins/devrounds-executor  main.rs: pair | run | supervise | service install|uninstall | version | __console-ctrl
control-plane/src/
  machines/pairing.ts, machines/service.ts      pairing codes, machine tokens, revoke, reports
  executor/protocol.ts, executor/gateway.ts     TypeBox messages, WS endpoint, sessions, seq/ack/resync
  job-types/file.ts, job-types/service.ts       job type YAML + storage
  runs/states.ts, runs/classify.ts, runs/record.ts, runs/view.ts, runs/learned-need.ts, runs/dispatch.ts,
  runs/log-store.ts                             run record, classification, dispatch, segments
  telemetry/otel.ts                             OTLP exporter, dynamic import only when configured
  api/machine-routes.ts, api/run-routes.ts      HTTP routes
  db/migrations/0004_machines.ts, 0005_runs.ts, 0006_log_segments.ts
scripts/devlanes-sync.ts, scripts/footprint.ts, scripts/e2e/executor.e2e.ts
```

## Global Constraints

- Windows 11 only in P1. `core` keeps the OS boundary (`Runner`, `Unit`, `PressureSource`, `Clock`); only Windows
  adapters are built.
- Rust: edition 2024, toolchain `1.99.1` pinned in `executor/rust-toolchain.toml`; workspace lints `unsafe_code =
  "deny"`, `clippy::all = warn`, `clippy::unwrap_used = "deny"`; CI-equivalent `cargo clippy --workspace --all-targets
  -- -D warnings` and `cargo fmt --check`. `unsafe` only inside `crates/sys-windows` FFI modules (accepted exception,
  Task 2).
- Blocking syscalls in the executor only through `tokio::task::spawn_blocking` or the store's dedicated thread.
- devlanes copy: upstream `https://github.com/devlanes-run/devlanes`, commit `e2e4f1cafda94805d6e447331980b83fcbab2e72`,
  Apache-2.0; `executor/LICENSE` + `executor/NOTICE` (origin, commit, changes per crate). Crates renamed
  `devlanes-*` → `devrounds-*`; upstream names of types and functions are kept so ports stay mechanical.
- P0 rules hold for every control-plane change: no sync child-process/`*Sync` fs in `control-plane/src`; tenant data
  only inside `withTenant()`; the server connects as `devrounds_app`; every new table has `tenant_id uuid not null`,
  RLS enabled and forced, the `tenant_isolation` policy, composite FKs `(tenant_id, x_id) → (tenant_id, id)`; security
  definer functions pin `search_path = pg_catalog, public, pg_temp` and grant execute only to the app role; cross-tenant
  lookups answer DR201; Biome `--error-on-warnings`, no inline suppressions; `node --test`.
- Error codes: the `x5x` block of each range belongs to executor, protocol and runs: DR150, DR151, DR350, DR351,
  DR352, DR450, DR451, DR452, DR453, DR550, DR551. Text only in `errors/words.ts`; the executor emits
  `DrError::new("DR###", json)` and prints `DR### <data json>` plus `see docs/errors.md`. Not-found stays DR201
  (`kind`: `machine`, `run`, `job type`).
- Footprint is private bytes (commit) of the whole tree, never working set (spec §16.5).
- Budgets: executor ≤ 50 MB private bytes idle (`supervise` + `run` processes), control plane ≤ 300 MB idle (`supervise`
  - `serve`), checked with 1 MB = 1 000 000 bytes.
- Learned need default 512 MiB (`536870912`, devlanes `DEFAULT_MEMORY_NEED`). Admission never refuses for memory; it
  waits. No per-run memory cap.
- One Job Object per run, assigned at `CreateProcessW`, no breakaway, no kill-on-close, die-on-unhandled-exception.
  Staged stop: `WM_CLOSE` → Ctrl-C / Ctrl-Break → terminate job, 10 s grace. Identity `(pid, start_time, boot_id)`.
- Run output goes to files the run owns (`<run dir>/stdout.raw`, `stderr.raw`), never to pipes held by the executor.
- Sampling: 1 Hz while a run holds its start slot, 5 s otherwise; p50/p95 and exact peak reported at run end.
- Protocol: executor dials out over WebSocket, JSON, `protocol: 1`; `ws://` only to `127.0.0.1`, `::1` or `localhost`,
  `wss://` (rustls, Windows roots) for any other host. First message `Hello`; unknown message types and event kinds are
  decoded and ignored; events carry `seq`; a gap gets one `Resync`.
- Pairing: 8-char single-use code from `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 10 min TTL; machine token `drm_` + 43
  base64url chars (256 bits), stored only as SHA-256; 5 failed redemptions in 10 min lock pairing for 10 min; revoke
  closes the live session.
- Env reaches a run only through the job type allowlist; env values are never stored by the executor, never printed by
  `Debug`, never logged.
- Executor home `DEVROUNDS_EXECUTOR_HOME` or `~/.devrounds/executor`, owner-only (`ensure_private_dir`), singleton lock
  `executor.lock`.
- Log segments on the control plane at `<logsRoot>/runs/<tenant_id>/<run_id>/<first_seq>.zst` (`logsRoot` default
  `~/.devrounds/logs`), indexed in Postgres, pruned after `logRetentionDays` (default 14).
- OpenTelemetry: exporter only, off unless `otlpEndpoint` (control plane) / `otlp_endpoint` (executor) is set; no
  collector runs.
- Never `/tmp`. Rust tests use `tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR"))`; TS tests and scripts use
  `mkdtemp(join(repoRoot, '.superpowers', 'tmp', 'x-'))` (`.superpowers/` is gitignored).
- Commits signed (`git commit -S`), English, no `Co-Authored-By` or AI trailer.
- `AGENTS.md` lines added by Tasks 2 and 10 change invariants; Guilherme approved this plan and them on 17/11 ("tá tudo aprovado").

## Review Focus

1. The control plane restarts while a run is in flight: the run finishes, its events wait in the executor outbox and
   arrive once, in order, after reconnect. Tests in Task 12.
2. A `cmd` wrapper (`pnpm.cmd`) gets arguments with spaces and `&`: the child sees them exactly, still hidden. Test in
   Task 5.
3. `devrounds run stop` while the run waits in the start-gate: nothing spawns, the run ends `stopped`/`cancelled`. Test
   in Task 13.
4. A second executor process connects as the same machine (old one still alive after a restart): the new session
   replaces the old one. Test in Task 10.
5. The executor clock is behind the control plane's: no derived duration is negative and the skew is recorded. Test in
   Task 11.

---

### Task 1: Build-vs-adopt spike (P1-T02)

**Files:**

- Create: `docs/superpowers/specs/2026-11-17-p1-spike-queue-and-auth.md`
- Scratch (gitignored): `.superpowers/spike/<candidate>/`

**Interfaces:**

- Produces: a recommendation (one queue/scheduler option, Better Auth yes/no) that the stage-2 re-plan consumes.

- [ ] **Step 1:** For Hatchet, pg-boss, Graphile Worker, DBOS and "own scheduler on the P0 Postgres", record the
      license (accept MIT/Apache/MPL only; AGPL, SSPL, ELv2, sustainable-use are out), and run each minimal setup against a
      scratch database `devrounds_spike` on port 15433 (Hatchet: its engine binary or container as documented).
- [ ] **Step 2:** Measure idle private bytes of every extra process each option adds after 5 min idle
      (`Get-Process -Id <pid> | Select PrivateMemorySize64`), and of a `node serve` with the library loaded; record the
      numbers against the 300 MB control-plane budget.
- [ ] **Step 3:** Score fit, each with a concrete note: RAM-aware placement (can the scheduler pick a machine by
      reported free memory and learned need?), executor-dials-out (no worker library on the executor side), P0 schema
      (`tenant_id` + forced RLS + composite FKs on its tables, or tables outside our schema), `depends_on` DAG (spec §11.2).
- [ ] **Step 4:** Better Auth: organizations plugin mapped to `tenants`/`members`, session tables under RLS, coexistence
      with P0 API tokens; idle cost when loaded in `serve`.
- [ ] **Step 5:** Write the doc: table per need, measurements, recommendation, what the stage-2 re-plan must cover. The controller
      rules on the recommendation (Guilherme pre-approved, 17/11) and records it as `note:` evidence.
- [ ] **Step 6:** Commit "P1 spike: queue/scheduler and auth build-vs-adopt".

### Task 2: Executor workspace from copied devlanes crates (P1-T03)

**Files:**

- Create: `executor/Cargo.toml`, `executor/rust-toolchain.toml`, `executor/LICENSE`, `executor/NOTICE`,
  `executor/devlanes-sync.toml`, `executor/crates/{core,sys-windows,shell-windows,runner-windows,start-gate,metrics,metrics-windows,logs}/**`,
  `executor/crates/core/src/{error.rs,job.rs}`, `executor/crates/executor/{Cargo.toml,src/lib.rs}` (empty library the
  later tasks fill), `executor/bins/devrounds-executor/{Cargo.toml,src/main.rs}`,
  `control-plane/src/executor-guards.test.ts`
- Modify: `package.json`, `biome.json`, `.gitignore`, `control-plane/src/no-suppressions.test.ts`,
  `control-plane/src/errors/errors.test.ts`, `AGENTS.md`, `README.md`

**Interfaces:**

- Produces: crates `devrounds-core` (`LaunchSpec`, `Runner`, `Unit`, `StopPolicy`, `StopSignal`, `ProcessIdentity`,
  `ExitOutcome`, `clock::{Clock, TokioClock, ManualClock}`, `gate::{StartGate, StartRequest, Release, HoldReason,
  GateSnapshot, PressureSource, PressureSample, DEFAULT_MEMORY_NEED}`, `DrError { code: &'static str, data:
  serde_json::Value }` with `DrError::new(code, data)` and `Display` = `"{code} {data}"`, `JobSpec { job_type: String,
  program: String, args: Vec<String>, cwd: String, env_allow: Vec<String>, timeout_s: u32 }` (serde; env names only)),
  and the copied crates under their upstream API.
- `StartRequest` becomes `{ run: String, job_type: String, order: usize, memory_need: u64 }` (lane/unit dropped).
- `executor/devlanes-sync.toml`: `upstream`, `[[crate]] name, upstream_path, synced_commit`, `[[reviewed]] commit,
  crate, decision ("ported"|"not_applicable"), reason` (empty at first).
- Root scripts: `test:executor` = `cargo test --manifest-path executor/Cargo.toml --workspace`, `lint:executor` =
  `cargo fmt --manifest-path executor/Cargo.toml --all --check && cargo clippy --manifest-path executor/Cargo.toml
  --workspace --all-targets -- -D warnings`; `test` glob gains `"scripts/**/*.test.ts"`.

- [ ] **Step 1: Failing guard tests** in `control-plane/src/executor-guards.test.ts`:
      `NOTICE names every crate of devlanes-sync.toml with its upstream path and commit` (parse the toml with `smol-toml`;
      for each crate `assert.match(notice, new RegExp(\`${name}._${upstreamPath}.*e2e4f1ca\`, 's'))`);
  `rust code allows lints only in the accepted list`(walk`executor/**/*.rs`skipping`target`; any `#[allow(`,
  `#![allow(`or`#[expect(`outside`executor/crates/sys-windows/src/lib.rs`fails). Extend`errors.test.ts`: emitted
  codes also come from `executor/**/_.rs`via`/DrError::new\(\s*"(DR\d{3})"/g`. Add `target`to the
 `no-suppressions.test.ts` SKIP set.
- [ ] **Step 2:** Run `pnpm test` → the two new tests FAIL (no `executor/`).
- [ ] **Step 3:** Copy the eight crates from `C:\Users\Guilherme\Code\Clickmax\devlanes\crates` at the sync commit,
      rename, and trim: `core` keeps `clock`, `gate`, `runtime`, `stop` (drop `color`, `contrib`, `env`, `paths`, `ports`,
      `redact`, `refs`, lane/project ids); `sys-windows` drops `cert`, `conpty`, `net`, `pipe`, `power`, `registry`,
      `shell_execute`; `runner-windows` drops `foreground`, `terminal` (ConPTY), `listening_ports`, `set_power`, and its
      `devlanes-sys` dependency (move `ProcessInfo` into `core`); `metrics` keeps `ring`, `sketch`, `run` (subject = run
      id); `logs` keeps `framing`, `level`, `storage`, moves `LogLine` in (field `unit` → `run`), drops `query` and the
      `grep-*`/`jiff` deps, replaces `#![allow(clippy::unwrap_used)]` in its tests with `expect`. `sys` and `runner-pty`
      are not copied (`runner-pty` is Unix-only; ConPTY waits for P4 terminals). Keep the copied tests that still apply.
      Write `NOTICE` and `devlanes-sync.toml` (one `[[crate]]` per copied crate, `synced_commit` = the sync commit).
      Binary `devrounds-executor` answers `version` and routes `__console-ctrl` to `console_ctrl_main`. Gitignore
      `executor/target/` and `executor/.devlanes-cache/`; Biome excludes `executor/target`.
- [ ] **Step 4:** `AGENTS.md`: under Always, the `x5x` error block; under Never, "start a process in the executor
      outside `devrounds_sys_windows::spawn`"; under accepted exceptions, "`#[allow(unsafe_code)]` on the FFI modules of
      `executor/crates/sys-windows/src/lib.rs`, each unsafe block with a SAFETY comment". README: build and test the
      executor.
- [ ] **Step 5:** Run `pnpm test`, `pnpm test:executor`, `pnpm lint`, `pnpm lint:executor`, `pnpm typecheck` → all PASS.
- [ ] **Step 6:** Commit "Executor workspace from copied devlanes crates".

### Task 3: devlanes-sync check (P1-T37)

**Files:**

- Create: `scripts/devlanes-sync.ts`, `scripts/devlanes-sync.test.ts`
- Modify: `package.json` (`devlanes-sync` = `node scripts/devlanes-sync.ts`), `README.md`

**Interfaces:**

- Consumes: `executor/devlanes-sync.toml` (Task 2).
- Produces: `pendingUpstream(opts: { cacheDir: string; config: SyncConfig; ref: string }): Promise<Pending[]>` where
  `Pending = { commit: string; subject: string; crate: string }`; CLI `pnpm devlanes-sync [--fetch]`: `--fetch` runs
  `git fetch` of `upstream` into the bare cache `executor/.devlanes-cache` (created with `git init --bare` when
  missing); without it, only the cache is read. Exit 0 when nothing is pending, 1 with one line per pending commit
  (`<sha> <crate> <subject>`) and `next: port it or add a [[reviewed]] entry, then advance synced_commit`.

- [ ] **Step 1: Failing tests** (fixture: a bare repo built in the test dir with `git` via async `execFile`, commits
      touching `crates/logs/src/a.rs` and `README.md`):
      `lists upstream commits since synced_commit that touch a mapped path` (one entry, crate `logs`);
      `a commit recorded as reviewed is not pending`; `commits outside mapped paths are ignored`;
      `the real check passes against the cached fetch` (runs on `executor/.devlanes-cache`; when the cache is missing the
      test fails with `run pnpm devlanes-sync --fetch`).
- [ ] **Step 2:** Run `node --test scripts/devlanes-sync.test.ts` → FAIL.
- [ ] **Step 3:** Implement with `git log --format=%H%x09%s <synced_commit>..<ref> -- <upstream_path>` per crate, async
      `execFile` only; `ref` = `refs/remotes/upstream/main` in the cache.
- [ ] **Step 4:** `pnpm devlanes-sync --fetch` once (populates the cache), then `pnpm test` → PASS. Any upstream commit
      already pending is ported or marked `not_applicable` with a reason in this task.
- [ ] **Step 5:** Commit "devlanes-sync check for copied crates".

### Task 4: Job Object supervision with run-owned output (P1-T04)

**Files:**

- Create: `executor/crates/test-fixtures/{Cargo.toml,src/bin/tree-fixture.rs}`,
  `executor/crates/runner-windows/tests/supervision.rs`
- Modify: `executor/crates/core/src/runtime.rs`, `executor/crates/runner-windows/src/{spawn.rs,unit.rs,lib.rs}`,
  `executor/crates/sys-windows/src/proc.rs`, `executor/NOTICE`

**Interfaces:**

- Produces: `LaunchSpec { program, args, cwd, env, output: RunOutput }` with `RunOutput { stdout: PathBuf, stderr:
  PathBuf }` (files opened append + share-read and inherited as the child's handles; stdin is `NUL`);
  `RunIdentity { leader: ProcessIdentity, boot_id: String }`; `WindowsRunner::spawn_unit(spec) ->
  Result<Arc<WindowsUnit>, Error>`; `WindowsUnit::{run_identity() -> RunIdentity, job_members() -> Result<Vec<ProcessIdentity>, Error>,
  wait_report() -> Result<ExitReport, Error>, stop_with_report(StopPolicy) -> Result<ExitReport, Error>}`;
  `ExitReport { outcome, stop: Option<StopOutcome>, swept: Vec<ProcessInfo>, escaped: Vec<ProcessInfo> }`.
  The run ends when its leader exits; members still alive then are terminated after the 10 s grace and listed in
  `swept`.
- `tree-fixture` flags: `--children N`, `--depth D`, `--print N`, `--exit CODE`, `--linger-ms MS` (children outlive the
  leader by this), `--alloc-mb MB [--touch]`, `--ctrl-c ignore|bye`, `--breakaway`, `--print-env`, `--steps NAME,...`
  (prints `::devrounds::step-start name=<n>` then `::devrounds::step-end name=<n> outcome=finished` per name).

- [ ] **Step 1: Failing tests** in `supervision.rs`:
      `every_descendant_is_a_job_member` (`--children 2 --depth 2 --linger-ms 5000` → `job_members().len() == 7` within 3 s);
      `breakaway_is_refused` (`--breakaway` → stdout file contains `breakaway: denied`);
      `graceful_stop_lets_ctrl_c_handlers_run` (`--ctrl-c bye` → `stop.escalated == false`, stdout contains `bye`);
      `stop_ends_the_tree_within_grace` (`--children 3 --ctrl-c ignore` → `escalated == true`, elapsed < 12 s, no recorded
      identity still matches);
      `dropping_the_handles_leaves_the_run_running` (drop every `Arc<WindowsUnit>` → leader still matches after 1 s);
      `leader_exit_sweeps_lingering_members` (`--children 2 --linger-ms 60000 --exit 3` → `outcome.code == Some(3)`,
      `swept.len() == 2`);
      `output_goes_to_run_owned_files` (`--print 100`, handles dropped before exit → stdout file has 100 lines);
      `identity_carries_boot_id` (`run_identity().boot_id == proc::boot_id()?`).
- [ ] **Step 2:** `cargo test --manifest-path executor/Cargo.toml -p devrounds-runner-windows --test supervision` → FAIL.
- [ ] **Step 3:** Implement: replace the output pipes in `spawn.rs` with the two run-owned file handles; keep
      `JobOptions { kill_on_close: false, die_on_unhandled_exception: true }`; add `run_identity` and `job_members`
      (`Job::members` + start times). Record the change in `NOTICE`.
- [ ] **Step 4:** Run the tests → PASS; `pnpm lint:executor` → PASS.
- [ ] **Step 5:** Commit "Job Object supervision with run-owned output files".

### Task 5: Every spawn hidden (P1-T05)

**Files:**

- Create: `executor/crates/runner-windows/tests/hidden.rs`
- Modify: `executor/crates/runner-windows/src/{spawn.rs,ctrl.rs,unit.rs}`, `control-plane/src/executor-guards.test.ts`

**Interfaces:**

- Produces: `WindowsUnit::visible_windows() -> Result<u32, Error>` (top-level visible windows owned by job members,
  from `window::visible_windows()`); every run spawn uses `CreationFlags { no_window: true, new_process_group: true,
  ..Default::default() }`, the console-ctrl helper `no_window: true`.

- [ ] **Step 1: Failing tests** in `hidden.rs` (each polls `visible_windows()` every 100 ms while the run lives and
      asserts every reading is 0):
      `nested_console_children_stay_hidden` (`cmd.exe /c <tree-fixture> --children 2 --linger-ms 2000`);
      `cmd_wrapper_gets_exact_arguments_and_stays_hidden` (a test-written `echo-args.cmd` = `@echo off` +
      `for %%a in (%*) do echo [%%~a]`, args `["a b", "c&d", "é"]` → stdout lines `[a b]`, `[c&d]`, `[é]`);
      `console_ctrl_helper_is_hidden` (`stop_with_report` on `--ctrl-c bye` while polling).
      Guard in `executor-guards.test.ts`: `executor starts processes only through sys-windows spawn` (no
      `std::process::Command`, `tokio::process::Command` or `Command::new(` in `executor/**/src/**/*.rs`, except
      `crates/test-fixtures`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `visible_windows`; set the flags; route any remaining std spawns through
      `devrounds_sys_windows::spawn::spawn`.
- [ ] **Step 4:** `cargo test ... -p devrounds-runner-windows --test hidden` and `pnpm test` → PASS.
- [ ] **Step 5:** Commit "Every executor spawn is hidden".

### Task 6: Footprint by private bytes (P1-T17)

**Files:**

- Create: `executor/crates/metrics-windows/tests/footprint.rs`, `executor/crates/executor/src/sampler.rs`
- Modify: `executor/crates/sys-windows/src/{usage.rs,job.rs}`, `executor/crates/metrics-windows/src/collector.rs`,
  `executor/crates/metrics/src/run.rs`, `executor/NOTICE`

**Interfaces:**

- Produces: `ProcessUsage.private_bytes: u64` (`PROCESS_MEMORY_COUNTERS_EX2.PrivateUsage`);
  `Job::peak_memory() -> io::Result<u64>` (`PeakJobMemoryUsed`); `WindowsSource::sample_run(members:
  &[ProcessIdentity]) -> RunSample { footprint_bytes: u64, cpu_percent: f64 }` (sum of members' private bytes);
  `RunTracker::finish(..) -> RunSummary { samples, footprint: ByteSummary { p50, p95, peak }, cpu: CpuSummary,
  cpu_seconds: f64 }` with `peak = max(sampled peak, job peak)`; `Sampler::spawn(unit, slot: Option<StartSlot>, tx)` in
  `devrounds-executor` sampling every 1 s while `slot` is unreleased, then every 5 s, feeding
  `slot.report_memory(footprint)` and `slot.report_cpu(cpu)`; `self_private_bytes() -> io::Result<u64>`.

- [ ] **Step 1: Failing tests** in `footprint.rs`:
      `footprint_counts_commit_not_working_set` (`--alloc-mb 256` without `--touch` → `footprint_bytes >= 256 << 20` while
      the process working set < `64 << 20`);
      `tree_footprint_sums_members` (`--children 2 --alloc-mb 100 --linger-ms 3000` → `>= 200 << 20`);
      `peak_is_exact_between_samples` (allocates 300 MB for 200 ms then frees; 5 s cadence → `summary.footprint.peak >=
  300_000_000`);
      in `metrics` unit tests: `summary_reports_p50_p95_peak` (samples 100..=200 MiB step 1 MiB → `p95` within 1% of
      195 MiB, `peak == 200 MiB`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; the collector's footprint switches from private working set to private bytes (`NOTICE`).
- [ ] **Step 4:** `cargo test ... -p devrounds-metrics-windows -p devrounds-metrics -p devrounds-executor` → PASS.
- [ ] **Step 5:** Commit "Footprint by private bytes of the run tree".

### Task 7: Start-gate admission with AIMD (P1-T06)

**Files:**

- Create: `executor/crates/executor/src/admission.rs`, `executor/crates/executor/tests/admission.rs`
- Modify: `executor/crates/start-gate/src/{lib.rs,engine.rs}`, `executor/crates/executor/src/lib.rs`

**Interfaces:**

- Consumes: `gate::*`, `WindowsPressure` (Task 2), `Sampler` (Task 6).
- Produces: `AdmissionConfig { initial_window: usize = 4, max_window: usize = 16, target_cpu: f64 = 80.0,
  slot_timeout: Duration = 60 s }` (executor config `admission.*`, wired in Task 13); `Admission::new(config, pressure: Arc<dyn
  PressureSource>, clock: Arc<dyn Clock>)`; `Admission::admit(run: &str, job_type: &str, need: u64) -> Admitting`;
  `Admitting::next().await -> AdmissionStep` with `AdmissionStep::Delayed { reason: DelayReason, position: usize,
  need: u64, available: Option<u64> }` (emitted once per change of reason) or `AdmissionStep::Admitted(StartSlot)`;
  `DelayReason::{Memory, Concurrency, MemoryCritical}` mapped from `HoldReason`. Dropping `Admitting` leaves the queue.
  The slot is released by the gate's settle rule, the run's exit, or `slot_timeout`.

- [ ] **Step 1: Failing tests** (`ManualClock` + a fake `PressureSource`):
      `memory_hold_reports_delayed_memory_then_admits` (available 1 GiB, need 2 GiB → `Delayed{Memory}`; available 4 GiB +
      advance one sample → `Admitted`);
      `full_window_reports_delayed_concurrency` (window 1, one slot held → `Delayed{Concurrency, position: 1}`);
      `aimd_halves_on_high_cpu_and_grows_by_one` (window 8; CPU 98% for `high_for` → 4; CPU 50% for `grow_every` → 5);
      `dropping_admitting_leaves_the_queue` (snapshot `queued` empty after drop);
      `need_defaults_to_512_mib` (`DEFAULT_MEMORY_NEED == 536_870_912`).
- [ ] **Step 2:** `cargo test ... -p devrounds-executor --test admission` → FAIL.
- [ ] **Step 3:** Implement over `AdaptiveGate` with the pressure reading; copied start-gate tests stay green.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Start-gate admission with AIMD window".

### Task 8: isolation/none (P1-T12)

**Files:**

- Create: `executor/crates/executor/src/isolation.rs`, `executor/crates/executor/tests/isolation.rs`

**Interfaces:**

- Consumes: `devrounds_core::JobSpec` (Task 2), `LaunchSpec`/`RunOutput` (Task 4).
- Produces: `trait Isolation { fn prepare(&self, run: &str, job: &JobSpec, run_dir: &Path, machine_env:
  &BTreeMap<String, String>) -> Result<LaunchSpec, PrepareError>; }`, `NoneIsolation`, `PrepareError::Environment {
  summary: String }`. The child env = allowlisted names copied from `machine_env` (case-insensitive match, original
  case kept) plus `DEVROUNDS_RUN_ID`. `cwd` must be absolute and exist.

- [ ] **Step 1: Failing tests:** `only_allowlisted_variables_reach_the_child` (executor env has `PATH` and
      `SECRET_TOKEN=s3cr3t`, allowlist `["path"]`; `tree-fixture --print-env` output contains `PATH=` and `DEVROUNDS_RUN_ID=`,
      not `s3cr3t`); `missing_cwd_is_an_environment_failure` (`PrepareError::Environment` naming the path);
      `relative_cwd_is_an_environment_failure`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "isolation/none: launch spec from job spec through the env allowlist".

### Task 9: Protocol Hello, features and seq (P1-T07)

**Files:**

- Create: `executor/crates/protocol/{Cargo.toml,src/lib.rs,tests/fixtures.rs,fixtures/*.json}`,
  `control-plane/src/executor/protocol.ts`, `control-plane/src/executor/protocol.test.ts`
- Modify: `control-plane/src/errors/{codes.ts,words.ts}`, `docs/errors.md`

**Interfaces:**

- Produces (Rust, mirrored 1:1 in TypeBox): `PROTOCOL: u32 = 1`; `FEATURES = ["seq", "steps", "log-segments",
  "orphans", "trace-context"]`; envelope field `type`.
  Executor → control plane: `Hello { protocol, version, features, boot_id }`, `MachineReport { total_memory,
  available_memory, commit_total, commit_limit, cpu_percent, memory_pressure, running: u32, executor_private_bytes }`,
  `LogChunk { run, stream, text }` (live only, no seq), `Event { seq: u64, at: String /* RFC 3339 UTC */, event:
  RunEvent }`; `RunEvent` tagged `kind`: `Admitted { run }`, `Delayed { run, reason, position, need, available }`,
  `RunStarted { run, pid, start_time, boot_id }`, `StepStarted { run, step: u32, name }`, `StepFinished { run, step,
  outcome: "finished"|"failed" }`, `LogSegment { run, first_seq, last_seq, records, zstd_base64 }`, `RunFinished { run,
  reason: "exited"|"stopped"|"timeout"|"spawn_failed"|"infra", exit_code: Option<i64>, peak, p95, p50, cpu_seconds,
  swept: u32, visible_windows: u32, tail: Vec<String>, summary: Option<String> }`, `Orphans { runs: [{ run, alive }] }`.
  Control plane → executor: `HelloAck { protocol, features, machine_id, last_seq }`, `Offer { run, job: JobSpec,
  memory_need, trace_parent: Option<String> }`, `Stop { run, reason: "cancel"|"orphan_policy" }`, `Ack { seq }`,
  `Resync { from_seq }`. `JobSpec` is `devrounds_core::JobSpec`. Unknown `type` → `Unknown`, unknown `kind` →
  `RunEvent::Unknown`; both ignored. TS `checkHello(hello): string[]` returns the negotiated features, DR151 when
  `protocol !== 1`.
  `negotiate(ours, theirs) -> Vec<String>` (intersection, ours' order). Rust `decode_server(&str) ->
  Result<ServerMessage, DrError>`; TS `parseExecutorMessage(text: string): ExecutorMessage | { type: 'Unknown' }`
  (DR150 for a known type with a bad shape), `SeqTracker { lastSeq: bigint; accept(seq): 'new' | 'duplicate' | 'gap' }`
  (`gap` answers once per gap; `new` only for `lastSeq + 1`).
- Codes: DR150 `Protocol message {type} is invalid at {path}: {reason}.`, DR151 `Executor protocol {got} is not
  supported; this control plane speaks {supported}.` (hints: update the older side).

- [ ] **Step 1: Failing tests:** Rust `every_fixture_round_trips` (each `fixtures/*.json` decodes and re-encodes to the
      same JSON value), `every_message_type_has_a_fixture`, `unknown_type_and_kind_are_ignored`, `negotiate_keeps_shared_features`;
      TS `every fixture validates against the TypeBox schema`, `a known type with a bad field answers DR150 at its path`,
      `an unknown type parses as Unknown`, `SeqTracker answers new, duplicate and one gap`.
- [ ] **Step 2:** Run `cargo test ... -p devrounds-protocol` and `pnpm test` → FAIL.
- [ ] **Step 3:** Implement both sides; add DR150/DR151 to words; `pnpm gen:errors`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Executor protocol: Hello, features, seq and shared fixtures".

### Task 10: Machine pairing and executor session (P1-T10)

**Files:**

- Create: `control-plane/src/db/migrations/0004_machines.ts`, `control-plane/src/machines/{pairing.ts,service.ts,pairing.test.ts}`,
  `control-plane/src/executor/{gateway.ts,gateway.test.ts}`, `control-plane/src/api/machine-routes.ts`,
  `executor/crates/executor/src/{config.rs,pair.rs,connection.rs}`, `executor/crates/executor/tests/connection.rs`
- Modify: `control-plane/src/db/{schema.ts,migrations/index.ts}`, `control-plane/src/api/server.ts`,
  `control-plane/src/main.ts`, `control-plane/src/cli/commands.ts`, `control-plane/src/errors/{codes.ts,words.ts}`,
  `control-plane/package.json` (`@fastify/websocket`), `docs/errors.md`, `AGENTS.md`, `executor/bins/devrounds-executor/src/main.rs`

**Interfaces:**

- Tables: `machines(id, tenant_id, name, compute_provider text default 'local', lifecycle text check in
  ('persistent','ephemeral') default 'persistent', token_hash bytea unique, os text, executor_version text, paired_at,
  revoked_at null, last_seen_at null, last_report jsonb null, last_seq bigint default 0, unique (tenant_id, id))` with a
  partial unique index `(tenant_id, name) where revoked_at is null`; `pairing_codes(id, tenant_id, code_hash bytea
  unique, machine_name, created_by → members, created_at, expires_at, used_at null)`. Security definer functions:
  `redeem_pairing_code(code_hash bytea, token_hash bytea, os text, version text) returns table (tenant_id uuid,
  machine_id uuid, machine_name text)` (unused, unexpired code → insert machine, mark used, one statement set);
  `resolve_machine_token(hash bytea) returns table (tenant_id uuid, machine_id uuid)` (ignores revoked).
- TS: `createPairingCode(ctx, machineName) -> { code, expiresAt }` (human members only, else DR453);
  `redeemPairingCode(db, limiter, code, { os, version }) -> { machineId, machineName, token }` (DR450, DR451);
  `resolveMachineToken(db, token) -> { tenantId, machineId }` (DR452); `revokeMachine(ctx, sessions, name)` (human
  only); `PairingLimiter(clock)` in memory, per process (5 failures / 10 min → locked 10 min); `listMachines(ctx)`;
  `recordReport(ctx, machineId, report)`. `Sessions { get(machineId), send(machineId, msg), close(machineId, code) }`;
  routes `POST /api/executor/pair`, `GET /api/executor/connect` (WS; `Authorization: Bearer drm_…`; `Hello` within
  10 s or close 4400; protocol ≠ 1 → DR151 + close 4400; reply `HelloAck { last_seq: machines.last_seq }`; a newer
  session closes the older with 4409; revoke closes with 4401), `POST /api/machines/pairing-codes { name }`,
  `GET /api/machines`, `POST /api/machines/:name/revoke`. WS `maxPayload` 4 MiB.
- CLI: `devrounds machine pair-code --name <machine>` (prints code, expiry, `next: devrounds-executor pair --url <url>
  --code <code>`), `devrounds machine list`, `devrounds machine revoke <name>`.
- Rust: `ExecutorConfig { url: String, machine_id: String }` at `<home>/config.json` (Task 13 adds `admission:
  AdmissionConfig`, Task 16 `otlp_endpoint: Option<String>`); token at `<home>/machine-token` (written after
  `ensure_private_dir(home)`); `pair(home, url, code) -> Result<(), DrError>` (ureq on `spawn_blocking`; a home that
  cannot be made owner-only is DR550); `HomeLock::acquire(home) -> Result<HomeLock,
  DrError>` (DR352); `Connection::run(config, token, handler) ` connects (refusing `ws://` to a non-loopback host with
  DR551), sends `Hello`, reconnects with backoff 1 s → 30 s, sends `MachineReport` every 10 s.
- Codes: DR352 `Another executor is running for {home} (pid {pid}).`, DR450 `Pairing code is invalid, expired or
  already used.`, DR451 `Pairing is locked for {minutes} minutes after repeated failures.`, DR452 `Machine token is
  missing, invalid or revoked.` (hint: pair again with `devrounds-executor pair`), DR453 `Only a human member can
  {action}.`, DR550 `Executor state at {path} is unusable: {reason}.`, DR551 `Executor configuration is invalid:
  {reason}.`

- [ ] **Step 1: Failing tests** (TS with the global `WebSocket` client; Rust with a fake server on `127.0.0.1:0`):
      `a pairing code works once and expires after 10 minutes`; `the machine token is stored only as its SHA-256`;
      `five failed redemptions lock pairing for 10 minutes (DR451)`; `an agent token cannot create a pairing code (DR453)`;
      `connect without a valid machine token closes with 4401 and DR452`; `revoking a machine closes its live session`;
      `a second session for the same machine replaces the first (close 4409)`; `Hello with protocol 2 answers DR151 and
  closes 4400`; `a machine of another tenant is not found (DR201)`; Rust `ws_to_a_non_loopback_host_is_refused`,
      `pair_writes_an_owner_only_token_file` (`check_private_file` passes), `a_second_executor_on_the_same_home_fails_with_dr352`,
      `hello_then_machine_report_reach_the_server`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `AGENTS.md` lists `devrounds machine pair-code --name <machine>` (parsed by
      `agent-docs.test.ts`); `pnpm gen:errors`.
- [ ] **Step 4:** `pnpm test`, `pnpm test:executor`, `pnpm lint`, `pnpm lint:executor`, `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit "Machine pairing and executor session".

### Task 11: Run record (P1-T38)

**Files:**

- Create: `control-plane/src/db/migrations/0005_runs.ts`, `control-plane/src/job-types/{file.ts,service.ts,job-types.test.ts}`,
  `control-plane/src/runs/{states.ts,classify.ts,record.ts,view.ts,learned-need.ts}`,
  `control-plane/src/runs/{classify.test.ts,record.test.ts}`
- Modify: `control-plane/src/db/{schema.ts,migrations/index.ts}`, `control-plane/src/errors/{codes.ts,words.ts}`, `docs/errors.md`

**Interfaces:**

- Tables: `job_types(id, tenant_id, project_id, key, program text, args jsonb, env_allow text[] default '{}',
  timeout_s int default 3600, orphan_policy text check in ('kill','let_finish') default 'kill', classify jsonb default
  '[]', updated_at, unique (project_id, key), unique (tenant_id, id))`; `jobs(id, tenant_id, project_id, job_type_id,
  task_id null, cwd text, machine_id → machines, created_by → members, created_at, unique (tenant_id, id))`;
  `runs(id, tenant_id, project_id, job_id, job_type_id, machine_id, attempt int default 1, state check in
  ('queued','offered','admitted','running','finished','failed','stopped','orphaned'), queued_at, offered_at null,
  admitted_at null, started_at null, finished_at null, exit_code bigint null, failure_class text null check in
  ('check_red','environment','timeout','memory','infra','cancelled','unclassified'), failure_summary text null,
  log_cursor bigint null, pid int null, process_start_time bigint null, boot_id text null, peak_private_bytes bigint
  null, p95_private_bytes bigint null, p50_private_bytes bigint null, cpu_seconds double precision null,
  swept_processes int null, visible_windows int null, orphan_action text null check in ('killed','let_finish'),
  clock_skew_ms int default 0, trace_id text null, unique (job_id, attempt), unique (tenant_id, id))`, indexes
  `(tenant_id, project_id, queued_at)`, `(tenant_id, machine_id, state)`; `run_steps(id, tenant_id, run_id, step int,
  name, started_at, finished_at null, outcome check in ('finished','failed') null, unique (run_id, step))`;
  `run_delays(id bigserial, tenant_id, run_id, at, reason check in ('memory','concurrency','memory_critical'),
  need_bytes bigint, available_bytes bigint null, position int)`.
- Job type file (YAML, TypeBox): `key`, `command: { program, args }`, `env: string[]`, `timeout_s`, `orphan_policy`,
  `classify: [{ class, exit_codes?: int[], log_pattern?: string }]` (both given = both must match). Exposed:
  `parseJobTypeFile(text) -> JobTypeDef` (DR101 with path), `putJobType(ctx, projectKey, def)`, `getJobType(ctx,
  projectKey, key)`.
- `nextRunState(state, event) -> { state, stamp?: 'offered_at'|'admitted_at'|'started_at'|'finished_at' }` or DR351.
- `classifyRun({ reason, exitCode, tail, summary }, rules) -> { state, failureClass, failureSummary }` in this order:
  `stopped` → stopped/cancelled; `timeout` → failed/timeout; `spawn_failed` → failed/environment; `infra` →
  failed/infra; exit 0 → finished/null; exit `3221225495` (`STATUS_NO_MEMORY`) or `3221225773`
  (`STATUS_COMMITMENT_LIMIT`) → failed/memory; first matching job type rule; else failed/unclassified. Summary: lines of
  `tail` matching the rule's `log_pattern` (first 20), else the last 20 lines, cut at 4096 bytes on a whole line.
- `createRun(ctx, { jobTypeKey, machineName, cwd, taskKey? }) -> RunView` (job + run attempt 1, `queued`);
  `retryRun(ctx, runId) -> RunView` (new run, `attempt + 1`, same job); `markOffered(ctx, runId)`;
  `applyRunEvent(ctx, machineId, event: RunEvent, at: Date)` (one transaction; executor-stamped times earlier than
  `offered_at` are clamped to it and the gap added to `clock_skew_ms`); `runView(ctx, runId) -> RunView { id, state,
  attempt, jobType, machine, task, timeline, durations: { queueWaitMs, admissionDelayMs, runTimeMs, totalMs } (null
  when an end is missing), outcome: { exitCode, failureClass, failureSummary, logCursor }, resources: { peak, p95, p50,
  cpuSeconds, swept, visibleWindows }, steps[], delays[] }`.
- `learnedNeed(trx, projectId, jobTypeId, machineId) -> bigint`: median `peak_private_bytes` of the last 10 runs of
  that key with a peak; `536870912n` with none.
- Code: DR351 `Run {run} is {state}, which does not allow this change.`

- [ ] **Step 1: Failing tests:** `classify.test.ts` (table): exit 0 → finished; exit 1 with rule `{class: check_red,
  exit_codes: [1]}` → check_red; tail `ERR_PNPM_NO_LOCKFILE` with rule `{class: environment, log_pattern:
  'ERR_PNPM_'}` → environment and summary is that line; exit 3221225495 → memory; reason timeout → timeout; reason
      stopped → stopped/cancelled; exit 7 without rules → unclassified; a 10 000-line tail gives a summary ≤ 4096 bytes.
      `record.test.ts`: `a run moves queued → offered → admitted → running → finished and stamps each time`; `an illegal
  transition answers DR351 and changes nothing`; `durations are never negative when the executor clock is behind`
      (RunStarted `at` 5 s before `offered_at` → `admissionDelayMs >= 0`, `clock_skew_ms == 5000`); `a retry is a new run
  of the same job with attempt 2`; `steps and delays are recorded with the run`; `learned need is the median of the
  last 10 peaks, 536870912 without history`; `a run of another tenant is not found (DR201)`. `job-types.test.ts`:
      `an unknown failure class is refused with DR101 at /classify/0/class`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `pnpm gen:errors`.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit "Run record: job types, jobs, runs, steps, delays and failure classes".

### Task 12: Executor store and outbox (P1-T40)

**Files:**

- Create: `executor/crates/store/{Cargo.toml,src/lib.rs,tests/store.rs}`, `executor/crates/executor/tests/replay.rs`
- Modify: `executor/crates/executor/src/connection.rs`, `control-plane/src/executor/gateway.ts`,
  `control-plane/src/executor/gateway.test.ts`

**Interfaces:**

- Produces: `Store::open(path) -> Result<Store, DrError>` (one `std::thread` owning a `rusqlite::Connection`; requests
  over `std::sync::mpsc` with `tokio::sync::oneshot` replies; DR550 when the file is unusable). Tables `runs(run_id
  primary key, job_json, state, leader_pid, leader_start_time, boot_id, run_dir, members_json)`, `outbox(seq integer
  primary key autoincrement, message text)`, `meta(key primary key, value)`. Methods (async): `append_event(event:
  RunEvent) -> u64`, `ack_through(seq)`, `pending_after(seq) -> Vec<(u64, String)>`, `put_run(StoredRun)`,
  `set_identity(run, RunIdentity)`, `record_members(run, Vec<ProcessIdentity>)`, `runs_in_flight() -> Vec<StoredRun>`,
  `forget_run(run)`. `job_json` holds `JobSpec` only (env names, never values).
- Connection: on `HelloAck { last_seq }` → `ack_through(last_seq)`, resend `pending_after(last_seq)` in order, then
  live; on `Ack { seq }` → `ack_through(seq)`; on `Resync { from_seq }` → resend from there. `connected: watch::Receiver<bool>`
  for the run loop (a granted slot waits for `true` before spawning).
- Consumes: `applyRunEvent` (Task 11), `SeqTracker` (Task 9).
- Gateway: per event, `SeqTracker` verdict; `new` → `applyRunEvent` and `machines.last_seq = seq` in one
  `withTenant` transaction, then `Ack`; `duplicate` → `Ack` only; `gap` → one `Resync { from_seq: last_seq + 1 }`. An
  event answering DR351 is logged and acked.

- [ ] **Step 1: Failing tests:** `events_survive_reopening_the_store` (append 3, drop, reopen → `pending_after(0)` has
      seqs 1, 2, 3); `ack_drops_events_through_seq`; `env_values_never_reach_the_store_file` (raw bytes of the db file do
      not contain the value of an allowlisted variable); `reconnect_replays_unacked_events_in_order` (fake server acks
      through 2 of 5, drops the socket, answers `HelloAck { last_seq: 2 }` → receives 3, 4, 5 once); TS `an event with seq
  <= last_seq is acked and not applied twice`; `a gap gets exactly one Resync`; `last_seq survives a control plane
  restart` (new `buildServer` on the same DB → `HelloAck.last_seq` equals the last applied seq).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Executor store and outbox replay".

### Task 13: Direct dispatch and the executor run loop (P1-T39)

**Files:**

- Create: `control-plane/src/runs/{dispatch.ts,dispatch.test.ts}`, `control-plane/src/api/run-routes.ts`,
  `executor/crates/executor/src/{runs.rs,steps.rs,output.rs}`, `executor/crates/executor/tests/run_loop.rs`
- Modify: `control-plane/src/api/server.ts`, `control-plane/src/executor/gateway.ts`, `control-plane/src/cli/commands.ts`,
  `control-plane/src/errors/{codes.ts,words.ts}`, `docs/errors.md`, `AGENTS.md`, `executor/bins/devrounds-executor/src/main.rs`

**Interfaces:**

- Consumes: `createRun`, `markOffered`, `applyRunEvent`, `runView`, `learnedNeed` (Task 11); `Sessions` (Task 10);
  `Admission` (Task 7); `NoneIsolation` (Task 8); `WindowsRunner` (Task 4); `Sampler` (Task 6); `Store` (Task 12).
- Produces (control plane): `dispatchRun(ctx, sessions, { jobTypeKey, machineName, cwd, taskKey? }) -> RunView` (no
  live session → DR350 and nothing written; else `createRun` → `markOffered` → `Offer` with `memory_need =
  learnedNeed(...)`); `stopRun(ctx, sessions, runId)` (terminal → DR351; offline → DR350; else `Stop { reason:
  'cancel' }`); `runEvents` (in-process `EventEmitter`, `'changed'` with the run id, emitted by the gateway after
  each applied event). Routes under `/api/projects/:key`: `PUT /job-types/:jobType` (YAML body), `GET
  /job-types/:jobType`, `POST /runs { jobType, machine, cwd, task? }` (Idempotency-Key supported), `GET
  /runs/:id?wait=<0..60>` (returns when terminal or after `wait` seconds), `POST /runs/:id/stop`.
- CLI: `devrounds jobtype set <file.yaml>`; `devrounds run start <jobType> --machine <name> --cwd <path> [--task <key>]`
  (prints the run id, `next: devrounds run show <id> --wait`); `devrounds run show <id> [--wait]` (failures first: state,
  class, summary; then timeline, durations, resources, steps, delays; `next:` `devrounds run logs <id>` when failed,
  else `devrounds plan show`); `devrounds run stop <id>`.
- Produces (executor): `RunLoop::handle(ServerMessage)`. `Offer` → `put_run` → `prepare` (failure → `RunFinished {
  reason: spawn_failed, summary }`) → `admit` (each `Delayed` → event) → wait `connected` → `Admitted` → spawn →
  `RunStarted` + `set_identity` → sampler + `OutputTail` (polls the run files every 200 ms on `spawn_blocking`, frames
  with `Framer`, keeps the last 50 lines ≤ 8 KiB as `tail`, parses step markers) → `timeout_s` elapsed → staged stop,
  reason `timeout` → `wait_report` → `RunFinished`. `Stop` while admitting → drop `Admitting`, `RunFinished { reason:
  stopped }`, no `RunStarted`; while running → staged stop, reason `stopped`. `parse_step_marker(line) ->
  Option<StepMarker>` for `::devrounds::step-start name=<name>` and `::devrounds::step-end name=<name>
  outcome=finished|failed`. `devrounds-executor run` wires config (adding `admission: AdmissionConfig` to `ExecutorConfig`), lock, store,
  connection, admission and the loop.
- Code: DR350 `Machine {machine} is not connected.`

- [ ] **Step 1: Failing tests:** TS (`dispatch.test.ts`, fake executor over `WebSocket`): `dispatch to a machine without
  a live session answers DR350 and writes no run`; `dispatch sends one Offer with memory_need 536870912 without
  history`; `executor events drive the run to finished with timeline and resources`; `stop of a finished run answers
  DR351`; `run show --wait returns as soon as the run is terminal`. Rust (`run_loop.rs`, in-process channel instead of
      a socket, real runner + `tree-fixture`): `an_offer_reports_admitted_started_finished_in_seq_order` (and
      `visible_windows == 0`); `stop_while_delayed_never_spawns` (window full → `Stop` → `RunFinished { reason: stopped }`
      with no `RunStarted`); `timeout_stops_the_tree_and_reports_timeout` (`timeout_s: 1`, `--linger-ms 60000`);
      `step_markers_become_step_events` (`--steps build,test` → two `StepStarted`/`StepFinished` pairs);
      `missing_program_reports_spawn_failed_with_a_summary`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; AGENTS.md quotes `devrounds run show <id> --wait`; `pnpm gen:errors`.
- [ ] **Step 4:** `pnpm test`, `pnpm test:executor`, `pnpm lint`, `pnpm lint:executor`, `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit "Direct dispatch and the executor run loop".

### Task 14: Log segments (P1-T09)

**Files:**

- Create: `control-plane/src/db/migrations/0006_log_segments.ts`, `control-plane/src/runs/{log-store.ts,log-store.test.ts}`,
  `executor/crates/executor/tests/segments.rs`
- Modify: `executor/crates/executor/src/{output.rs,runs.rs}`, `control-plane/src/executor/gateway.ts`,
  `control-plane/src/config.ts`, `control-plane/src/main.ts`, `control-plane/src/api/run-routes.ts`,
  `control-plane/src/cli/commands.ts`, `control-plane/src/db/{schema.ts,migrations/index.ts}`

**Interfaces:**

- Executor: per run `UnitLog::open(<run dir>/segments, run, LogOptions { segment_bytes: 1 << 20, segment_age_ms:
  30_000, compress: true, ..Default::default() })` fed by `OutputTail` (`ingest_stream("stdout"|"stderr", ..)`); each
  closed segment → `LogSegment` event through the outbox; `finish` at run end seals the last one before
  `RunFinished`. `LogChunk` (≤ 64 KiB, every 200 ms) is live only. Local segment files are deleted once acked; the raw
  files when the run's last segment is acked.
- Control plane: `log_segments(id, tenant_id, run_id, first_seq bigint, last_seq bigint, records int, bytes int, path
  text, created_at, unique (run_id, first_seq))`; security definer `expired_log_segments(cutoff timestamptz) returns
  table (tenant_id uuid, id uuid, path text)`. `storeSegment(ctx, runId, segment)` (write `.part`, rename, insert,
  set `runs.log_cursor = last_seq`; a known `first_seq` is a no-op); `readRunLog(ctx, runId, { cursor?: bigint,
  maxBytes: 16384 }) -> { lines: LogLine[], nextCursor: bigint | null }` (`zlib.zstdDecompress`, JSON lines);
  `pruneLogSegments(db, now, retentionDays)` hourly from `serve` (per tenant inside `withTenant`). Config
  `logsRoot`, `logRetentionDays` (`DEVROUNDS_LOGS_ROOT`, `DEVROUNDS_LOG_RETENTION_DAYS`). `LogChunk` is accepted and
  dropped (no live viewer in stage 1). Route `GET /api/projects/:key/runs/:id/logs?cursor=`; CLI `devrounds run logs
  <id> [--cursor <n>]` (16 KiB budget, `truncated; more: devrounds run logs <id> --cursor <n>`).

- [ ] **Step 1: Failing tests:** Rust `segments_ship_through_the_outbox_and_are_deleted_after_ack` (`--print 20000`
      → ≥ 2 segments, every seq 1..=20000 shipped once, run dir has no segments after acks);
      `partial_last_line_and_invalid_utf8_are_kept` (output `ok\n\xff\xfepartial` without newline → last two records
      present). TS `a stored segment reads back by cursor`; `a duplicate segment is ignored`; `segments older than the
  retention are pruned with their files`; `run logs pages at 16384 bytes with an exact --cursor continuation`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** All suites, lint, typecheck → PASS.
- [ ] **Step 5:** Commit "Log segments owned by the run, stored and pruned by the control plane".

### Task 15: Orphans (P1-T11)

**Files:**

- Create: `executor/crates/executor/src/orphans.rs`, `executor/crates/executor/tests/orphans.rs`,
  `control-plane/src/runs/orphans.test.ts`
- Modify: `executor/crates/executor/src/{runs.rs,sampler.rs}`, `control-plane/src/executor/gateway.ts`,
  `control-plane/src/runs/record.ts`

**Interfaces:**

- Executor: the sampler calls `record_members` every 5 s. At start, before admitting anything, `scan_orphans(store) ->
  Vec<(StoredRun, alive: bool)>` (`alive` = same `boot_id` and `proc::matches(leader pid, start_time)`) → one
  `Orphans` event. Orphans are never re-adopted: no sampler, no tail; their remaining raw output is shipped as segments
  and the run is forgotten after ack. `Stop { reason: orphan_policy }` for an orphan → `stop_orphan(helper, runtimes,
  leader, members, 10 s)` on `spawn_blocking`.
- Control plane: on `Orphans`, alive runs → `orphaned`, `failure_class = 'infra'`; policy `kill` → `Stop {
  orphan_policy }`, `orphan_action = 'killed'`; `let_finish` → nothing sent, `orphan_action = 'let_finish'`. Dead runs →
  `failed`/`infra`, summary `executor restarted; the run ended while unsupervised`.

- [ ] **Step 1: Failing tests:** Rust `restart_reports_a_surviving_run_as_orphaned_and_never_readopts` (executor A runs
      `--linger-ms 30000`; A's runtime is dropped without stopping; executor B on the same home sends `Orphans [{alive:
  true}]` and no `RunStarted`/sampling for it); `kill_policy_ends_the_orphan_tree` (B gets `Stop` → no recorded
      identity matches within 12 s); `a_run_that_ended_while_down_is_reported_dead`. TS `orphans with the kill policy get a
  Stop and stay orphaned with class infra`; `let_finish sends nothing`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Orphans reported on executor restart, handled by job type policy".

### Task 16: OpenTelemetry exporter, off by default (P1-T14)

**Files:**

- Create: `control-plane/src/telemetry/{otel.ts,otel.test.ts}`, `executor/crates/executor/src/telemetry.rs`,
  `executor/crates/executor/tests/telemetry.rs`
- Modify: `control-plane/src/config.ts`, `control-plane/src/main.ts`, `control-plane/src/runs/{dispatch.ts,record.ts}`,
  `control-plane/package.json`, `executor/crates/executor/src/runs.rs`

**Interfaces:**

- Control plane: `startTelemetry(endpoint: string | undefined, load = (m: string) => import(m)) -> Promise<Telemetry |
  null>`; `null` without an endpoint and `load` never called. `Telemetry.runDispatched(run) -> traceParent` (span
  `run.dispatch`, `runs.trace_id` set, `traceparent` sent in `Offer`); `Telemetry.runFinished(view)` (span `run.record`
  with the timeline as attributes). Config `otlpEndpoint` / `DEVROUNDS_OTLP_ENDPOINT`. Packages
  `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`,
  `@opentelemetry/resources`.
- Executor: `Telemetry::from_config(otlp_endpoint: Option<&str>) -> Option<Telemetry>` (OTLP HTTP exporter; nothing is
  built without an endpoint); spans `run.admission` (offer → admitted) and `run.execute` (started → finished) as
  children of the offer's `trace_parent`.

- [ ] **Step 1: Failing tests:** TS `without an endpoint no OpenTelemetry module is loaded` (spy `load` never called);
      `with an endpoint a dispatched run exports run.dispatch carrying the run id` (HTTP receiver on `127.0.0.1:0`,
      `/v1/traces`). Rust `no_exporter_without_endpoint`; `run_spans_continue_the_offer_trace` (fake receiver; exported
      trace id equals the one in `trace_parent`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "OpenTelemetry exporter on both sides, off by default".

### Task 17: Executor login service, end-to-end proof and footprint budgets (P1-T42)

**Files:**

- Create: `executor/crates/executor/src/{service.rs,supervise.rs}`, `scripts/footprint.ts`,
  `scripts/e2e/executor.e2e.ts`, `roadmap/fixtures/job-types/{synthetic.yaml,lint.yaml}`
- Modify: `executor/bins/devrounds-executor/src/main.rs`, `package.json` (`footprint`, `e2e`), `README.md`, `AGENTS.md`

**Interfaces:**

- `devrounds-executor service install|uninstall`: scheduled task `DevRoundsExecutor` with the P0 shape (at logon +
  every 5 min, `MultipleInstances IgnoreNew`, no time limit, interactive limited principal), action `conhost.exe
  --headless "<exe>" supervise`, PowerShell run through the hidden spawn; uninstall stops `supervise`/`run` by command
  line. `register_script(target) -> String`, `unregister_script(target) -> String` (pure).
  `supervise` spawns `run` hidden, restarts it with `next_delay(previous: Option<Duration>, uptime: Duration) ->
  Duration` (1 s, doubling to 30 s, reset after 5 min up, same as P0 `nextDelay`), logs to
  `<home>/logs/executor-YYYY-MM-DD.log`; `run` exits when the supervisor's inherited pipe closes; runs survive (no
  kill-on-close) and are reported as orphans by the next `run`.
- `pnpm footprint`: finds the control plane (`supervise.ts`, `main.ts serve`) and executor (`devrounds-executor`
  `supervise`, `run`) processes through `Get-CimInstance Win32_Process`, waits until `GET /api/machines` reports
  `running: 0` for 60 s, sums `PrivateMemorySize64` per side, prints both, exits 1 when executor > 50 000 000 or control
  plane > 300 000 000.
- `pnpm e2e` (`node scripts/e2e/executor.e2e.ts`): `cargo build --release`; control plane on the test DB with
  `DEVROUNDS_PORT=4993`; fresh tenant via `bootstrap`; executor home under `.superpowers/tmp/`; pairs, starts `run`,
  sets the two job types, dispatches and asserts (below).

- [ ] **Step 1: Failing tests:** Rust `register_script_runs_supervise_under_headless_conhost`,
      `next_delay_matches_the_control_plane_supervisor`; the e2e script's assertions:
      synthetic (`tree-fixture --children 3 --linger-ms 60000 --print 1000 --steps build,test --exit 0`): state
      `finished`, every timeline stamp set, every duration ≥ 0, `swept_processes == 3`, `visible_windows == 0`, two steps
      finished, `run logs` returns 1000 lines, `peak_private_bytes > 0`, no swept PID alive afterwards;
      lint (`pnpm lint`, cwd = repo root, env allowlist `PATH, PATHEXT, SystemRoot, ComSpec, USERPROFILE, APPDATA,
  LOCALAPPDATA, TEMP, TMP`): state `finished`, `visible_windows == 0`;
      orphan: executor killed (`taskkill /F` on `run`) during a `--linger-ms 60000` run, restarted → run `orphaned`,
      `orphan_action == 'killed'`, tree gone.
- [ ] **Step 2:** Run `pnpm e2e` → FAIL (no service, fixtures missing).
- [ ] **Step 3:** Implement the service, `footprint.ts`, the e2e script and the two job type files.
- [ ] **Step 4:** `pnpm e2e` → PASS; `pnpm test`, `pnpm test:executor`, `pnpm lint`, `pnpm lint:executor`,
      `pnpm typecheck`, `pnpm devlanes-sync` → PASS.
- [ ] **Step 5:** On Guilherme's machine: `devrounds machine pair-code --name guilherme-pc`, `devrounds-executor pair
  …`, `devrounds-executor service install`; run the synthetic job once through `devrounds run start`; after 60 s idle
      `pnpm footprint` → PASS. Check the P1 exit criteria "Executor stays at or under 50 MB private bytes idle", "Control
      plane stays at or under 300 MB private bytes idle" and "A job runs end to end on the executor with every spawn hidden
      and supervised" with `commit:` and `note:` evidence (the footprint output).
- [ ] **Step 6:** README: pair, service install, footprint, e2e. Commit "Executor login service, end-to-end proof and
      footprint budgets".

---

## Import list (stage 1)

Replaces the coarse P1-T03..T07, T09..T12, T14, T17 entries; P1-T08 (queues/jobs/runs) is narrowed to queues and
placement for the stage-2 re-plan; P1-T13, T15, T16, T18 stay for stage 2.

```yaml
- key: P1-T02
  title: Build-vs-adopt spike (queue/scheduler, Better Auth)
  phase: P1
  blocked_by: [P1-T01]
  criteria:
    - Spike doc records license, measured idle private bytes and fit for Hatchet, pg-boss, Graphile Worker, DBOS and an own scheduler
    - Better Auth fit with tenants, members and RLS is recorded with its idle cost
    - The recommendation is recorded as the controller call (Guilherme pre-approved stage decisions 17/11)
- key: P1-T03
  title: Executor workspace from copied devlanes crates
  phase: P1
  blocked_by: [P1-T01]
  criteria:
    - NOTICE names every copied crate with its upstream path and commit e2e4f1ca
    - Rust code allows lints only in the accepted list
    - cargo test, clippy -D warnings and fmt --check pass on the executor workspace
- key: P1-T37
  title: devlanes-sync check
  phase: P1
  blocked_by: [P1-T03]
  criteria:
    - Lists upstream commits since synced_commit that touch a mapped path, and ignores reviewed ones
    - The check passes in the test suite against the cached fetch
- key: P1-T04
  title: Job Object supervision with run-owned output
  phase: P1
  blocked_by: [P1-T03]
  criteria:
    - Every descendant is a job member and breakaway is refused
    - A stop ends the whole tree within the 10 s grace; dropping the executor's handles leaves the run running
    - Output goes to files owned by the run
- key: P1-T05
  title: Every spawn hidden
  phase: P1
  blocked_by: [P1-T04]
  criteria:
    - No job member owns a visible window, including cmd wrappers and the console-ctrl helper
    - A cmd wrapper gets arguments with spaces and & exactly
    - The executor starts processes only through sys-windows spawn
- key: P1-T17
  title: Footprint by private bytes
  phase: P1
  blocked_by: [P1-T04]
  criteria:
    - Footprint counts commit, not working set, summed over the run tree
    - The reported peak is exact even between samples
- key: P1-T06
  title: Start-gate admission with AIMD
  phase: P1
  blocked_by: [P1-T17]
  criteria:
    - A memory hold reports Delayed(memory) and admits once memory fits; admission never refuses
    - The AIMD window halves on high CPU and grows by one under headroom
- key: P1-T12
  title: isolation/none
  phase: P1
  blocked_by: [P1-T04]
  criteria:
    - Only allowlisted variables reach the child
    - A missing or relative cwd is an environment failure
- key: P1-T07
  title: Protocol Hello, features and seq
  phase: P1
  blocked_by: [P1-T03]
  criteria:
    - Every message fixture round-trips in Rust and validates in TypeBox
    - Unknown message types and event kinds are ignored; a bad known message answers DR150
- key: P1-T10
  title: Machine pairing and executor session
  phase: P1
  blocked_by: [P1-T07]
  criteria:
    - A pairing code works once, expires after 10 minutes, and five failures lock pairing for 10 minutes
    - The machine token is stored only as its SHA-256 and revoke closes the live session
    - A second session for the same machine replaces the first
- key: P1-T38
  title: Run record (job types, jobs, runs, steps, delays, failure classes)
  phase: P1
  blocked_by: [P1-T10]
  criteria:
    - A run records each timeline stamp; derived durations are never negative under clock skew
    - Failure class follows the job type rules and built-in memory codes; unknown failures are unclassified
    - A retry is a new run of the same job with the next attempt number
- key: P1-T40
  title: Executor store and outbox replay
  phase: P1
  blocked_by: [P1-T10, P1-T38]
  criteria:
    - Events survive an executor restart and are replayed in order after reconnect, applied once
    - Env values never reach the executor store
- key: P1-T39
  title: Direct dispatch and the executor run loop
  phase: P1
  blocked_by: [P1-T38, P1-T40, P1-T06, P1-T12, P1-T05]
  criteria:
    - Dispatch to an offline machine answers DR350 and writes nothing
    - An offer reports Admitted, RunStarted and RunFinished in seq order, hidden
    - Stop while the run waits in the start-gate never spawns it
- key: P1-T09
  title: Log segments
  phase: P1
  blocked_by: [P1-T39]
  criteria:
    - Segments ship through the outbox, are stored and indexed by run and seq, and read back by cursor
    - Segments older than the retention are pruned with their files
- key: P1-T11
  title: Orphans
  phase: P1
  blocked_by: [P1-T39]
  criteria:
    - After an executor restart a surviving run is reported orphaned and never re-adopted
    - The kill policy ends the orphan's tree
- key: P1-T14
  title: OpenTelemetry exporter, off by default
  phase: P1
  blocked_by: [P1-T39]
  criteria:
    - Without an endpoint no exporter is loaded or built
    - With an endpoint, control plane and executor spans of one run share a trace id
- key: P1-T42
  title: Executor login service, end-to-end proof and footprint budgets
  phase: P1
  blocked_by: [P1-T09, P1-T11, P1-T14, P1-T37]
  criteria:
    - The executor runs as the DevRoundsExecutor scheduled task under its supervisor
    - pnpm e2e passes for the synthetic job and pnpm lint, hidden and supervised
    - pnpm footprint passes on the installed services after 60 s idle
```
