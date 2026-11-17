# DevRounds P1 Foundation — design

Status: draft for Guilherme's approval (P1-T01). Parent spec:
`cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md` (referred to as "the spec"). This document only
records what P1 changes or settles on top of the spec; everything else in the spec stands.

## 1. Intent

P1 makes DevRounds able to run work: a Rust executor on Guilherme's machine dials out to the control plane built in P0,
receives jobs from queues, runs them as hidden, supervised processes within a memory start-gate, and reports every run
back. Gates (P2) are the first workload built on it. P1 ends when a job runs end to end on the executor and both
processes stay within their idle budgets (roadmap P1 exit criteria: executor ≤ 50 MB private bytes idle, control plane
≤ 300 MB idle, a job runs end to end with every spawn hidden and supervised, final whole-phase review passed).

Why now: cx-env's failures are foundation failures (spec §1). Nothing in P2-P7 can move until jobs run on a foundation
that does not orphan processes, open windows or overcommit memory.

## 2. Decisions confirmed (Guilherme, 17/11)

- **Spec §11, all ten calls, unchanged**: gates run in the handed-over worktree under a per-worktree lock; `depends_on`
  DAG inside a gate; replay-then-switch cut-over with fallback only on DevRounds infra errors; executor owned by one
  tenant, running any of its projects; log segments owned by the run; executor keeps admitted runs and buffers events
  while the control plane is down; no secret store in P1; devlanes off the critical path; wall time ≤ baseline +10%;
  agents call through the CLI in agent output mode.
- **Everything is measured, and the measurements drive improvement** (new, §3).
- **Reuse devlanes code by copying** (new, §4).

## 3. Execution record and the improvement loop

Guilherme (17/11): "a gente tem que ter o registro de tudo: todas as etapas, quanto cada etapa falha, os erros, por que
falhou e quanto tempo demorou … um diário de melhoria, em que ele vai avaliar aquilo e corrigir automaticamente todos
os problemas, para tentar sempre ter o menor tempo possível para execução de tarefas."

### 3.1 What is recorded (P1)

Every run, from day one, in Postgres (tenant-scoped, RLS like every other table), linked to its job, job type, project,
machine and, when there is one, its task:

- **Timeline**: `queued_at`, `offered_at`, `admitted_at`, `started_at`, `finished_at`. Derived durations: queue wait,
  admission delay (start-gate), run time, total. Delays reported by the executor (`Delayed`) are kept with their reason
  (memory, concurrency window).
