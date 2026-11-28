# DevRounds P7 Blueprints and code node — design

Status: written 28/11 by Claude; Guilherme reviews after the fact (he asked on 17/11 not to wait for approval). Decisions
marked **[security]** change what code runs where, what a credential may write, or what the control plane reads; the
phase review reads them first. Parent spec: `C:/Users/Guilherme/Code/Clickmax/cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md`
("the spec", §5.6 engines and providers, §12 code node, blueprints and code viewer, §14 isolation). P3 conventions
design (`2026-11-24-p3-conventions-design.md`: versioned documents, fenced render blocks, human approval). P4 design
(`2026-11-28-p4-agent-runs-design.md`: vault and grants T01, hub T02, artifacts T07, GitHub App T11, flow engine
T16). P5 design (`2026-11-28-p5-interface-design.md`: app shell T09, flow editor node catalog). P6 design
(`2026-11-28-p6-cloud-tenant-design.md`: container isolation T03, workspaces T12).

Roadmap (28/11): P7 goal "Projects start from blueprints; flows run code"; tasks P7-T01 blueprints, T02 pre-built
modules (login first, after T01), T03 code node, T04 code viewer editor provider. Phase criteria: a new project starts
from a blueprint with the login module; final review. Phase edge: blocked by P6.

## 1. What exists today (inventory, 28/11, main at `efc601f`)

Paths are relative to `control-plane/src` unless they start with `executor/`.

- **No blueprint, module, code node or editor code.** The nearest pieces: `conventions/render.ts` renders fenced
  blocks into `AGENTS.md` and checks them for drift (P3); `planning/import.ts` and `planning/plan-file.ts` import a
  plan file into a project; `job-types/file.ts` validates job type YAML (`key`, `command`, `env`, `args_from_job`,
  `job_env`, `env_set`, `need_mb`, `timeout_s`, `orphan_policy`, `classify`, `retry`).
- **Projects are created by the operator only** (`admin.ts` `project add`); there is no member route that creates a
  project, and nothing writes to a repository.
- **"The control plane never reads the repository"** is a working rule today: everything it knows about code comes
  from runs (logs, results, P4 artifacts). Jobs take an absolute `--cwd` on a machine (`JobSpec.cwd`,
  `executor/crates/core/src/job.rs`); P6-T13 adds `workspace: {repo, ref}`.
- **Run results**: a run ends with an exit code, a failure class (`runs/classify.ts`: `check_red`, `environment`,
  `timeout`, `memory`, `infra`, plus `cancelled`, `unclassified`; P4 adds `stalled`, `no_outcome`, `limit`) and, from
  P4-T03, `devrounds run result` text. No structured output travels back in the protocol; executor messages are capped
  at 4 MiB (`MAX_PAYLOAD`, `executor/gateway.ts:42`).
- **Isolation**: `NoneIsolation` only (`executor/crates/executor/src/isolation.rs`); P6-T03 adds `container`.
- **Web**: `web/src` is flat today; P5 moves it to the layered shell (P5-T09) with the flow editor and its node
  catalog.
- **Convention rule** `engine.no-tool-names` (`roadmap/conventions/devrounds.yaml:141`) forbids vendor and tool names
  in `control-plane/src` outside `providers/**` (P4 exclusion).

Numbers: migrations on main end at `0028`; P4 reserves `0029-0051`, P6 `0060-0079`; P7 uses `0080-0089`. Codes in use
or reserved through P6: DR101, 103-106, 150-154, 201-203, 301-316, 319, 350-354, 401-403, 450-455, 501-506, 550-554, 556.
P7 takes DR107, DR317, DR318, DR355, DR557.

## 2. Decisions (28/11, Claude)

Each with why and its cost if wrong.

### A. Blueprints (T01)

