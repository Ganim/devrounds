# DevRounds P4 Agent runs and flows — design

Status: written 28/11 by Claude; Guilherme reviews after the fact (he asked on 17/11 not to wait for approval).
Decisions marked **[security]** change who can read or use a credential, or what an outside system may do; the
phase review reads them first. Parent spec:
`C:/Users/Guilherme/Code/Clickmax/cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md` ("the
spec", §5.6, §5.7, §11.5, §11.7, §12 "Secrets vault", "Integration hub + vault", "Browser engine", "Terminals",
§14, §16.1, §16.3). P1: `2026-11-17-p1-foundation-design.md` (§3.2 correction loop). P2: `2026-11-23-p2-gates-design.md`.
P3: `2026-11-24-p3-conventions-design.md` (§5 how P4 consumes it). Browser spike (P4-T04, running in parallel):
`docs/research/2026-11-28-p4-browser-engine-spike.md`, landed while this was written; §2.D adopts its recommendation. The P5 Interface design is
being written in parallel; this document designs no UI and lists, per feature, the data and API the UI reads (§3).

Roadmap (28/11): P4 goal "Headless agent runs, browsers and the task-to-pr flow run on DevRounds with credentials from
the vault"; tasks P4-T01..T14; phase criteria: `/work` and `/ship` run as DevRounds job types and task-to-pr opens a PR
end to end; credentials reach integrations only through the vault; final review.

Why P4 matters now: Guilherme wants to use DevRounds for real. Everything cx-env does for him daily (dispatching cards,
headless `/work` and `/ship`, PR rounds, the hub with logged-in browsers and Slack/Gmail/Sentry, terminals answered from
the panel) has to exist on DevRounds before cx-env can be switched off, and the panel he uses is P5. P4 is the
capability layer under that panel.

## 1. What exists today (inventory, 28/11)

Paths are relative to `cx-env/src` unless marked `monorepo:` (`C:/Users/Guilherme/Code/Clickmax/monorepo/.claude/`)
or `dr:` (this repo).

### 1.1 Headless agent runs (cx-env run engine)

- Launch: `run/launcher.ts:65-111`. Argv for the `pipeline` runtime: `claude -p <prompt> --autocompact 300k
  --session-id <uuid>|--resume <id> --model <model, default sonnet> --output-format stream-json --verbose
  --append-system-prompt <HEADLESS_SYSTEM_PROMPT> --permission-mode ${CLAUDE_PERMISSION_MODE:-auto}`, optional
  `--max-budget-usd`. The `claude_code` runtime adds `--agent <name> --strict-mcp-config`, prompt on stdin, optional
  `--tools` and `--json-schema`. Detached spawn, stdio to files, background priority.
- Env: the daemon env plus `MSYS2_ARG_CONV_EXCL=/ship;/work;/check-prs`, `CX_RUN_ID`, `CX_STEP_KEY`,
  `CX_PARENT_RUN_ID`, `CLAUDE_CONFIG_DIR` (`launcher.ts:84-90`), pnpm flags (`headless-pnpm.ts:23-28`).
- Files per attempt: `job-<id>-<n>.agent.jsonl` (stream-json), `.err`, `.prompt`, `.state-before.json`, `.resumes`
  (`run/agent-driver.ts:109-112`).
- Liveness: stdout growth every 5 s; no growth for `heartbeatSec` (task-to-pr 900 s) → kill, `AGENT_STALLED`;
  past `startToCloseSec` → `TIMEOUT` (`agent-driver.ts:29-31,384-416`).
- Verdict: exit code ignored; the last `{"type":"result"}` line, then the outcome source: `state` (diff of the
  monorepo's `state.sh read <TAG>` against the pre-spawn snapshot: unchanged → `AGENT_NO_OUTCOME`), `json`
  (structured output label) or `text` (`agent-driver.ts:419-500`). Budget/turn limit → `AGENT_LIMIT`.
- Cost: tokens and USD per (step, job, attempt) in sqlite `agent_usage`, from the result event, else from the
  transcript (`agent-driver.ts:361-382`, `db.ts:257-264`).
- Admission: queue `agents` (priority 150, aging), pools `claude` (6) and `claude-review` (3, added 09/11 after a
  4-minute Kody fix waited 25 minutes behind task-to-pr), RAM ledger 1500 MB default then p90 of 20 peaks, reserve
  6000 MB (`registry/builtin-defs.ts:400-573`, `flow/ledger.ts`, `scheduler.ts:286-406`).
- Restart: sessions survive the daemon (detached, file stdio); on boot they are adopted by pid + creation time, and a
  dead session with a transcript is relaunched with `--resume`, at most twice per attempt (`agent-driver.ts:225-295`,
  `daemon-core.ts:104-137`).
- Policy gate before spawn: agent unknown/disabled/killed, over budget (tokens/USD per run and per day, concurrency)
  (`agents/control.ts`, `registry/agent-kind.ts:25-36`).

### 1.2 task-to-pr and PR rounds

- `task-to-pr` (`registry/builtin-defs.ts:351-392`): input `{tag, repo}`, dedup by tag; node `implement` =
  `/work <TAG> --auto --stop-at-handoff` (done when state `status` is `handoff`, 72 h cap); node `ship` =
  `/ship <TAG> --auto` (done when state has `prNumber`, 12 h cap); any failure → `park`. No retries.
- State: monorepo `scripts/state.sh` over `~/.claude/projects/.../state/my-linear.json`; /work states
  `awaiting_plan_approval → implementing → awaiting_review → review_pending → handoff`, /ship writes
  `in-review`, `parked` (monorepo: `commands/work.md:76-84`). Run state in sqlite `runs`, `run_steps`
  (`run/journal.ts`); run statuses `running | done | parked | cancelled | needs_attention`.
- Dispatch: `node cx-env/src/cli.ts flow run task-to-pr --input '{"tag":..,"repo":..}'` (monorepo:
  `pipeline/linear-card.md:76-82`); fallback recipe `wait-ram.sh && claude -p "/work $TAG --auto" ...`
  (`linear-card.md:84-93`).
- PR watching: trigger `pr-status-changed` polls `gh api graphql` every 150 s (`connectors/github/pr-sensor.ts`),
  detecting failed CI, open threads, conflict, behind ≥ 25, changes requested, ready, merged/closed; flow `pr-round`
  runs `/check-prs <pr> --round` (pool `claude-review`, max 5 visits, recheck after 900 s), CI triage with rerun, and
  the ready label swap (`builtin-defs.ts:105-266`). 05/11: 40 rounds/h emptied the GraphQL quota (throttle 20/h).
- Slack RFR: daemon loop every 120 s posts ready PRs through the hub (`ui/pr-auto-rfr.ts`, `daemon.ts:388-408`).
- Linear: sensors exist but are not enabled; cards enter by hand (dispatch, board, panel) (`connectors/linear/*`).
- Worktrees: `/work` creates them under `WorkTree/`; a post-merge sweep cleans merged ones every 20 min
  (`ui/worktree-sweep.ts`).
- Correction: nothing measures an indicator and reverts; alerts only notify (`alerts/detectors.ts`).

### 1.3 The hub (MCP) and credentials

- One hub per machine at `127.0.0.1:4991`, MCP streamable HTTP (JSON, no SSE), Host/Origin checks, one static bearer
  token in `~/.cx-env/hub-token` read by Claude Code through `${CX_ENV_HUB_TOKEN}`; `?scope=` filters tool families;
  `X-Cx-Env-Terminal` attributes a call to a tab but is not a credential (`hub/server.ts`, `hub/token.ts`,
  `hub/registry.ts`). Supervised by the daemon with a heartbeat file (`hub/hub-control.ts`).
- Tools: `browser_*` (navigate, logins, snapshot, click, type, screenshot, save_profile, tabs), `gmail_*`,
  `calendar_events`, `meet_*`, `slack_search|conversation`, `sentry_search_issues|issue`, `terminal_spawn|send|wait|
  close`, `platform_*` (queue/run/trigger reads and pause/resume). Linear is panel-only. Risk classes `read`,
  `write-internal`, `publish-external`; `publish-external` is refused over MCP (`registry.ts:208-211`).
- Audit: sqlite `hub_audit` (session, tool, risk, outcome, detail ≤ 500 chars) (`hub/audit.ts`).
- Credentials: Windows DPAPI CurrentUser blobs, per-service entropy, no key file: `google-token.dpapi`
  (refresh token), `slack-token.dpapi` (`xoxp-`), `sentry-token.dpapi`, `linear-key.dpapi`; saved site logins in
  `browser/vault/credentials.json` (username in clear, password DPAPI) (`hub/integrations/credential-vault.ts`).
- Plain-text credentials today: Playwright storage states and shared logins (`browser/states/*.json`,
  `browser/logins/*.json`, cookies), the WhatsApp token file, a Cloudflare API token in `~/.cx-env/config.json`,
  cx-prints R2 keys in `~/.config/cx-prints/r2.env`, `DEVROUNDS_TOKEN` as a Windows user variable (dr:
  `roadmap/fixtures/job-types/*.yaml`).
- Leak paths today: `browser_navigate` audits full URLs (query tokens), handler error text into `hub_audit.detail`,
  `hub.log`, prompts and answers in clear in `~/.cx-env/turns/*.jsonl`.
- Pipeline credentials outside cx-env (monorepo inventory): `gh` CLI login (PRs, labels, reruns), SSH signing key,
  the Linear MCP plugin's OAuth (`get_issue`, `save_issue`, `save_comment`), the Claude login in `CLAUDE_CONFIG_DIR`,
  dotenv-vault `.env` copied into worktrees.

### 1.4 Browsers

`playwright-core` drives the installed Chrome (`channel: chrome`) over `--remote-debugging-pipe`, no CDP port. Two
Chromes: an ephemeral one with one context per MCP session (cap 4) and the panel drawer's persistent profile; each
closes after 10 min idle. The drawer is a CDP screencast over a WebSocket with input events; logins are shared into
agent contexts by copying one origin's cookies (`hub/integrations/browser.ts`, `playwright-driver.ts`,
`browser-screencast.ts`, `shared-logins.ts`). Screenshots are local files kept 3 days. Artifacts for PRs are the
`cx-prints` skill (outside cx-env): PNGs + `index.html` to the R2 bucket `cx-prints`, unguessable prefix, public by
exact URL, 15-day lifecycle.

