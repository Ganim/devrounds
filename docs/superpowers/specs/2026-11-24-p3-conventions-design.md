# DevRounds P3 Project conventions — design

Status: written 24/11 by Claude; Guilherme reviews after the fact (he asked on 17/11 not to wait for approval). Parent
spec: `C:/Users/Guilherme/Code/Clickmax/cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md` ("the
spec", §5.6, §9 step 3, §12 "Conventions for existing projects", §15). P2 design: `2026-11-23-p2-gates-design.md`. This
document records only what P3 settles on top of them.

Roadmap (24/11): P3 goal "DevRounds reads a codebase, records its conventions with evidence and checks them as a gate";
tasks P3-T01 extraction with evidence, P3-T02 generated README and AGENTS docs with human approval of rule changes,
P3-T03 `conventions` gate, P3-T04 conventions on Clickmax and DevRounds; phase criteria: the gate runs on Clickmax and
on DevRounds, rule changes in generated docs reach the repo only after human approval, final review.

## 1. What exists today (inventory, 24/11)

**Clickmax monorepo.** Conventions live as prose for agents, spread over:

- Root `AGENTS.md` (103 lines: engineering rules, writing style, 12 "Mandatory rules", execution cadence) and 18 tracked
  scoped `AGENTS.md` files (1517 lines total; `models/`, `pages/docs/`, `web/user/`, workers...), each with a
  `CLAUDE.md` pointer.
- 55 skills under `.agents/skills/` (5379 lines of `SKILL.md`), several of them pure convention catalogues
  (`code-style`, `backend-patterns`, `frontend-patterns`, `database-patterns`, `writing-tests`, `dark-mode-pairing`).
- 25 commands in `.claude/commands/`. `self-copilot.md` (342 lines, 28 check sections) is the mechanical pre-PR pass:
  i18n keys, `any`, schema-derived types, `ownerId`, `throw new Error` in routes, `Type.Union([Type.Literal...`,
  `console.log`, `dangerouslySetInnerHTML`, migration order, duplicated blocks, log context, `satisfies`, plus one
  script (`test-cost-guard.sh`). Most items are instructions an agent applies by reading the diff, not programs.
- The Kodus review bot (`kody-ai`) with custom "kody rules" configured outside the repo.
  `.claude/scripts/kody-scoreboard.sh` measured on 03/08: 2.37 bot comments per PR, 80 % of PRs with at least one, and
  **~61 % of violations were of rules self-copilot already covers**. Its own conclusion: a textual check that exists
  and does not catch is an execution failure; make it mechanical instead of adding rules.
- Agent memory (`~/.claude-clickmax/.../memory`, 1006 files, 462 `feedback_*`): private to one machine and one user,
  not in the repo, and full of conventions ("identifiers always English", "test outside `test/` breaks the CD").
- Machine-checked today: biome (shared config), TypeScript, knip, tests. None of the prose rules is linked to a check,
  and nothing says which rule a red check enforces.

**DevRounds.** `AGENTS.md` (67 lines: 11 "Never", ~15 "Always", 4 accepted exceptions), changed only with Guilherme's
approval together with `MANIFESTO.md`. Several invariants are already enforced by meta-tests: `no-sync.test.ts`,
`no-suppressions.test.ts`, `executor-guards.test.ts`, catalog guards (`test-support/catalog.ts`: RLS policy and FK
indexes), `errors.test.ts`, `agent-docs.test.ts` (every `devrounds ...` quoted in AGENTS.md parses), clippy
`-D warnings`. Others are not: "no vendor, customer or tool name in engine code" has no check (`runs/learned-need.ts`
names devlanes in a comment today).

**What P2 gives P3.** Gates (one batch per worktree, lock, `gate run --wait`, failures first), job `args`/`env`, the
result cache, finding tasks by `source_key` (`POST /findings`), the improvement report, DevRounds's own gate
(`roadmap/fixtures/gates/devrounds.yaml`). Jobs that call the CLI with `DEVROUNDS_URL`/`DEVROUNDS_TOKEN` from the
machine (`improvement-report`, `devlanes-sync`) are the pattern P3 reuses. There is no `vcs` engine yet; the control
plane never reads a repo (spec §11.1).

## 2. Calls (24/11, Claude)

Each with its cost if wrong.

1. **The control plane never reads the repo; reading happens in CLI commands run in the worktree** (as jobs on the
   executor or by an agent in its session): `conventions check`, `render`, `verify`, `candidates`, and `propose
   --cwd`. Same split as P2 call 1. Cost if wrong: none structural; a cloud executor runs the same commands.
2. **The record is a versioned document in the control plane, not rows per rule.** A version is one immutable document
   (rules, facts, targets), validated by a TypeBox schema like plan and gate files; changes are new versions, and the
   diff between two versions is computed. Listing, diffing and exporting a document are what manifesto §5 asks for.
   Cost if wrong: a normalized rules table later, backfilled from the documents.
3. **Agents propose, only human members approve.** `propose` writes a version in state `proposed`; `approve` and
   `reject` answer DR453 to an agent token. Approval is through the CLI with a human token: a session cookie only
   reads (DR402) and P3 does not change that. The web view shows versions and the open proposal's diff, read-only.
   Cost if wrong: approvals wait for Guilherme at a terminal; a web approve button is a P5 change behind its own review.
4. **One open proposal per project, based on the active version.** A proposal records the version it was based on;
   approving it after another version became active answers DR310 (propose again from the new base). A second
   `propose` while one is open answers DR311 unless `--replace`, which withdraws the open one. Cost if wrong: parallel
   proposals need a merge step; nothing in P3-P4 needs two at once.
5. **Every proposal names its task** (`--task <key>`, manifesto §1). Approval and the version history are the rows
   themselves (who proposed, who decided, when, why); no plan events. Cost if wrong: events backfilled from the rows.
6. **The repo carries only rendered output.** `render` writes, for the active version only, fenced blocks
   (`<!-- devrounds:conventions begin version=N sha256=... -->` ... `end`) into target files the document names
   (`AGENTS.md`, `README.md`, scoped `AGENTS.md`); text outside the blocks stays hand-written. The conventions check
   renders the active version and compares byte for byte (`docs_drift`, always blocking): a hand edit inside a block,
   or a render of a version that was never approved, fails the gate. This is how "rule changes reach the repo only
   after human approval" is enforced, not trusted. Cost if wrong: whole generated files later, from the same render.
7. **Every item names its target file explicitly** (default: the first target). No inference of the nearest scoped
   `AGENTS.md` from globs (manifesto §11). Cost if wrong: a few `target:` lines to write.
8. **Four check kinds.** `pattern`: a regex the added lines of matching files must not contain (`forbid`, with an
   optional `unless` on the same line). `path`: new files matching a glob are refused (`forbid_new`). `job_type`: the
   rule is enforced by an existing check job type (biome, knip, a meta-test), named in `enforced_by`; the conventions
   check does not rerun it, `verify` checks the job type exists. `judgment`: no mechanical check in P3, rendered for
   agents and reviewed by an agent lens in P4. The share of non-judgment rules is an indicator, the kody-scoreboard
   lesson made visible. Cost if wrong: another kind later (AST queries), same document.
9. **Diff-scoped: only added lines and new paths are checked.** "Is my change within this project's patterns" without
   failing on legacy code (Clickmax has years of it). Cost if wrong: legacy violations stay invisible; an `--all`
   audit mode later.
10. **The checker reads a unified diff on stdin; the job type produces it.** `git` stays in repo data (the job type's
    command), out of `control-plane/src` (AGENTS.md: no tool names in engine code). The base is a job arg. Cost if
    wrong: when the `vcs` engine lands, the job type changes and the checker does not.
11. **Pattern rules carry examples.** `examples.bad` must each match and `examples.good` must not; propose refuses a
    rule whose examples fail (DR101 at the example's path). The rule tests itself (manifesto §10). Cost if wrong:
    friction writing rules, paid once per rule.
12. **Severity per rule, `warn` by default.** `warn` prints and passes, `block` fails the check. Promoting a rule to
    `block` is a rule change (human approval). No inline waivers: a false positive is fixed by changing the rule, as
    AGENTS.md already says for lint ("never suppress a lint rule inline"). Cost if wrong: noisy warnings until promoted
    or fixed.
13. **Evidence is repo text, verified.** Each rule and fact carries 1-20 evidence entries `{path, excerpt, line?, role:
    source | example}`; `excerpt` (≤ 300 chars) must occur in the file at `--cwd` when `propose` runs (the CLI
    verifies, and sends the head sha the caller gives with `--head-sha`, as `gate run` does). Private agent memory
    is never evidence. A daily `verify`
    job on the default branch opens one finding per rule whose evidence vanished (`conventions:evidence:<rule key>`,
    P2 findings). Cost if wrong: the server trusts the caller's verification like it trusts `head_sha` in gates; the
    daily verify and human approval catch a lie.
14. **Extraction in P3 is an agent procedure plus a generic helper, not an LLM call in the control plane.**
    `docs/conventions/extract.md` is the procedure (read instruction files, layout and code; write the document with
    evidence; prefer mechanical checks; propose). `devrounds conventions candidates --cwd` lists imperative lines
    (`Never`, `Always`, `MUST`, `NEVER`, bullets under such headings) of the markdown files matched by globs, with
    `path:line`, so an agent starts from what the repo already states. In P3 the agent is a session using the CLI, as
    today; in P4 the same procedure becomes an agent-run job type. Cost if wrong: none; P4 swaps who runs it.
15. **Check results are recorded per run.** The checker posts `{runId, version, violations, filesChecked}` with
    `DEVROUNDS_RUN_ID` (`convention_checks`), so indicators can say which rule fires, blocks or never fires. A column
    `source` (`mechanical` now, `review` reserved for P4's judgment lens) keeps one table for both. Cost if wrong: one
    more table in P4.
16. **DevRounds goes first, Clickmax second.** DevRounds's AGENTS.md "Never"/"Always" become rules (meta-tests become
    `job_type` rules with `enforced_by: devrounds-test`, the vendor-name rule becomes a `pattern`); version 1 is
    Guilherme's approval of that AGENTS.md change (AGENTS.md requires it). Clickmax starts from root `AGENTS.md`
    "Mandatory rules" and the mechanical subset of self-copilot, rendered into one block of root `AGENTS.md`, through
    a monorepo PR (Linear card, cx-env queue, `/ship`). Self-copilot's matching checks are switched off only after
    the conventions check runs green in the Clickmax gate for two weeks (strangler, spec §9). Cost if wrong: duplicate
    checks for two weeks.

## 3. Data model (migration 0023)

Every P1 rule holds: `tenant_id uuid not null`, RLS forced through `isolate()`, composite FKs with indexes, DR201 for
cross-tenant.

```
convention_sets
  id, tenant_id, project_id, version int (unique per project, 1..), state proposed|active|superseded|rejected|withdrawn,
  document jsonb (the validated file), document_sha text, based_on int null (active version at propose time),
  head_sha text null (what the CLI verified evidence against), task_id (the task that asked),
  proposed_by member, proposed_at, decided_by member null, decided_at null, reason text null
  unique (tenant_id, id); unique (project_id, version)
  partial unique (project_id) where state = 'active'; partial unique (project_id) where state = 'proposed'
  check: (decided_at is null) = (decided_by is null); proposed and withdrawn have no decision; active, superseded
  (once active) and rejected have one

convention_checks
  id, tenant_id, project_id, run_id (unique), set_id, source mechanical|review, files_checked int,
  blocking int, warnings int, violations jsonb (≤ 500 kept; counts are exact), created_at
```

Document (`conventions/file.ts`, YAML for `propose`, JSON in the API):

```yaml
targets: # files with a generated block, in render order
  - path: AGENTS.md
  - path: README.md
rules:
  - key: engine.no-tool-names # ^[a-z0-9][a-z0-9.-]{0,99}$, unique
    section: Never # heading inside the block, in first-seen order
    title: Never put a vendor, customer or tool name in engine code
    why: Providers are adapters; a name in the core forks it for the second customer.
    target: AGENTS.md # optional, default targets[0]
    paths: [control-plane/src/**/*.ts]
    exclude: ["**/*.test.ts"]
    check: { kind: pattern, forbid: '\b(clickmax|devlanes|pnpm)\b', flags: i } # JS RegExp, flags from [imsu]
    severity: warn # warn | block
    examples: { bad: ["// devlanes default"], good: ["// default need"] }
    evidence:
      - { path: AGENTS.md, excerpt: "Never put a vendor, customer or tool name in engine code", role: source }
facts:
  - key: layout.control-plane
    section: Layout
    text: "control-plane/: the TypeScript control plane (Fastify, Kysely, Postgres)."
    target: README.md
    evidence: [{ path: control-plane/package.json, excerpt: '"fastify"', role: example }]
```

Limits: 500 rules, 200 facts, 20 targets, 20 evidence per item, regex ≤ 1000 chars (compiled at propose), document
≤ 1 MB.

## 4. API and CLI

```
GET  /api/projects/:p/conventions                    active version + open proposal (summary)
GET  /api/projects/:p/conventions/:version           the document and its state
GET  /api/projects/:p/conventions/:version/diff?against=<n|active>
POST /api/projects/:p/conventions/proposals          {document, basedOn, headSha, task, replace?}   (Idempotency-Key)
POST /api/projects/:p/conventions/:version/approve   {reason?}  human only (DR453)
POST /api/projects/:p/conventions/:version/reject    {reason}   human only (DR453)
POST /api/projects/:p/conventions/checks             {runId, version, source, filesChecked, violations}
GET  /api/projects/:p/indicators/conventions?period=day|week

devrounds conventions show [--version <n>] [--paths <a,b>] [--json]     rules that apply to the paths, agent mode
devrounds conventions export [--version <n>]                            YAML, re-proposable
devrounds conventions propose <file.yaml> --cwd <repo> --task <key> [--head-sha <sha>] [--replace]
devrounds conventions diff <version> [--against <n>]
devrounds conventions approve <version> [--reason <text>]               human token
devrounds conventions reject <version> --reason <text>                  human token
devrounds conventions render --cwd <repo> [--check]
devrounds conventions check --cwd <repo> --diff -                       in a gate; failures first, exit 1 on block
devrounds conventions verify --cwd <repo> [--open-tasks]                stale evidence, missing enforced_by job types
devrounds conventions candidates --cwd <repo> [--glob <g>]...
devrounds indicators --conventions
```

New codes: DR310 `Proposal {version} is based on version {basedOn}, but version {active} is active.` (409); DR311
`Proposal {version} is open for project {project}.` (409, hint `--replace`); DR312 `Run {run} is {state}; a check
result needs a running run.` (409). New not-found kind `conventions`. Human-only reuses DR453.

## 5. How P4 consumes it

- **P4-T03 `/work` and `/ship` as job types.** The agent reads `devrounds conventions show --paths <changed files>`
  (the rules of its paths, judgment ones included, within the 16 KiB budget) instead of the whole skill corpus; the
  gate it runs includes the conventions check.
- **P4-T03/T10 review step.** A reviewer lens checks `judgment` rules on the diff and posts to the same
  `POST /conventions/checks` with `source: review`, so mechanical and judgment hits share indicators.
- **P4-T10 task-to-pr.** A rule change is a task: the agent proposes, a human approves, the PR carries the render.
- **P4-T11 webhooks.** A merge on the default branch queues `verify` and, when files under rule paths changed, the
  extraction job; both answer through findings and proposals, never by editing the record.
- **P4-T14 correction loop.** Stale-evidence findings and noisy rules (indicator) are worked by agents like any finding.
- **Extraction job type.** `docs/conventions/extract.md` runs as an `agent-runtime` job with the same `propose` call.

## 6. Stages

- **Stage 1 — engine and DevRounds (this repo only):** document schema; record, proposals and human approval; evidence
  verification and `verify`; `candidates` and the extraction procedure; render and drift; the checker; check results and
  indicators; read-only web page; DevRounds's own record, rendered into its AGENTS.md and checked in its gate; an e2e
  scenario; stage review.
- **Stage 2 — Clickmax:** extraction on the monorepo (Clickmax project), version 1 approved by Guilherme, rendered into
  root `AGENTS.md` and the `conventions` check added to the Clickmax gate file, all as monorepo PRs through `/ship`;
  daily `verify` scheduled on the monorepo; after two weeks green, the matching self-copilot checks switched off. Needs
  the Clickmax gate on DevRounds (P2-T01, P2-T05). Measure: the kody-scoreboard ESCAPE count for rules the record
  covers mechanically, before and after.

## 7. Left to the builder

Exact migration shape; glob matching (Node's `path.matchesGlob` if stable on the pinned Node, else a small matcher;
a dependency only if neither works); the unified-diff parser details (renames, binary files, CRLF); the render layout
(one line per item or wrapped, section order); the `candidates` heuristics; the web page layout; task order inside
stage 1.

## 8. Open question (Guilherme's call)

1. **Start P3 stage 1 before P2 is delivered?** P3 is `blocked_by: P2` as a phase, so every P3 task answers DR304
   until P2 closes, and P2's open tasks are mostly Clickmax stage 2 (T01, T04, T05, T06, T08, T09, T15, T16) plus
   T22, T23, T25, T27, T28. Stage 1 of P3 needs only P2 stage 1 (gates, findings, job args). Proposal: replace the
   phase edge with task edges (P3 stage-1 tasks `blocked_by: P2-T23`, P3-T04 `blocked_by: P2-T05`). Reordering phase
   dependencies is his call (spec §15).