1. **The catalog is files in the DevRounds repository, not a table.** `blueprints/<key>/blueprint.yaml` (manifest:
   key, version, title, options, modules, the files it installs into DevRounds) plus `blueprints/<key>/template/` (the
   repository tree). Shipped with the control plane image; validated by a TypeBox schema at load. A catalog table would
   need a `tenant_id` (catalog guard) for data that belongs to no tenant. A meta-test renders every blueprint × option
   × module combination and runs the rendered repository's own checks in the test (biome, type check, `node --test`),
   so a template that does not build cannot ship. Cost if wrong: tenant-authored blueprints later need a table and the
   P3 review flow; the file format is what they would store.
2. **One blueprint in P7: `web-app`, on DevRounds's own stack.** Fastify, Kysely, Postgres 17, TypeBox, React 19 built
   with esbuild, `node:test`, biome, Docker Compose for the local database. One option, `web: react | none`. Why: it is
   the stack DevRounds has proven on itself, and the login module (§B) is a copy of DevRounds's own auth, so the first
   blueprint can be checked against working code instead of a guess. Cost if wrong: a second stack is another folder
   with the same manifest.
3. **Rendering is plain substitution.** A closed set of variables (`{{project_key}}`, `{{project_name}}`,
   `{{package_scope}}`, `{{db_name}}`, `{{web}}`) in file contents and paths; an option selects whole files through the
   manifest (`when: {web: react}`), never conditionals inside a file. An unknown variable fails the meta-test. The
   rendered `AGENTS.md` carries a fenced `devrounds:modules` block (the P3 render mechanism) listing installed modules,
   drift-checked like the conventions blocks. Cost if wrong: a template that needs logic gets a second file per option.
4. **[security] `devrounds project new` is human only and writes only to an empty repository.** `devrounds project new
   --key <k> --name <n> --blueprint web-app --repo <owner/name> [--option web=react] [--module login]`. An agent token
   gets DR453. The repository must exist, have the DevRounds GitHub App installed (P4-T11) and contain no commits, or
   DR318 `Repository {repo} is not empty.` DevRounds never creates a repository (the App would need `administration`
   permission on the account, which is far wider than any other call needs). Cost if wrong: one manual "create empty
   repo" step per project.
5. **[security] The initial commit goes through the vcs provider's Git Data API, by the control plane.** Blobs, one
   tree, one commit, then the default branch ref, as the App installation. This needs App permission `contents: write`,
   added to the App manifest as a reviewed change (P4 §2.G 34 lists today's permissions; the manifest test is updated).
   The control plane uses it only for (a) the first commit of an empty repository and (b) branches named
   `devrounds/*` (§B 9); a test on the provider client refuses any other ref. Why the control plane and not a run: an
   empty repository has no checkout to run in, and a machine would need a write credential for one commit. Cost if
   wrong: an App credential leak can write to `devrounds/*` branches and empty repositories; branch protection on the
   default branch still blocks merges without review.
6. **`project new` sets up DevRounds for the project in one transaction, after the commit lands.** It creates the
   project row; imports the blueprint's plan (`planning/import.ts`); sets its job types, the gate and queues
   (`job-types/file.ts`, the gate fixture format); creates conventions v1 from the blueprint's rules, approved by the
   calling human (P3 rule: approval is human, the caller is one); installs its flows (P4-T16 documents); and records
   `project_blueprints` (blueprint key, version, options, commit sha). Then it queues the gate on the new commit
   through a workspace (P6-T13), and the command waits for it with the usual run output. The phase criterion is that
   gate going green with the login module installed. Cost if wrong: a failure after the commit leaves a repository with
   a commit and no project; the command is re-runnable with `--adopt` (the repository's single commit must match the
   recorded render sha).
7. **The blueprint's principles are conventions, not prose.** Layer boundaries (`routes → services → db`, `web`
   imports only from `api` types) become conventions rules plus a boundaries meta-test inside the template, the way
   DevRounds checks itself. Cost if wrong: none beyond the rules themselves.

### B. Modules (T02)