### 1.5 Terminals and the panel

- Tabs: `wt.exe -w 0 new-tab ... pwsh -NoExit -EncodedCommand <claude ...>` (`ui/project.ts:232-268`).
- Report: the `cockpit` mod (`~/.claude-clickmax/mods/cockpit/hooks/register.tsx`) posts every 3 s to
  `127.0.0.1:4990/api/terminals/<id>/sync` with no token; the report has status, activity, stage/progress, context %,
  tokens, cost, subagents with last tool, PR, last prompt/answer, the pending question (`ui/terminals.ts:62-107`).
- Back channel: the sync response carries one instruction (prompt or slash command) to an idle session or the answer
  to a pending question; first of terminal dialog and panel answer wins (`register.tsx:289-403`,
  `ui/terminals.ts:545-562`).
- Child terminals: hub `terminal_*` tools with depth 1, 3 children per parent, distinct folders/TAGs, ≥ 4096 MB free,
  45 min lifetime (240 for /work), result file `runs/<child>/result.md` (`hub/integrations/terminals.ts:8-28`,
  `ui/child-terminals.ts`).
- Panel: `127.0.0.1:4990`, SSE `/events`, `GET /api/snapshot`; local writes need only an `x-cx-env-action` header and
  a loopback Host, no token (`ui/dashboard.ts:1263-1282`). Any local process can therefore instruct a session, some of
  which run with permission prompts off. Remote access goes through Cloudflare Access JWT (`ui/access.ts`).

### 1.6 DevRounds today (what P4 builds on)

Migrations up to `0028_tenant_names_unique` (P6-T06 landed 28/11 ahead of P4). No secrets, hub, engine/provider registry, flows, webhooks, artifacts,
ConPTY or hand-over code. Job types (`dr: control-plane/src/job-types/file.ts`): `command`, `env` allowlist,
`args_from_job`, `job_env`, `env_set`, `need_mb`, `timeout_s`, `orphan_policy` (kill | let_finish), `classify`,
`retry`. Env reaches the process as `Offer → JobSpec{env_allow, env_set}` under protocol feature `job-env`; the
executor copies allowlisted names from its own environment (`executor/crates/executor/src/isolation.rs`). Run output
goes to files owned by the run (`runner-windows/src/spawn.rs:154-234`), shipped as zstd log segments; no redaction
anywhere. Executor store: SQLite `runs(job_json, ...)`, `outbox`, `meta`; the machine token is a file. Orphans are never
re-adopted (`executor/src/orphans.rs`, `control-plane/src/runs/record.ts:507`). Auth: members human/agent, `drt_`
tokens as SHA-256, DR453 human-only, session cookie read-only (DR402). Free codes: DR105, DR154, DR203, DR314, DR353,
DR403, DR454, DR505, DR554.

### 1.7 What P4 replaces, what stays in cx-env during migration

| cx-env today                                                                | P4 replacement                                                   | Switched off in cx-env when            |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| DPAPI token files, plain-text cookie files, `DEVROUNDS_TOKEN` user variable | `secrets` engine (T01)                                           | each consumer has moved (below)        |
| hub `127.0.0.1:4991` for headless runs                                      | DevRounds hub (T02), per-run tokens                              | task-to-pr runs on DevRounds two weeks |
| hub for interactive Claude tabs                                             | same hub, via terminal sessions (T08)                            | T08 cut-over                           |
| `task-to-pr` flow, `agents` queue, `agent_usage`                            | agent job types + flow engine (T03, T10, T15, T16)               | two weeks without fallback             |
| `pr-round` + GraphQL polling sensor                                         | GitHub App webhooks + `pr-round` flow (T11, T17)                 | two weeks without fallback             |
| browser hub tools and drawer Chrome                                         | `browser` engine (T05, T09), screencast data for P5              | P5 drawer exists                       |
| cx-prints R2 publishing                                                     | artifact gallery (T07)                                           | `/ship` calls DevRounds for prints     |
| terminals tab, cockpit sync, child terminals                                | terminal sessions (T08)                                          | P5 page exists                         |
| Slack RFR loop, Gmail/Calendar/Meet tools, inbox, voice, board, slots       | not in P4 (P5 `messaging`; hub tools only where §2.B lists them) | later phases                           |

cx-env keeps running everything not yet switched. Two hubs coexist on different ports during the migration; a session
uses the one its launcher configured.

## 2. Decisions (28/11, Claude)

Each with why and its cost if wrong.

### A. Secrets vault (T01)

1. **[security] The vault is the `secrets` engine with one provider, `secrets/native`, storing ciphertext in the
   control plane's Postgres.** Table `secrets` (tenant, project or null for tenant-wide, name, environment, version,
   ciphertext, nonce, wrapped data-key id, created_by, created_at, rotated_at, deleted_at). External providers
   (OpenBao, Infisical) implement the same contract later. Why: one store already isolated by RLS and backed up with
   the rest; no new process within the 300 MB budget. Cost if wrong: a migration of ciphertext to an external store,
   behind the same names.
2. **[security] Envelope encryption: AES-256-GCM per value with a per-tenant data key; data keys wrapped by a key
   encryption key that never lives in Postgres.** AAD = `tenant_id | project_id | name | environment | version`, so a
   ciphertext copied to another row or tenant fails to decrypt. A fresh 96-bit random nonce per encryption; a data key
   is rotated after 2^24 encryptions or 90 days, old ones kept for decryption. The KEK is a `kek` provider:
   `kek/dpapi-local` (32 random bytes, DPAPI CurrentUser-protected, in `~/.devrounds/kek.dpapi`, owner-only ACL, read
   once at start into locked memory) for the local control plane; `kek/cloud-kms` in P6. A database dump alone
   decrypts nothing. Why: DPAPI is what cx-env already trusts on this machine, and envelope encryption lets the KEK
   move to a KMS without re-encrypting values. Cost if wrong: if the Windows profile is lost the KEK is lost and every
   secret must be re-entered; `devrounds-admin kek export --to <file>` (human, owner side, passphrase-wrapped with
   scrypt) is the recovery path, and its absence would be the real cost.