- **Steps**: a run may report named steps inside it (an agent's phases in P4, sub-steps of a long check) with the same
  timeline and outcome per step, so "which step is slow / fails most" is a query, not a log search. A gate's checks are
  not steps: each check is its own job with `depends_on` edges (spec §5.5, §11.2), so it gets its own run record.
- **Outcome**: `finished | failed | stopped | orphaned`, exit code, and a **failure class** from a closed list:
  `check_red` (the work itself failed: test, lint), `environment` (missing dependency, DB/lane down, bad env),
  `timeout`, `memory` (the process died out of memory: commit failure or OOM exit; P1 sets no per-run cap and admission
  never refuses, spec §5.1), `infra` (DevRounds itself: executor, protocol, control plane),
  `cancelled`. Unknown failures are `unclassified`, and their count is itself an indicator. Classification rules live in
  the job type (patterns over exit code and log tail), not in the executor.
- **Why**: a failure summary (first relevant lines, bounded) and the log cursor that leads to the full output.
- **Resources**: peak and p95 private bytes, CPU, from the executor's sampling (spec §5.2), which also update the
  learned need.
- **Attempts**: retries are separate runs of the same job, so "how often does X need a retry" is countable.

OpenTelemetry traces (spec §14) carry the same timeline across control plane and executor; the Postgres record is the
source for indicators, the traces are for drilling into one run.

### 3.2 What reads it

- **P1**: the minimal operational view shows runs with their timeline, class and summary; the balance gains queue wait,
  run time p50/p90 per job type, failure rate per class (spec §13 resources and queue times move here too).
- **P2 — daily improvement report**: a scheduled job (DevRounds runs it on itself) compares the last calendar day with
  the previous seven: slowest steps, steps whose time grew, top failure classes and their examples, retry counts,
  `unclassified` share. Each finding becomes a task in the roadmap with the evidence attached, deduplicated against open
  ones. No code is changed automatically yet.
- **P4 — automatic correction**: once DevRounds runs agents, the same loop dispatches an agent per finding, which works
  it like any task (worktree, gates, review). The loop then measures the same indicator over the following days; if the
  change did not improve it, it opens a revert. Every action lands in the plan history.

Correction before P4 would mean running agents outside DevRounds, which is what P1-P4 replace.

## 4. Reusing devlanes code

devlanes (Apache-2.0, Arthur Fiorette; Guilherme's fork `github.com/Ganim/devlanes`) already solves most of the
executor's process layer. Guilherme approved reuse (17/11) by **copying** the needed crates into `executor/` (option 1 of
three; the others were a git dependency on the fork, which drags devlanes' lane model and breaks on its internal changes,
and extracting a shared library with Arthur, which blocks P1 on him).

- Source commit: `e2e4f1ca` (16/11/2026). devlanes files carry no per-file headers, so `executor/` ships a copy of the
  Apache-2.0 license and `executor/NOTICE` lists the origin, commit and what was changed in each crate.
- Candidates: `sys-windows` + `sys` (Job Objects, hidden spawn, process identity), `runner-windows` + `runner-pty`
  (spawn/stop, ConPTY, staged stop), `start-gate` (memory start-gate), `metrics` + `metrics-windows` (sampling), `logs`
  (segments). Not reused: `proto`, `transport`, `state` (DevRounds' protocol is executor-dials-out with jobs/runs,
  spec §5.3).
- Copies are adapted to DevRounds' model (jobs/runs, no lanes); lane-specific parts of `devlanes-core` are dropped, not
  carried.
- **No upstream update is lost** (Guilherme, 17/11: "o código deles atualiza, e a gente não podia perder a
  atualização"). `executor/devlanes-sync.toml` maps each copied crate to its upstream path and the upstream commit it
  was last synced to. A check (`pnpm devlanes-sync`) fetches `devlanes-run/devlanes`, lists every upstream commit since
  that point that touches a mapped path, and exits non-zero when any is unreviewed. Each listed commit is either ported
  (its diff applied by hand to our copy) or marked not applicable with a reason; both advance the recorded commit in the
  same change. In P1 the check runs in the test suite against a cached fetch and on demand; from P2 it runs daily as a
  DevRounds job and opens a roadmap task per pending upstream change, and from P4 an agent does the port.

## 5. Build vs adopt (P1-T02 spike)

With the process layer settled by §4, the spike covers what is left from spec §14: the durable queue/scheduler
(Hatchet, pg-boss, Graphile Worker, DBOS against an own scheduler on the P0 Postgres) and Better Auth for session
login. Criteria: license (MIT/Apache/MPL), RAM at idle against the 300 MB budget, fit with RAM-aware placement and the
executor-dials-out protocol, and fit with the P0 schema (RLS, composite tenant FKs). The spike ends with a recommendation
Guilherme approves before the scheduler is written.

## 6. Roadmap changes this design makes

- P1: the run record of §3.1 is part of "Queues, jobs, runs and learned_needs" (P1-T08) and the indicators task
  (P1-T18), with failure classes as acceptance criteria.
- P2: new task "Daily improvement report" (§3.2).
- P4: new task "Automatic correction loop with measured revert" (§3.2).
- P1-T03 ("Rust executor skeleton") starts from the copied crates (§4).

The P1 implementation plan replaces P1's coarse tasks (spec §15) and keeps the review-carry tasks P1-T19..T36.

## 7. Calls made after the builder check (17/11, Claude)

1. **Plan in two stages.** The first P1 plan covers the spike and everything that does not depend on its outcome: the
   executor (copied crates, Job Object supervision, hidden spawn, start-gate + AIMD, metrics, log segments, protocol
   `Hello`), machine pairing and the run record of §3.1. Queues, scheduler, placement and outbox are planned after the
   spike's recommendation is approved, as a re-plan of the same phase.
2. **Windows only in P1.** The `core` traits keep the OS boundary (spec §5.2), but only the Windows adapters are built;
   `runner-pty` is copied only for ConPTY. Linux adapters arrive with the first Linux machine (P6, VPS/cloud).
3. **No hard memory cap per run in P1.** Admission waits (spec §5.1); offers not admitted in time go back to the queue.
   The `memory` class records out-of-memory deaths, and admission delay is recorded with its reason.
4. **OpenTelemetry: exporter only, off by default**, sending OTLP to an endpoint set in config. No collector or trace
   viewer runs in P1, so nothing counts against the 300 MB budget.
5. **Log segments** live on the control plane's local disk (`~/.devrounds/logs/runs/`), indexed in Postgres by run and
   seq cursor, pruned after 14 days (configurable). An object store comes with the `storage` engine.
6. **End to end** is proven with two jobs on DevRounds itself: a synthetic job (spawns a child tree, prints, exits) for
   supervision and orphan checks, and DevRounds' own `pnpm lint` for a real toolchain spawn through `cmd` wrappers. The
   worktree lock, env allowlist from `.env` files and Clickmax job types stay in P2.

## 8. Left to the builder

Exact table shapes for runs/steps/failure classes, the classification rule format in job types, the report's job type
definition, how much of each devlanes crate is kept, and task decomposition and order in the P1 plan.