8. **A module is a folder with a §5.6 manifest.** `blueprints/<key>/modules/<id>/module.yaml` (id, version, title,
   requires (modules), options, files, migrations, routes, env names, conventions rules it adds) plus its files. Modules
   install in manifest order; a module never edits a file another module or the blueprint owns, it adds files and one
   registration line in a marked block (`// devrounds:modules routes`), so installing is additive and removal is a
   later concern. Cost if wrong: a module that must patch a shared file needs a merge step; none of the P7 modules do.
9. **Adding a module to an existing project opens a pull request.** `devrounds project module add <id>` renders the
   module, reads the tree listing of the default branch through the vcs provider (paths and blob shas only, never
   contents), refuses if any file it adds already exists (DR317 `Module {module} would overwrite {path}.`), commits to
   `devrounds/module-<id>` and opens a PR with the module's checklist. The project's gate runs on it like any PR
   (P4-T17 pr-round). At `project new` the modules are part of the first commit instead. Cost if wrong: a project that
   moved files gets DR317 and installs by hand from the rendered output (`--dry-run --out <dir>`).
10. **The first module is `login`, a copy of DevRounds's own auth pattern.** Better Auth with email and password, a
    `members` table, session cookies (`__Secure-` over https, read-only cookie by default and guarded writes as P5-T10
    does), rate limit on sign-in, origin check on writes, and the `invite-only | open` signup option (`invite-only`
    default; `open` adds the sign-up page). It is a login for the generated app, not an identity provider for
    DevRounds. Cost if wrong: projects needing OAuth add a module later.
11. **A module DevRounds does not have is an answer, not an error page.** `project new --module x` or `module add x`
    with an unknown id returns DR201 (not-found kind `module`) with a `next:` line `devrounds task add ... "Module x"`
    on DevRounds's own project, so missing modules become roadmap tasks (spec §12). Cost if wrong: none.

### C. Code node (T03, T05, T07)