3. **[security] Write-only values.** No API, CLI or UI returns a secret's plain value, to any member, human or agent.
   `devrounds secret set <name> [--project <k>] [--env <e>] --from-stdin|--from-file` (human only, DR453), `secret
   list` (names, versions, who, when, last use; never values), `secret rotate`, `secret rm` (soft delete, value
   overwritten). Values are read from stdin or a file, never from argv (shell history, process listings). Why: a value
   that can be read back can be exfiltrated by any agent holding a token; GitHub's model. Cost if wrong: re-entering a
   value someone forgot; acceptable.
4. **[security] Use is granted, default deny.** `secret_grants(secret, subject_kind job_type | provider | member,
   subject, project)`; creating or removing a grant is human only (DR453). A job type or provider that names a secret
   it has no grant for fails at dispatch with DR403 (`Secret {name} is not granted to {subject}.`), recorded on the
   run, before anything spawns. Every resolution writes `secret_uses(secret, version, run, task, member, provider,
   tool, at)`. Grants are evaluated in one module (`control-plane/src/policy/`), the start of spec §14's policy
   engine; Cedar is not adopted in P4. Cost if wrong: grants become policies later, same evaluation point.
5. **[security] Two delivery paths, the hub first.** (a) Hub tools (§B): the provider runs in the control plane and
   uses the value there; it never reaches the machine. (b) Env injection, only for programs that must hold a
   credential themselves (`gh`, `git` over HTTPS, a CLI that reads `X_TOKEN`): the job type declares
   `secrets: [{name, as: ENV_NAME}]`. Where the provider can mint a derived short-lived credential (GitHub App
   installation or user-to-server token), the env gets that, not the stored value. Why: (a) keeps the value off every
   machine and out of every agent context; (b) is needed because `/ship` drives `gh` today and rewriting it onto hub
   tools is a larger change than P4. Cost if wrong: env-injected values are visible to the agent process; that is
   exactly what (b) accepts for named job types only.
6. **[security] Env-injected values travel once, are never stored by the executor, and are redacted.** Protocol
   feature `secret-env`: the `Offer` carries `secret_env: [{name, value}]` only to sessions that negotiated it; the
   executor applies it at spawn after the allowlist, writes the job to its SQLite store with `secret_env` stripped
   (names only), never logs it (`Debug` of the type prints names), and zeroes the buffer after spawn. A retry gets a
   fresh Offer. The executor redacts every injected value, and its base64 and URL-encoded forms, from log segments,
   `tail` and `summary` before they leave the run, replacing with `[secret:<name>]`; the control plane applies the same
   redaction on ingest as a second fence, for values it resolved for that run. Values shorter than 12 characters are
   refused at `secret set` (DR105), since redacting short strings mangles logs. The raw output files under the run dir
   are owner-only and deleted once segmented. Until P6 the executor link is a loopback WebSocket; P6 adds TLS before any
   non-local executor may negotiate `secret-env`. Cost if wrong: a value printed in an unforeseen encoding (hex, split
   across lines) leaks into a log segment; the e2e test injects a canary secret and fails on any occurrence in
   segments, `run show` and `hub_calls`.
7. **[security] Out of the vault in P4, recorded as exceptions:** the executor's machine token file, the SSH
   authentication and commit-signing keys (git transport and signatures belong to the machine's user and the repo
   requires signed commits), and the agent runtime's own login (`CLAUDE_CONFIG_DIR` OAuth). If the runtime is reached
   with an API key or gateway token (`ANTHROPIC_AUTH_TOKEN`), that key is a vault secret injected by (5b). AGENTS.md
   gets an "Accepted P4 exceptions" entry for these three. Cost if wrong: the phase criterion "credentials reach
   integrations only through the vault" is read as covering git and the runtime login; moving them is P6 work (cloud
   machines get deploy credentials from the vault anyway).
8. **Migration from cx-env is manual, one secret at a time.** The human runs `devrounds secret set` for the Linear key,
   Sentry token, Slack token, Google OAuth client and refresh token, R2 keys, the Cloudflare token, and the DevRounds
   agent token used by scheduled jobs. No DevRounds code reads cx-env's DPAPI files (no vendor coupling, and a reader of
   another program's secrets is the wrong shape). Cost if wrong: about ten minutes of Guilherme's time.

### B. Integration hub (T02)

9. **One hub per machine, a separate process `devrounds-hub` (TypeScript), run by the executor as a service run.**
   A job type of kind `service` (new: no `timeout_s`, restart policy `always` decided by the control plane, never by
   the executor), `orphan_policy: let_finish`, admitted by learned need like any run. It listens on `127.0.0.1:4993`,
   MCP streamable HTTP like cx-env's (JSON responses; SSE only if a tool needs streaming). Why TypeScript: providers
   are TypeScript in the control plane, and the MCP SDK and Playwright are Node-first; why a run: it gets a Job Object,
   footprint sampling, log segments and visible restarts (manifesto §6) for free. Cost if wrong: if the hub's Node
   process costs more than the budget allows, its local providers move into the executor; the tool contract does not
   change.
10. **[security] HTTP-API providers execute in the control plane; the hub runs only machine-local providers.** A call
    to `linear_*`, `github_*`, `sentry_*`, `slack_*`, `google_*` is forwarded by the hub to `POST
    /api/hub/calls` and executed there with the vault value. `browser_*`, `terminal_*` and `environment_*` execute in
    the hub, because they act on the machine. Why: the stored credential never reaches a machine, and the hub on a
    customer machine holds nothing worth stealing. Cost if wrong: one extra local hop per call (sub-millisecond
    locally; one RTT once the control plane is in the cloud, P6).
11. **[security] Sessions authenticate to the hub with a per-run capability token.** At dispatch the control plane
    mints `drh_` + 256 random bits for the run, stores its SHA-256 with (tenant, project, task, run, member, machine,
    allowed tool families, expiry = run end), and sends it in the Offer under `secret-env` as
    `DEVROUNDS_HUB_TOKEN`. The agent-runtime provider writes the run's MCP config into the run dir with header
    `Authorization: Bearer ${DEVROUNDS_HUB_TOKEN}` (expanded by the runtime, so the file holds no literal token) and
    starts the runtime with `--strict-mcp-config`. The hub forwards with its own machine identity plus the run token;
    the control plane accepts a call only when the run is `running` on that machine (DR454 `Hub token is not valid
    for a running run.` otherwise). The token dies with the run. No static hub token exists. Host and Origin checks as
    cx-env. Why: a token copied out of one run is useless after it, and every call is attributed to a task (manifesto
    §1). Cost if wrong: interactive sessions need a token before T08; until T08 they keep cx-env's hub (§1.7).
12. **[security] Tool risk classes and policy.** Every tool declares `read | write-internal | publish-external` in its
    provider manifest. A job type lists the tool families it may use (`hub: {families: [linear, github, sentry,
    browser]}`) and the maximum risk; `publish-external` (posting to Slack, emailing, commenting on a public surface)
    needs an explicit `allow_publish: [tool]` in the job type, which only a human can set (job type changes by agent
    tokens may not raise it: DR453). Cost if wrong: a flow that needs to post waits for a human edit of its job type.
13. **[security] Audit without values.** `hub_calls(run, task, member, machine, provider, tool, risk, outcome,
    duration_ms, args_digest, error_code, at)`. `args_digest` lists argument names with the SHA-256 of each value and
    the length; URLs keep scheme, host and path, query stripped; error text is the `DevRoundsError` code and data with
    values from the vault redacted. Nothing about a call is written to a plain-text log. Cost if wrong: debugging a
    failing call needs a rerun with the provider's own debug mode, behind a human-set flag.
14. **Provider and manifest machinery lands here.** P4 builds the engine/provider registry the spec §5.6 describes:
    `control-plane/src/engines/<engine>/` with explicit registration in one `registry.ts`, and per provider a manifest
    (id, version, engine contract version, capabilities, config schema, secrets it needs, tools with risk) validated by
    TypeBox. Engines in P4: `secrets`, `issue-tracking` (provider `linear`), `vcs` (`github`, plus the existing
    `git-local` behaviour), `monitoring` (`sentry`), `messaging` read tools only (`slack` search and conversation;
    posting is P5), `mail-calendar` read tools (`google`: Gmail, Calendar, Meet, as cx-env exposes them), `browser`,
    `agent-runtime` (`claude-code`), `environments` (`devlanes`), `storage` (`local-fs`, `s3`). Vendor names live only
    under `providers/`; the `engine.no-tool-names` convention gets `providers/**` as an exclusion, recorded as an
    accepted exception. Cost if wrong: a provider written before the registry is moved into it.
15. **The Linear tool set matches what the pipeline uses today.** `linear_get_issue`, `linear_list_issues`,
    `linear_list_issue_statuses`, `linear_save_issue`, `linear_save_comment` (`write-internal`). Headless runs drop the
    Linear plugin (its OAuth is outside the vault) and use these through `--strict-mcp-config`; the monorepo commands
    call tool names the hub exposes, changed by a monorepo PR (§2.C 22). Cost if wrong: a pipeline step that used a
    plugin tool we did not map fails with a named "tool not found"; we add it.
16. **stdio MCP servers without credentials (devlanes, serena) are not proxied in P4.** Runs list them in their MCP
    config as today. Spec §16.1's "launched once behind the hub" is measured in T09's RAM work and done only if the
    per-session cost is worth it. Cost if wrong: ~0.1 GB per concurrent session stays.

### C. Agent runs as job types (T03, T15)

17. **An agent run is an ordinary run of a job type with `agent:`; the `agent-runtime` engine turns it into a
    command.** Job type fields: `agent: {runtime: claude-code, prompt: <template>, model, permission_mode,
    max_budget_usd, system_prompt_append, result: {kind: reported | text | json, schema?}}`. The provider builds argv and
    env as data (the cx-env launcher's flags: `-p`, `--session-id`, `--output-format stream-json --verbose`,
    `--mcp-config <run dir>/mcp.json --strict-mcp-config`, `--permission-mode`, `--max-budget-usd`), the engine merges
    it into the JobSpec, the executor spawns it like any program. Prompt templates use only `{{job.args.N}}` and
    `{{input.<key>}}` from the job; no expression language. Why: one execution path for gates and agents; the core never
    names the runtime. Cost if wrong: a runtime that cannot be driven as one process (a server hosting many sessions,
    spec §16.1) needs a `session` mode in the provider contract; the job type does not change.