12. **A new flow node kind `code`, with the source inline.** The node holds `language: ts | js`, `source` (≤ 64 KiB),
    `input_schema` and `output_schema` (JSON Schema), `timeout_s`, `memory_mb`, `network: none | egress`, `secrets`
    (names). The source is part of the flow document, so it is versioned, diffed and reviewed with the flow (P4-T16).
    TypeScript runs through Node's type stripping (no build step). The script `export default async function (input,
    ctx)`; imports limited to `node:*` builtins, checked when the flow is saved (DR107 `Code node {node} imports
    {module}; only node: builtins are allowed.`). Cost if wrong: packages need a lockfile per node, which is a project
    repository, not a node.
13. **It runs as a job, on the machines that run jobs.** Engine job type `devrounds.code-node` (owned by DevRounds,
    not editable by tenants): the flow engine creates a job whose input is written as run files (new feature
    `run-files`: `JobSpec.files [{path, content}]` under the run dir's `in/`, total ≤ 1 MiB) and whose result is
    `out/result.json` (≤ 64 KiB), returned in `RunFinished.result` (feature `run-result`) and validated against
    `output_schema`. An invalid result fails the run with the new failure class `output_invalid` (DR355 `Code node
    {node} returned output that does not match its schema.`); an executor-side result file that is missing, invalid
    JSON or too large is DR557. Retries, logs, learned need and placement are the job system's. Cost if wrong: very
    short nodes pay a job dispatch (about a second); acceptable for flows.
14. **[security] Containers by default.** `devrounds.code-node` declares `isolation: container` with a digest-pinned
    runner image built from `docker/code-runner/` (Node 24 slim, the runner script that loads the module and writes the
    result) and `network: none` unless the node says `egress`. Mode `none` is allowed only on machines a human listed in
    `code_node_policies.native_machines` (tenant-owned persistent machines), and there the runner starts Node with its
    permission model (`--permission`, read on the run dir, write on `out/`); a node with `network: none` is never placed
    in mode `none`, because Node's permission model does not block the network. Cost if wrong: tenants without a Linux
    machine or pool cannot run code nodes until they add one (P6-T02 pools).
    **The sandbox choice includes a spike (T08, controller addition 28/11).** Before T03 fixes the runner,
    T08 compares `rivet-dev/agentos` in embedded mode (Apache-2.0, 0.4.x) against the P6 container runner on the same
    code node fixtures: Windows host support (unverified today), cold start per node, memory per node, whether network
    and filesystem are denied by default, how a node is stopped and its footprint measured, and how far a 0.4.x API is
    likely to move. Decision rule, recorded in the spike's result: agentos becomes a second provider of the `isolation`
    engine for code nodes only if it runs on both Windows and Linux hosts, denies network and host filesystem by
    default, and starts a node at least 5 × faster than a container; the container stays the default either way, and
    the cost of adopting it is a pre-1.0 dependency pinned by version with its own upgrade task. What it would change:
    Windows machines could run code nodes without a Linux machine or pool, which removes the cost above. Cost if the
    spike is skipped: none for safety; code nodes stay Linux-only.
15. **[security] Secrets are granted per node, and the riskiest nodes need a human.** A node lists secret names; each
    needs a P4 vault grant with the new subject kind `flow_node` (flow key + node id), so a secret granted to one node
    is not readable by another node of the same flow. A node that has both secrets and `network: egress` can be saved
    only by a human member (DR453 for an agent); others can be saved by agents through the flow document as today.
    Values reach the container by name only (P6-T03). Cost if wrong: one extra grant per node.
16. **Limits.** `timeout_s` default 60, max 900; `memory_mb` default 256, max 2048 (also the run's declared need);
    input 1 MiB; output 64 KiB. Out-of-range values fail at save (DR101).
17. **Agents can run a snippet through the hub (T07).** Hub tool `code_run` (family `code`, risk `write-internal`):
    `{language, source, input}` → a child run of the calling run, same runner, `network: none`, no secrets, timeout
    ≤ 120 s; returns `result` and the last 4 KiB of the log. Recorded in `hub_calls` like every tool. Cost if wrong:
    agents use their own shell, which they already have on their machine; this tool is for runs in containers.
18. **The flow editor shows the node with a textarea, then the code viewer.** P5's node catalog gets the `code` node
    with fields for schemas and limits; the source field is a monospace textarea until T04 lands, then the `editor`
    component (§D) in edit mode for that field only.

### D. Code viewer (T04, T06)

19. **An `editor` engine with two providers: `editor/monaco` and `editor/deeplink`.** Monaco (MIT) renders files and
    diffs read-only in the web app, and editable only for flow documents and code nodes (§C 18); `editor/deeplink`
    renders "open in" links (`vscode://file/...` for a machine path, the repository's web URL for a ref), configured
    per member. A hosted IDE (openvscode-server) is not in P7. Monaco is a lazy chunk under `web/src/features/code`, in
    both themes (P5 theme tokens). Cost if wrong: Monaco's bundle (about 2.5 MB) loads only on code pages.
20. **[security] The control plane reads committed files to show them, and stores none.** `GET
    /api/projects/:key/code/tree?ref=` and `/code/file?ref=&path=` call the vcs provider with the installation token
    (contents read) and stream the result with `Cache-Control: private, no-store`; files over 1 MiB answer with a
    deeplink. This is a scoped exception to "the control plane never reads the repository": display only, never
    persisted, never sent to a model. Cost if wrong: a member sees files of a repository the App is installed on,
    which every member of the tenant could already open on GitHub through the same installation.
21. **A task's changes = its runs' patches plus the PR compare.** Job types may declare `capture: {before: [...],
    after: [...]}`, command lists the executor runs in the run's cwd before and after the job (feature `capture`;
    for a git project `git rev-parse HEAD` before and `git diff --binary <that>` after, written in the job type data,
    so the tool name stays out of `control-plane/src`). The after output is stored as a private `patch` artifact
    (≤ 5 MiB, redacted like logs, P4-T07). The task page shows each run's patch in the diff viewer, and, when the task
    has a PR (P4-T11 `pull_requests`), the compare between base and head through the vcs provider. Cost if wrong: a
    patch over 5 MiB is truncated with a marker; the PR compare still shows the whole change.

### E. Not in P7

Tenant-authored blueprints, module removal or upgrade, packages in code nodes, languages other than TS/JS, editing
repository files from the web app, a hosted IDE.

## 3. Data model, protocol and API per task

Every new table: `tenant_id`, forced RLS through `isolate()`, composite FKs, DR201 for cross-tenant. Reserved
migrations: T01 `0080`, T02 `0081`, T03 `0082`, T05 `0083`, T06 `0084`, `0085-0089` free. Protocol features reserved:
`run-files`, `run-result`, `capture`.

### A. T01 blueprints

```
project_blueprints  id, tenant_id, project_id, blueprint, version, options jsonb, commit_sha, render_sha,
                    created_by (member, human), created_at; unique (tenant_id, project_id)
```

CLI `devrounds project new ...` and `devrounds blueprint list | show <key>`. API `GET /api/blueprints`,
`POST /api/projects` (human; body = the CLI flags; answers the project and the queued gate run). DR318. Files:
`blueprints/web-app/**`, `control-plane/src/blueprints/{catalog,render,install}.ts`, the meta-test
`blueprints/blueprints.test.ts`. vcs provider: `createInitialCommit(repo, files)`, `isEmpty(repo)`. App manifest:
`contents: write`.

### B. T02 modules

```
project_modules  id, tenant_id, project_id, module, version, options jsonb, installed_by (member), pr_number null,
                 state proposed|installed, created_at; unique (tenant_id, project_id, module)
```

CLI `devrounds project module add <id> [--option k=v] [--dry-run --out <dir>]`, `devrounds project module list`. API
`GET /api/projects/:key/modules`, `POST /api/projects/:key/modules` (human). DR317; DR201 kind `module`. vcs provider:
`listTree(repo, ref)`, `commitFiles(repo, branch, files)` (refuses refs outside `devrounds/*`), `openPullRequest`.
Files: `blueprints/web-app/modules/login/**`.

### C. T05 run files and run result (executor)

```
job_files  id, tenant_id, job_id, path, content bytea; unique (tenant_id, job_id, path)
```

Protocol: feature `run-files` (`JobSpec.files [{path, content_b64}]`, total ≤ 1 MiB, paths relative without `..`,
written under `<run_dir>/in/`); feature `run-result` (`RunFinished.result` = the parsed `<run_dir>/out/result.json`,
≤ 64 KiB). DR557 `Run {run} wrote an invalid result file: {reason}.` (executor, exit range 5). Both Windows and Linux
executors.

### D. T03 code node

```
code_node_policies  id, tenant_id, native_machines uuid[], updated_by (member, human), updated_at; unique (tenant_id)
grants              + subject kind flow_node (P4 table; flow key + node id)
runs                failure class + output_invalid
```

Flow document node `{kind: code, language, source, input_schema, output_schema, timeout_s, memory_mb, network,
secrets}`. Engine job type `devrounds.code-node`. Image `docker/code-runner/` (digest recorded in the engine's
manifest). DR107, DR355. CLI `devrounds code policy set --native-machine <m>...` (human).

T08 spike: no table and no code on main; the result is a short report linked to T08 (`link add`) with the measured
numbers and the decision rule's outcome. If agentos passes, its provider (`isolation/agentos`, code nodes only) is a
follow-up task, not part of T03.

### E. T07 `code_run` hub tool

Hub tool manifest entry (family `code`, risk `write-internal`); creates a child run with `parent_run_id`; no table.