18. **Agents report their outcome to DevRounds; DevRounds never reads a repo's state file.** `devrounds run result
    --json <obj>` (uses `DEVROUNDS_RUN_ID` and the run's hub token, so only the run itself can report) writes
    `run_results(run, outcome label, data jsonb ≤ 64 KiB, at)`. The job type maps labels to run outcomes:
    `result: {kind: reported, done: [handoff], park: [aborted]}`. A run that exits without a reported result ends
    `failed` with class `no_outcome`. For Clickmax, `/work`'s last step and `/ship`'s PR step add one `devrounds run
    result` call next to their `state.sh write` (monorepo PR). Why: cx-env's `state` source couples the engine to a
    Clickmax script and failed silently on DEVOPS-434 and FLOWS-2853; an explicit report is checkable. Cost if wrong:
    a session that forgets to report parks like cx-env's `AGENT_NO_OUTCOME`, now with a named class.
19. **Three failure classes are added to the closed list:** `stalled` (no output growth and no CPU for the job type's
    `stall_s`; the executor stops it, staged), `no_outcome` (above), `limit` (the runtime's budget or turn limit). The
    executor gains `stall_s` on the JobSpec under feature `stall`. Parsing the runtime's result event (limit, cost,
    tokens) is the provider's job on the control plane, from the log segments. Cost if wrong: indicators split classes
    we later merge; classes are never renumbered, only deprecated.
20. **Usage is metered on the run.** Columns on `runs`: `tokens_in`, `tokens_out`, `tokens_cache_read`,
    `tokens_cache_write`, `cost_usd`, `usage_source` (`result | transcript | missing`), filled by the provider at
    `RunFinished`. Budgets: `agent_budgets(project, member or job type, usd_per_day, tokens_per_day, usd_per_run)`
    evaluated by the scheduler before offering (an over-budget run stays queued with wait reason `budget`, manifesto §6:
    delay, never kill) and passed to the runtime as `--max-budget-usd` per run. Cost if wrong: daily budgets lag by
    one run, since cost is known at the end.
21. **Resume instead of retry for agents.** A job type's `retry.on` may include `stalled` and `infra`; for agent job
    types the provider sets `resume: {max: 2}`: the next attempt reuses the previous attempt's session id (stored in
    `run_results`-adjacent column `runs.agent_session_id`) with `--resume`, if the transcript exists on the same machine
    (placement pins the retry to it). Agent job types default to `orphan_policy: let_finish` (spec §11.5). Cost if
    wrong: a resumed session repeats work; cx-env's two-resume cap already bounds it.
22. **`/work` and `/ship` are Clickmax job types, in the monorepo.** `devrounds/job-types/clickmax-work.yaml`
    (`/work {{input.tag}} --auto --stop-at-handoff`, cwd the main checkout because `.claude` is local-only, need 1500
    MB, `stall_s: 900`, `timeout_s: 259200`, `result: reported, done: [handoff]`), `clickmax-ship.yaml` (`/ship
    {{input.tag}} --auto`, `timeout_s: 43200`, `done: [pr_opened]`, `secrets: [{name: github-user, as: GH_TOKEN}]`,
    hub families linear, github, sentry, browser), `clickmax-check-prs-round.yaml`. Queues: `agents`
    (`machine_concurrency: 6`) and `reviews` (`machine_concurrency: 3`), both on the Clickmax project, mirroring cx-env's
    pools. The monorepo changes ship as monorepo PRs through its own process (Linear card, cx-env queue, `/ship`), like
    P2. Cost if wrong: none for the engine; Clickmax tunes its own files.

### D. Browsers (T04 result, T05, T06, T09)

23. **The engine contract is fixed now; the default provider is the spike's call.** `browser` engine tools: `open(url,
    {profile?, login?})`, `snapshot()` (accessibility tree with `ref`s, capped), `act(ref, action, value?)`,
    `screenshot({full?})` → artifact, `tabs`, `trace start|stop` → artifact, `save_login(origin)`. Provider, from the
    spike (`docs/research/2026-11-28-p4-browser-engine-spike.md`, landed 28/11 while this was written; its
    recommendation is adopted as is): `browser/playwright` on `playwright-core`, one Chromium revision pinned per
    DevRounds release, default binary `chrome-headless-shell` (≈ 3x less idle RAM, ~90 MB per context, 0.2 s start),
    full Chrome for Testing of the same revision as a per-profile-class fallback, installed into a DevRounds-owned path
    with its Authenticode signature checked before first use, always launched with Playwright's default switches;
    system Chrome only as an explicit `browser/cdp` provider, never the default. Headless everywhere, the drawer
    included (CDP screencast works headless). Not adopted: an MCP browser server per session. Cost if wrong: the spike's
    own list (full Chrome doubles RAM and forces baseline re-approval; a Rust CDP rewrite if the Node side is too heavy).
24. **[security] Site logins are vault secrets of kind `browser_login`.** A saved login (Playwright storage state of
    one origin, or username + password) is encrypted like any secret, granted to job types or members by a human, and
    applied by the hub into the run's browser context at `open(url, {login})`; agents never receive cookies or
    passwords in tool output (`snapshot` masks password fields). No plain-text storage-state files. Cost if wrong:
    re-capturing logins after a rotation; cx-env's plain cookie files are the risk this removes.
25. **[security] One pooled browser per (machine, tenant, binary kind), a context per run; the hub process is the
    spike's Node sidecar.** The spike puts `playwright-core` in one Node sidecar that serves the machine's hub; P4 makes
    the hub that sidecar (one Node process instead of two, ~110 MB saved). Browsers are started on demand inside the
    hub run's Job Object, so stopping the hub kills every browser and the pool's members and peak commit come from the
    Job. Contexts are created per run and closed at run end; idle browser closes after 10 min. Admission uses the
    spike's costs (shell 50 MB + ~90 MB per context, sidecar ~110 MB) as starting needs. Tenant in the key because one
    browser process is a weaker boundary than contexts suggest. The drawer's persistent profile (one per tenant and
    user) is a separate browser outside the pool and never shared with agents. Cost if wrong: a hub restart drops live
    browser contexts (their tool calls fail with a named code); if that bites, the browser pool becomes its own service
    run, as the spike drew it.
26. **Visual gate = repo job type + baselines in the storage engine.** `visual-check` captures named targets (route,
    story, viewport, theme) declared in a repo file, diffs with `pixelmatch` (MIT) against the approved baseline,
    threshold per target (default 0.1 % pixels), exit 1 on a diff above threshold, artifacts for current, baseline and
    diff. New or changed baselines are proposed by the run and approved by a human only (`devrounds visual approve`,
    DR453), the conventions pattern. Baselines are keyed by engine revision and binary kind as well (the spike measured
    8 % of pixels differing between shell and full Chromium); a revision bump is a re-approval event, never silent.
    Project E2E suites are ordinary runs with the project's own Playwright, outside the pool. Cost if wrong:
    Argos/Lost Pixel later reuse the same baseline records.

### E. Artifacts (T07)

27. **[security] Artifacts are rows plus objects in the `storage` engine.** `artifacts(run, task, kind screenshot |
    video | trace | har | diff | baseline | file, name, sha256, bytes, provider, object_key, visibility private |
    unlisted, expires_at)`. `storage/local-fs` (`~/.devrounds/artifacts/`, owner-only) for private artifacts, served by
    the control plane to tenant members; `storage/s3` (R2, keys in the vault) for `unlisted`: an object key with a
    128-bit random prefix, public by exact URL, used for images in PR bodies, 15-day expiry (cx-prints' model).
    HAR and traces are always private (they carry cookies and tokens); only screenshots and diffs may be unlisted.
    Upload is by the run through the hub (`artifact_put`), never with storage keys on the machine. Cost if wrong: a
    private repo's screenshots are reachable by anyone holding the URL, as today; a signed-URL proxy is the P6 fix.

### F. Terminal sessions (T08)

28. **A terminal session is a run of an agent job type in `interactive` mode, hidden in a ConPTY by default.** The
    executor gains ConPTY spawn (copy devlanes `runner-pty`, Windows only) under feature `pty`, with messages
    `PtyOpen{run, cols, rows}`, `PtyInput{run, bytes}`, `PtyOutput{run, seq, bytes}`, `PtyResize`, `PtyClose`;
    output is also written to the run's log segments. "Open on my screen" runs `devrounds-executor attach <run>` in a
    Windows Terminal tab, attaching to the same PTY over a local named pipe ACL'd to the user. Interactive sessions
    have no `timeout_s` and are never stalled-killed. Cost if wrong: ConPTY quirks with the runtime's TUI; the visible
    tab fallback (a direct `wt.exe` spawn inside the Job Object) is the escape hatch.
29. **[security] Reports and instructions go through the control plane with the run's token.** The `claude-code`
    provider ships its own report hook (Claude Code hooks configured through `--settings <run dir>/settings.json`), not
    the private cockpit mod: it posts `POST /api/sessions/:run/report` with the run's hub token, every 3 s while
    working and on state changes, the cockpit report shape (§3.F). Instructions and answers are rows
    (`session_instructions`) delivered in the report response, one at a time to an idle session, as cx-env does.
    Sending an instruction or answer needs a bearer token of a human member, or of the parent run for child sessions;
    the session cookie stays read-only until P5 decides web writes. Typing into a PTY (`PtyInput`) has the same rule.
    Why: cx-env lets any local process instruct a session that may run with permissions off; DevRounds does not.
    Cost if wrong: the page cannot type until P5 lands web writes behind its own review.
30. **Child sessions keep cx-env's limits as data.** `terminal_spawn|send|wait|close` hub tools create child runs with
    `parent_run_id`; limits (depth 1, 3 children per parent, distinct cwd, free memory via admission instead of a fixed
    4096 MB check, lifetime 45 min / 240 min) live in the parent job type's `children:` block. Cost if wrong: limits
    tuned per job type.
31. **Idle sessions: parked first, frozen only if measured.** Parking (end the process when the provider reports
    waiting-for-input for 2 h or under memory pressure; resume with `--resume`) ships in T08. Freezing (suspend + trim
    after 15 min idle) ships only if the T08 measurement shows it frees at least 300 MB resident per idle session on
    this machine; otherwise it is cancelled with the numbers as evidence (spec §16.3 already allows that). Cost if
    wrong: idle sessions hold RAM for up to 2 h.

### G. Flows, task-to-pr, PR rounds (T10, T11, T16, T17)

32. **P4 adds a minimal flow engine; P5 only edits it visually.** A flow definition is a versioned document (like
    conventions): nodes of kind `job` (run a job type with inputs), `wait` (an event matching a filter, or a duration),
    `branch` (on the previous node's result label or data field, literal comparisons only), `park` (end, needs a
    human), `finish`; edges labelled by outcome; cycles allowed with a per-node `max_visits`. A flow run belongs to a
    task, and every node run is a run of that task. Why: task-to-pr is a DAG, but pr-round is a loop (round → wait →
    round), which P2 batches cannot express; P5's criterion "a flow built in the visual editor runs" needs this engine
    to exist. Cost if wrong: if P5 needs node kinds we did not foresee, they are added as new kinds; documents are
    versioned, not reshaped.
33. **task-to-pr is a Clickmax flow file over generic nodes.** `implement` (job `clickmax-work`, done → `ship`),
    `ship` (job `clickmax-ship`, `pr_opened` → `watch`), `watch` (starts `pr-round` for the PR and finishes), any other
    outcome → `park`. Input: the DevRounds task key plus `{tag, repo}`. Dispatch: `devrounds flow run task-to-pr --task
    <key> --input tag=FLOWS-123` after `devrounds task open-finding`-style dedup by `source_key = linear:FLOWS-123`, so
    the DevRounds task mirrors the Linear card. One live flow run per (flow, source_key) (DR314 `Flow {flow} is already
    running for {source}.`). The "PR opened" fact comes from the run's reported result and is confirmed by the
    `pull_request.opened` webhook (§34). Cost if wrong: a card dispatched twice by two sessions; the unique index
    refuses the second.
34. **[security] GitHub App, least privilege, one installation per repo.** Repository permissions: metadata read,
    contents read, pull requests write (labels and the ready label swap use the issues API: issues write), checks read,
    statuses read, actions read. Not requested at install: contents write, administration, workflows, secrets,
    members, actions write. A user-to-server token is limited to the App's permissions, so CI reruns (cx-env's
    `ci-triage --rerun`) need `actions: write`; it is added only with T17, as its own reviewed manifest change, and
    until then the triage job reports "rerun needed" instead of rerunning.
    Subscribed events: `pull_request`, `pull_request_review`, `pull_request_review_comment`,
    `pull_request_review_thread`, `check_suite`, `check_run`, `push` (default branch, for conflicts and conventions
    `verify`). The App private key and webhook secret are vault secrets used only in the control plane to sign JWTs and
    mint installation tokens (1 h); neither is sent to a machine. Pushes stay on the machine's SSH key (§2.A 7) and PRs
    stay authored by the human: `/ship`
    gets a GitHub user-to-server token of the App from the vault as `GH_TOKEN` (8 h expiry, refreshed by the
    control plane), so actions show as the user "via DevRounds". Cost if wrong: a missing permission fails one call
    with a named 403 code and is added in a reviewed manifest change.
35. **[security] Webhooks reach a local control plane through a pull relay; the control plane stays unreachable.**
    `webhook-relay` provider, first implementation a small Cloudflare Worker: it verifies `X-Hub-Signature-256`, stores
    the raw body + headers in a queue (Workers free tier), and the control plane pulls over outbound HTTPS with a relay
    token from the vault, re-verifies the signature on the raw body, dedups by `X-GitHub-Delivery`, and writes
    `webhook_deliveries` before acknowledging. A reconciliation pass every 10 min compares open PRs with the last event
    per PR, so a lost delivery delays a round by at most 10 min. In P6 the cloud control plane receives directly and the
    relay is dropped. Why: exposing the local control plane (even one path through a tunnel) puts the API one bug away
    from the internet. Cost if wrong: one more moving part (the Worker) to keep alive; the reconciliation pass covers
    its outages.
36. **pr-round moves to webhooks with cx-env's guards.** Flow `pr-round`: `route` on the event (merged/closed →
    finish; ready → label; CI-only failure → triage job; else → `round` job `clickmax-check-prs-round` on queue
    `reviews`), `wait` 900 s, `max_visits: 5` on `round`, per-PR throttle 20 events/h and debounce 5 s in the trigger,
    superseded (cancelled) check runs ignored, rounds bound to the PR number, never re-resolved from a TAG (the
    25/11 and 27/11 failures). Cost if wrong: the same failure modes as cx-env, now visible as flow runs.
37. **Worktrees stay with `/work` in P4.** The flow passes the main checkout; `/work` creates the worktree and reports
    `worktree` and `branch` in its result; DevRounds records them as a `Checkout` row for the task and runs the
    post-merge cleanup (on the `pull_request.closed` webhook, with cx-env's guards: not dirty, no local-only commits, no
    live run with that cwd). DevRounds-created checkouts (`vcs` engine) come later. Cost if wrong: two cleanup paths
    for two weeks; cx-env's sweep is switched off when DevRounds' runs.

### H. Environments, hand-over, correction (T12, T13, T14)

38. **`environments/devlanes` wraps a command, it does not manage lanes.** A job type may say `environment:
    {provider: devlanes, mode: with}`; the provider prefixes the command with `devlanes with --` in the run's cwd, and
    `mode: status` only reads (`devlanes status --json`) into the run's data. Hub tools `environment_status`,
    `environment_urls` read the lane of the run's cwd. Learned need of such job types includes the lane, measured as
    any run. Cost if wrong: lanes started outside DevRounds are not admitted by it; devlanes' own memory diet still
    applies.
39. **Executor hand-over: new before old, adoption only with a hand-over record.** `devrounds-executor upgrade
    <binary>` starts the new executor with `--take-over`; the old one, over a local pipe ACL'd to the user, stops
    admitting, flushes its outbox, writes `handover(runs: [{run, pid, start_time, boot_id, run_dir, log cursor}])`
    into the shared store, closes its WebSocket and exits without touching runs. The new one adopts exactly the listed
    runs whose identity still matches, resumes log capture from the run's output files at the recorded cursor, and
    sends `Hello{features: [..., "adopt"], adopted: [run]}`. Runs found without a hand-over record stay crash orphans
    (never adopted, P1 rule unchanged). The service task points at the new binary only after the new process is
    connected. Cost if wrong: a failed hand-over leaves runs as orphans handled by policy, the P1 behaviour.
40. **Correction loop: a flow over findings, with a measured revert.** Flow `fix-finding` (DevRounds project first):
    an agent job works the finding's task in a worktree through the same task-to-pr shape (gates, PR, human or
    auto-merge per repo policy); after merge, `measure` waits until the indicator named in the finding has 3 calendar
    days or 20 samples after the merge, compares the median with the 7 days before, and if it did not improve by the
    finding's threshold (default 10 %) opens a revert task whose job runs `git revert` of the merge commit and a PR
    through the same flow. Every step is a plan event on the finding task. Clickmax findings join only after two weeks
    on DevRounds' own. Cost if wrong: noisy indicators revert useful changes; the revert is a PR a human can close.

### I. Cut-over

41. **Per capability, with a fallback only on DevRounds infra errors** (spec §11.3). Dispatch in
    `monorepo: pipeline/linear-card.md` switches to `devrounds flow run task-to-pr` with cx-env as fallback when the
    CLI exits 4 or 6. Replay: the next 5 real cards run on DevRounds while cx-env watches only; success = PR opened for
    each card that cx-env would have shipped, parks with the same reasons. Each cx-env path in §1.7 is switched off
    after two weeks without fallback. Cost if wrong: two systems briefly in use, never on the same card (dedup by
    source key on DevRounds and by tag on cx-env, checked before dispatch).

## 3. Data model, protocol and API per task

Migration numbers are reserved per track so parallel branches do not collide in `migrations/index.ts`: T01 0029-0031,
T03 0032-0034, T16 0035-0037, T13 none (executor store schema v2), T02 0038-0040, T11 0041-0043, T07 0044-0045, T05/T06
0046-0047, T08 0048-0050, T14 0051. Every table: `tenant_id`, forced RLS through `isolate()`, composite FKs, DR201 for
cross-tenant. Error codes reserved: T01 DR105, DR403, DR505 (`Key encryption key unavailable.`); T02 DR454; T03 DR154
(executor: stall stop), DR353 (`Run {run} already reported a result.`); T16 DR314, DR203 (not-found kinds `flow`,
`secret`, `artifact`, `session` reuse DR201); T13 DR554 (`Hand-over refused: {reason}.`). A task adds a code only when
it first emits it (`codes.ts`).

### A. T01 secrets

```
kek_data_keys   id, tenant_id, wrapped_key bytea, kek_provider, kek_ref, created_at, retired_at, encryptions bigint
secrets         id, tenant_id, project_id null, name (^[a-z0-9][a-z0-9-]{0,63}$), environment default 'default',
                kind value|browser_login|oauth, version int, ciphertext, nonce, data_key_id, created_by, created_at,
                deleted_at; unique (tenant_id, project_id, name, environment) where deleted_at is null
secret_grants   id, tenant_id, secret_id, subject_kind job_type|provider|member, subject_id, created_by, created_at
secret_uses     id, tenant_id, secret_id, version, run_id null, task_id null, member_id, provider, tool null, at
```

Job type file: `secrets: [{name, as?: ENV_NAME, environment?}]`. Protocol feature `secret-env`: `Offer.secret_env`.
API: `GET /api/secrets` (names, versions, grants, last use), `PUT /api/secrets/:name` (human), `POST
/api/secrets/:name/rotate`, `DELETE`, `POST|DELETE /api/secrets/:name/grants`, `GET /api/secrets/:name/uses`. UI
reads: list with last use and grants, use history per secret, "never used in 30 days" flag. CLI `devrounds secret
set|list|rotate|rm|grant|revoke|uses`.

### B. T02 hub

```
hub_tokens      id, tenant_id, run_id, token_hash, families text[], max_risk, expires_at, revoked_at
hub_calls       id, tenant_id, run_id, task_id null, member_id, machine_id, provider, tool, risk, outcome,
                duration_ms, args_digest jsonb, error_code null, at
providers       id, tenant_id, engine, provider, version, config jsonb (no secrets; secret names only), enabled
```

API: `POST /api/hub/calls` (hub → control plane, machine token + run token), `GET /api/hub/calls?run=&task=&tool=`,
`GET /api/providers` (manifests, enabled state, missing secrets), `PUT /api/providers/:engine/:provider` (human).
Hub process: `GET /health` local only. UI reads: integrations page (provider, connected, missing secret, last call,
error rate), calls per run/task, tool catalog with risk.

### C. T03 agent runs, T15 Clickmax job types

```
runs            + tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_usd, usage_source,
                  agent_session_id, parent_run_id null
run_results     id, tenant_id, run_id unique, label, data jsonb, at
agent_budgets   id, tenant_id, project_id, subject_kind member|job_type, subject_id, usd_per_day, tokens_per_day,
                usd_per_run