### F. T06 capture, T04 code viewer

```
job_types  + capture jsonb ({before: [cmd], after: [cmd]})
```

Protocol feature `capture`; the after output is uploaded as artifact kind `patch` (P4-T07). API
`GET /api/projects/:key/code/tree?ref=`, `GET /api/projects/:key/code/file?ref=&path=`,
`GET /api/projects/:key/tasks/:task/changes` (patch artifacts and the PR compare). Web: `web/src/features/code/`
(viewer, diff, deeplink), member setting `editor.deeplink`.

## 4. Stages and PR decomposition

Same parallel rules as P4 §4 and P6 §4: one worktree per track, private test database, numbers as reserved in §3, one
PR per track, a stage review at the end of each stage.

**Stage 1 — four independent tracks (T01 after P4-T11; T05 none; T06 after P4-T07; T08 none).**

| Track | Tasks                         | Acceptance                                                                                                                                        |
| ----- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a    | T01 blueprints                | the meta-test renders and checks every combination; `project new` on an empty test repository commits, sets up the project and its gate runs green |
| 1b    | T05 run files and run result  | a job with files sees them in `in/`; a result round-trips; an oversized or invalid result is DR557 on both executors                              |
| 1c    | T06 capture                   | a run's patch is stored as a private artifact, redacted; over 5 MiB is truncated with a marker                                                    |
| 1d    | T08 sandbox spike             | agentos embedded and the container runner measured on the same fixtures on a Windows and a Linux host; the §2.C 14 rule applied and recorded       |

**Stage 2 — modules, code node, viewer (T02 after 1a; T03 after 1b, 1d, P4-T16, P6-T03, P4-T01; T04 after 1c, P4-T11,
P5-T09).**

| Track | Tasks              | Acceptance                                                                                                                                                                           |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2a    | T02 modules, login | `project new --module login` gate green (phase criterion 1); `module add` on an existing project opens a PR; an overlapping path is DR317; an unknown module answers with `next:`  |
| 2b    | T03 code node      | a flow with a code node runs in a container with no network; the schema check fails as `output_invalid`; a secret granted to node A is unreadable from node B; agent save rules hold |
| 2c    | T04 code viewer    | tree, file and diff views read through the provider, nothing stored (test on the response headers and tables); task changes show run patches and the PR compare; both themes        |

**Stage 3 — `code_run` (T07 after 2b, P4-T02), then the phase review.**

| Track | Tasks              | Acceptance                                                                                       |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------ |
| 3a    | T07 `code_run`     | a run calls `code_run`, gets the result and tail; the child run has no network and no secrets    |

## 5. Tracker mapping (commands to run; not executed)

In Git Bash, prefix commands whose arguments start with `/` with `MSYS_NO_PATHCONV=1`.