failure classes + stalled, no_outcome, limit
```

Job type file: `agent: {...}`, `stall_s`, `hub: {families, max_risk, allow_publish}`, `kind: batch | service |
interactive` (default batch). Protocol feature `stall` (`JobSpec.stall_s`). API: `POST /api/runs/:id/result`,
`GET /api/runs/:id` gains usage and result, `GET /api/indicators/agents?period=` (cost and tokens per job type, member,
day; success, no_outcome, stalled rates; p50/p90 run time). UI reads: per run model, cost, tokens, result label, data
(PR link), resume chain; daily cost against budget.

### D. T05/T06/T09 browsers

```
visual_targets  id, tenant_id, project_id, key, spec jsonb (route|story, viewport, theme), threshold
visual_baselines id, tenant_id, target_id, artifact_id, state proposed|approved|superseded, proposed_by, decided_by
```

Hub tools as §2.D 23. Pool state reported by the hub: `GET /api/machines/:m/browser` (browser up, contexts by run,
RAM). Screencast for the P5 drawer: hub WebSocket `/browser/stream?run=` with cx-env's v2 framing
(`[fmt][seq][w][h][jpeg]`, acks, input events), relayed by the control plane to authenticated members; P4 ships the
hub side and the relay, P5 the viewer. API: `GET /api/projects/:p/visual` (targets, last result, open proposals),
`POST /api/visual/baselines/:id/approve|reject` (human).

### E. T07 artifacts

`artifacts` as §2.E 27. API: `GET /api/artifacts?run=&task=` (gallery), `GET /api/artifacts/:id` (bytes, members
only), `POST /api/artifacts` (from the hub with the run token), `GET /api/tasks/:k/gallery` (index page data: per run,
kind, thumbnails, unlisted URLs). CLI `devrounds artifact put <file> --kind --visibility` (inside a run) and `devrounds
artifact list --task`. UI reads: gallery per task/PR/run, retention.

### F. T08 terminal sessions

```
sessions              id, tenant_id, run_id unique, mode hidden|visible, state working|waiting_input|question|
                      frozen|parked|ended, last_report jsonb, last_report_at, parent_session_id null
session_instructions  id, tenant_id, session_id, kind prompt|command|answer, body text, created_by,
                      delivered_at null, answered_at null
session_turns         id, tenant_id, session_id, prompt text, answer text, started_at, ended_at, tokens, cost_usd
```

Report shape (from cx-env `ui/terminals.ts:62-107`): title, tag/task, cwd, model, activity, detail, is_working, stage,
step, progress, context_pct, tokens, cost_usd, subagents `[{name, status, last_tool, tool_calls}]`, pull_request,
last_prompt, last_answer, pending_question `{text, options}`, live turn steps. Protocol feature `pty` (messages §2.F
28). API: `POST /api/sessions/:run/report` (run token; response carries the next instruction or answer), `GET
/api/sessions` (list, state, last report), `GET /api/sessions/:id`, `POST /api/sessions/:id/instructions` (human or
parent run), `POST /api/sessions/:id/answer`, `GET /api/sessions/:id/turns`, `POST /api/sessions` (open: job type, cwd,
model, prompt, mode), `POST /api/sessions/:id/close`, PTY attach WebSocket `/api/sessions/:id/pty` (human bearer). UI
reads: everything cx-env's Terminais tab shows.

### G. T16 flows, T10 task-to-pr, T11 GitHub, T17 pr-round

```
flows              id, tenant_id, project_id, key, version, document jsonb, document_sha, created_by, created_at;
                   unique (project_id, key, version)
flow_runs          id, tenant_id, project_id, flow_id, task_id, source_key null, state running|done|parked|
                   cancelled, input jsonb, started_at, ended_at; partial unique (flow_id, source_key) where running
flow_node_runs     id, tenant_id, flow_run_id, node, visit int, run_id null, outcome label, data jsonb, at
triggers           id, tenant_id, project_id, key, source webhook|schedule, filter jsonb, flow_id, throttle_per_h,
                   debounce_s, enabled
webhook_deliveries id, tenant_id, provider, delivery_id unique per provider, event, received_at, body jsonb,
                   signature_ok, processed_at
vcs_installations  id, tenant_id, provider, installation_id, repos text[], permissions jsonb
pull_requests      id, tenant_id, project_id, repo, number, task_id null, head_sha, state, ci, review, mergeable,
                   last_event_at; unique (tenant_id, repo, number)
checkouts          id, tenant_id, project_id, machine_id, task_id, path, branch, state live|merged|removed
```

API: `POST /api/flows` (document, Idempotency-Key), `GET /api/flows/:key[/:version]`, `POST /api/flows/:key/runs`,
`GET /api/flow-runs?state=&flow=` and `/:id` (node runs with their runs, the graph with visit counts), `POST
/api/flow-runs/:id/cancel|resume` (resume a parked run at a node, human), `GET /api/pull-requests` (the PR panel data:
CI, review, conflicts, ready, linked task and flow runs), `GET /api/triggers`. CLI `devrounds flow set <file>`, `flow
run <key> --task <k> --input k=v`, `flow show <run>`, `flow list`. UI reads: the flow graph document (P5 edits it),
live node states, PR panel.

### H. T12, T13, T14

T12: job type `environment:`; hub tools `environment_status|urls`; `GET /api/runs/:id` shows the lane. T13: executor
store schema v2 table `handover(run_id, pid, start_time, boot_id, run_dir, log_cursor, written_at)`; protocol feature
`adopt`, `Hello.adopted`; `GET /api/machines` shows executor version and last hand-over. T14: `measurements(finding
task, indicator, before jsonb, after jsonb, verdict improved|not_improved|insufficient, revert_task null)`; `GET
/api/findings/:k/measurement`. UI reads: per finding, the change, the before/after and the verdict.

## 4. Stages and PR decomposition

Rules for parallel work: one worktree per track under `.worktrees/`, a private test database per worktree
(`DEVROUNDS_TEST_DB` with the track name; never a shared reset), migration numbers and error codes as reserved in §3,
protocol feature names reserved (`secret-env`, `stall`, `pty`, `adopt`). Each track is one PR, or a short stack when a
review would exceed ~1500 changed lines. Each stage ends with a stage review (fresh reviewer, no open Critical or
Important), as P3 did.

**Stage 1 — independent foundations (startable now, five parallel tracks).**

| Track | Tasks             | Touches                                                                                               | Acceptance                                                                                                                                                                                                                                                                                         |
| ----- | ----------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a    | T01 vault         | control plane (secrets, kek, policy module), executor (`secret-env`, redaction)                       | canary secret injected into a run never appears in segments, tail, summary, `run show`, API responses; a dump of `secrets` without the KEK decrypts nothing (test with a second KEK); agent token gets DR453 on set/grant; ungranted use fails DR403 before spawn; values never accepted from argv |
| 1b    | T03 agent runtime | control plane (engine + `claude-code` provider, results, usage, budgets, classes), executor (`stall`) | a fake-agent script (cx-env's `scripts/fake-agent.ts` shape) runs as an agent job: reported result maps to outcome, no report → `no_outcome`, silence → `stalled`, usage parsed from stream-json; over-budget run waits with reason `budget`; resume reuses the session id                         |
| 1c    | T16 flow engine   | control plane (flows, flow runs, triggers on schedule)                                                | a flow with job, branch, wait (duration), park and a loop with `max_visits` runs end to end on synthetic job types; second run for the same source key refused DR314; flow run linked to a task with plan events                                                                                   |
| 1d    | T13 hand-over     | executor only                                                                                         | upgrade during a 10-minute synthetic run: run continues, logs have no gap or duplicate seq, control plane sees one session switch, no orphan; a run without a hand-over record stays orphan                                                                                                        |
| 1e    | T12 devlanes      | job type `environment:`, provider                                                                     | a job with `mode: with` runs inside the lane of its cwd; status read into run data                                                                                                                                                                                                                 |

The spike (T04) continues beside these. Stage 1 is startable only after the phase edge changes (§5).

**Stage 2 — hub and GitHub (after 1a; 2a and 2b in parallel, 2c after the spike).**

| Track | Tasks                                                                               | Acceptance                                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2a    | T02 hub + registry/manifests; providers linear, sentry, slack (read), google (read) | a run calls `linear_get_issue` with no Linear credential anywhere on the machine; a token from an ended run gets DR454; every call in `hub_calls` without values; `publish-external` refused unless allowed by a human-set job type                     |
| 2b    | T11 GitHub App + relay + `pull_requests`                                            | App installed with the §2.G 34 permissions only (manifest checked by a test); deliveries pulled, signature re-verified, deduped; reconciliation catches a dropped delivery within 10 min; user-to-server token minted for a run as `GH_TOKEN`, redacted |
| 2c    | T05 browser provider (after the spike), T07 artifacts storage (after 2a)            | `browser_*` tools on the spike's provider; screenshot lands as a private artifact; login applied from a `browser_login` secret without cookies in tool output                                                                                           |

**Stage 3 — Clickmax pipeline on DevRounds (after 1b, 1c, 2a, 2b).**

| Track | Tasks                                                                                 | Acceptance                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 3a    | T15 Clickmax job types + monorepo PR (`run result` calls, hub tool names, `GH_TOKEN`) | `/work` and `/ship` run as DevRounds jobs on a real card in a replay worktree                                                     |
| 3b    | T10 task-to-pr flow                                                                   | one real card goes Linear → DevRounds task → PR opened, end to end, no cx-env involvement (phase criterion 1)                     |
| 3c    | T17 pr-round on webhooks                                                              | a PR with a failing check gets a round within 2 min of the `check_suite` event; merged PR closes the flow and cleans the checkout |
| 3d    | T06 visual gate, T09 pool (parallel to 3a-3c)                                         | a changed baseline fails the gate and is approved by a human; 4 concurrent runs share one browser within the learned need         |

**Stage 4 — terminals, correction, cut-over (after stage 3; 4a and 4b parallel).**

| Track | Tasks                 | Acceptance                                                                                                                                                              |
| ----- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4a    | T08 terminal sessions | a hidden session is opened, reports, receives an instruction and an answer, spawns a child; visible attach works; parking measured; freezing decided by the measurement |
| 4b    | T14 correction loop   | one DevRounds finding goes fix → merge → measure → verdict; one forced non-improvement opens a revert PR                                                                |
| 4c    | cut-over (T18)        | 5 replayed cards; dispatch switched; cx-env paths switched off after two weeks (tracked, not blocking the phase); phase review                                          |

## 5. Tracker mapping (commands to run; not executed)

```
# Stage 1 must be startable now: replace the phase edge with task edges (P3 precedent; phase-order change, spec §15)
devrounds phase dep rm P4 --blocked-by P3 --reason "P4 stage 1 needs only delivered P1-P3 engine work; Clickmax-facing tasks carry their own task edges (P4 design §5)"

# T03 is the engine only; the Clickmax job types become T15
devrounds dep rm P4-T03 --blocked-by P4-T02 --reason "agent runtime does not need the hub; Clickmax job types moved to P4-T15"
devrounds task edit P4-T03 --title "agent-runtime engine and claude-code provider (agent job types)" --reason "P4 design §2.C"
devrounds task add P4-T15 --phase P4 --title "/work and /ship as Clickmax job types" --blocked-by P4-T02 --blocked-by P4-T03 --blocked-by P4-T11 --criterion "/work and /ship run as DevRounds jobs on a real card, results reported with devrounds run result" --criterion "Headless runs use only the DevRounds hub (--strict-mcp-config) and GH_TOKEN from the vault"
devrounds task add P4-T16 --phase P4 --title "Flow engine (job, wait, branch, park; versioned documents)" --criterion "A flow with a loop bounded by max_visits runs end to end on synthetic job types" --criterion "One live flow run per (flow, source_key)"
devrounds task add P4-T17 --phase P4 --title "pr-round flow on GitHub webhooks" --blocked-by P4-T11 --blocked-by P4-T15 --blocked-by P4-T16 --criterion "A failing check triggers a round within 2 min of the event" --criterion "Merged or closed PRs end the flow and clean the checkout"
devrounds task add P4-T18 --phase P4 --title "Cut-over of task-to-pr and pr-round from cx-env" --blocked-by P4-T10 --blocked-by P4-T17 --criterion "5 real cards replayed on DevRounds with PRs opened" --criterion "linear-card dispatch calls devrounds flow run with cx-env fallback only on exit 4/6"

devrounds dep add P4-T10 --blocked-by P4-T15 --reason "task-to-pr runs the Clickmax job types"
devrounds dep add P4-T10 --blocked-by P4-T16 --reason "task-to-pr is a flow"
devrounds dep add P4-T08 --blocked-by P4-T02 --reason "sessions use the hub and run tokens"
devrounds dep rm P4-T07 --blocked-by P4-T06 --reason "artifacts are storage; the visual gate and the browser provider consume them"
devrounds dep add P4-T06 --blocked-by P4-T07 --reason "baselines and diffs are artifacts"
devrounds dep add P4-T07 --blocked-by P4-T02 --reason "uploads go through the hub with the run token"
devrounds dep add P4-T14 --blocked-by P4-T10 --reason "fixes go through task-to-pr"
devrounds dep add P4-T14 --blocked-by P4-T16 --reason "measure and revert are flow nodes"

devrounds criterion add P4-T01 --text "A canary secret injected into a run appears in no log segment, tail, summary, API response or hub_calls row"
devrounds criterion add P4-T01 --text "Values are write-only; set and grant need a human token (DR453); ungranted use fails DR403 before spawn"
devrounds criterion add P4-T01 --text "Ciphertext is AES-256-GCM under a per-tenant data key wrapped by a KEK outside Postgres; a dump without the KEK decrypts nothing"
devrounds criterion add P4-T02 --text "HTTP-API providers run in the control plane; no integration credential exists on the machine"
devrounds criterion add P4-T02 --text "Per-run hub tokens die with the run (DR454); every call is audited without values"
devrounds criterion add P4-T03 --text "Agent runs report results; no report ends no_outcome, silence ends stalled; usage and cost recorded per run"
devrounds criterion add P4-T05 --text "Site logins are browser_login secrets; tool output never contains cookies or passwords"
devrounds criterion add P4-T07 --text "HAR and traces are always private; unlisted artifacts use a 128-bit random key and expire in 15 days"
devrounds criterion add P4-T08 --text "Instructions, answers and PTY input need a human token or the parent run's token"
devrounds criterion add P4-T08 --text "Freezing ships only if measured >= 300 MB resident freed per idle session; otherwise cancelled with the numbers"
devrounds criterion add P4-T11 --text "App permissions are exactly the P4 design §2.G 34 set, checked by a test against the manifest"
devrounds criterion add P4-T11 --text "The control plane is never reachable from the internet; deliveries are pulled, re-verified and deduped"
devrounds criterion add P4-T12 --text "A job with environment mode with runs inside its cwd's lane"
devrounds criterion add P4-T13 --text "An upgrade during a running job keeps the run, with no gap or duplicate in its log seq"
devrounds link add P4 --kind doc --ref docs/superpowers/specs/2026-11-28-p4-agent-runs-design.md --title "P4 design"
```

## 6. Left to the builder / not settled

- Browser binary install and GC of old revisions, the Authenticode check (`sys-windows::trust`), pool numbers beyond
  the spike's starting costs; the spike's "What P4-T05 and P4-T09 should build" list is the checklist.
- Exact migration shapes and index choices; TypeBox schemas for job type `agent:`, flow documents and manifests.
- Whether the hub's Node footprint fits; measure idle and with 4 contexts against a budget the builder proposes (target
  ≤ 150 MB idle without a browser).
- Redaction encodings beyond base64 and URL encoding (hex, JSON-escaped); the canary test decides.
- The relay's queue product (Workers Queues vs a Durable Object) and its retention; the relay token rotation cadence.
- ConPTY details (resize, Ctrl-C mapping, the runtime's TUI under ConPTY); terminal attach from the web is P5.
- How `devrounds run result` authenticates when the hub token is absent (non-hub job types): proposal, the run id plus
  a per-run result token minted like the hub token.
- The correction loop's indicator registry: which indicators a finding can name and their direction (lower is
  better for time and failure rate).
- Decided 28/11 (Guilherme asked for every task that does not wait on design to move now; DevRounds rule: decide,
  record, implement): (1) the phase-order change in §5 is applied, on the P3 precedent; (2) `actions: write` for CI
  reruns stays deferred (§2.G 34), so CI reruns keep going through `gh` with his login until a measured need; (3)
  unlisted artifact URLs stay acceptable for screenshots and logs meant for PRs, while HAR and traces are always
  private (§2.E 27, the P4-T07 criterion). Still needs him, at P4-T01: (4) the KEK recovery export (§2.A 2) takes a
  passphrase only he keeps; T01 ships with the export command, and he sets the passphrase when it lands.