```
# Stage 1 needs P4 work, not P6's cloud: replace the phase edge with task edges (P4, P5, P6 precedent)
devrounds phase dep rm P7 --blocked-by P6 --reason "P7 tasks carry task edges on P4, P5 and P6 (P7 design §5)"

devrounds task edit P7-T01 --reason "P7 design 28/11" --description "File catalog under blueprints/, web-app on DevRounds's stack, project new on an empty repo with the first commit by the App (P7 design §2.A)."
devrounds task edit P7-T02 --reason "P7 design 28/11" --description "Modules with manifests; login copies DevRounds's auth; module add opens a PR (P7 design §2.B)."
devrounds task edit P7-T03 --reason "P7 design 28/11" --description "code node kind, inline TS/JS, runs as devrounds.code-node in a container, per-node secret grants (P7 design §2.C)."
devrounds task edit P7-T04 --reason "P7 design 28/11" --title "Code viewer: editor engine (monaco, deeplink)" --description "Read-only tree, file and diff views through the vcs provider, nothing stored; task changes (P7 design §2.D)."

devrounds task add P7-T05 --phase P7 --title "Executor run files and run result" --criterion "Job files land under in/; out/result.json returns in RunFinished (<= 64 KiB, DR557 otherwise)"
devrounds task add P7-T06 --phase P7 --title "Run patch capture as artifacts" --blocked-by P4-T07 --criterion "capture commands live in job type data; the patch is a private, redacted artifact"
devrounds task add P7-T07 --phase P7 --title "code_run hub tool" --blocked-by P7-T03 --blocked-by P4-T02 --criterion "The child run has no network and no secrets; the call is in hub_calls"
devrounds task add P7-T08 --phase P7 --title "Spike: agentos embedded vs container for code nodes" --criterion "Measured on Windows and Linux hosts with the same fixtures: cold start, memory, default network and filesystem denial, stop and footprint" --criterion "Decision recorded against the P7 design §2.C 14 rule; the container stays the default"

devrounds dep add P7-T01 --blocked-by P4-T11 --reason "the first commit goes through the GitHub App"
devrounds dep add P7-T03 --blocked-by P7-T05 --reason "input and result travel as run files"
devrounds dep add P7-T03 --blocked-by P4-T16 --reason "code is a flow node"
devrounds dep add P7-T03 --blocked-by P6-T03 --reason "code nodes run in containers"
devrounds dep add P7-T03 --blocked-by P7-T08 --reason "the sandbox choice is settled by the spike"
devrounds dep add P7-T03 --blocked-by P4-T01 --reason "secrets are granted per node in the vault"
devrounds dep add P7-T04 --blocked-by P7-T06 --reason "task changes show run patches"
devrounds dep add P7-T04 --blocked-by P4-T11 --reason "files are read through the vcs provider"
devrounds dep add P7-T04 --blocked-by P5-T09 --reason "the viewer mounts in the app shell"

devrounds criterion add P7-T01 --text "project new is human only and refuses a non-empty repository (DR318)"
devrounds criterion add P7-T01 --text "A meta-test renders every blueprint, option and module combination and runs its checks"
devrounds criterion add P7-T01 --text "The App writes only to empty repositories and devrounds/* branches (provider client test)"
devrounds criterion add P7-T02 --text "A module never overwrites a file (DR317); an unknown module answers with a next: line"
devrounds criterion add P7-T03 --text "Code nodes import only node: builtins (DR107); output is checked against its schema (output_invalid)"
devrounds criterion add P7-T03 --text "A secret granted to one node is not readable by another; secrets with egress need a human save"
devrounds criterion add P7-T04 --text "The control plane stores no repository file; responses are no-store"
devrounds link add P7 --kind doc --ref docs/superpowers/specs/2026-11-28-p7-blueprints-code-node-design.md --title "P7 design"
```

The invariant edits (the code viewer's exception to "the control plane never reads the repository", the App's
`contents: write` scope) go through `devrounds conventions propose --task P7-T04` and `--task P7-T01` and a human
`conventions approve` (P3 rule).

## 6. Left to the builder

- The exact `blueprint.yaml` and `module.yaml` schemas beyond the fields in §2.A 1 and §2.B 8.
- The login module's page layout and copy in the generated app.
- How the runner image is built and its digest recorded (a DevRounds job on `linux-1`, P6 §2.B 12, is the default).
- Monaco language set and worker loading; the deeplink formats per editor.
- Whether `job_files` stays a table or moves to artifact storage once sizes are known.
- The `--adopt` matching rule details for a half-finished `project new`.

## 7. Needs the owner (credential, money or a secret he holds)

1. **GitHub App `contents: write`**: changing the App's permissions (App admin) and accepting the new permission on
   each installation (GitHub asks the installation owner).
2. **An empty GitHub repository** for the acceptance project of phase criterion 1, with the App installed on it.
3. Not a design approval but a human-only step: approving conventions v1 inside `project new`, the code-node policy
   (`code policy set`) and the conventions proposals that change invariants (P3 rule).
