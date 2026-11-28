# P4-T03 report: agent-runtime engine and the claude-code provider

Branch `lane-p4-t03`, from `main` at efc601f. Not pushed, not merged, task not marked done.

## Commits

- c16836d Stop a run that goes silent past its job type's stall_s, as stalled (executor: `stall` feature, `FinishReason::Stalled`, DR154).
- c25c65e Agent job types: the agent block, the claude-code provider and the run columns (migrations 0032, 0033; contract, manifest, registry, provider, prompt, job type file).
- f9a2332 Run agent jobs: command at dispatch, events as output ships, outcome at the end (engine, results, budgets, routes, enqueue input, unplaced `budget`, DR353).
- 97f7d05 CLI for agent runs: `run result`, `budget set|list`, `run start --input`, agent lines in `run show`.

## Criterion evidence

"Agent runs report results; no report ends no_outcome, silence ends stalled; usage and cost recorded per run."

`control-plane/src/engines/agent-runtime/agent-runs.test.ts` drives agent runs through the real gateway and scheduler. The test plays the executor, runs the Offer's command (`test-support/fake-agent.ts`, a stand-in that takes the claude-code flags and prints stream-json) and ships its stdout as a log segment. No paid run is started.

| Stage 1 acceptance | Test |
|-|-|
| a fake agent runs as an agent job | "a fake agent runs as an agent job; its reported done label finishes the run..." |
| a reported result maps to the run outcome | same test (done label finishes the run); "a park label fails the run as parked..." |
| no report ends no_outcome | "a park label ... and no report at all ends it no_outcome" |
| silence ends stalled | executor `run_loop.rs` "silence_past_stall_s_stops_the_run_as_stalled" (real tree-fixture, stall_s 2, DR154 summary); control plane "silence ends stalled with the last agent event in the summary" |
| usage parsed from stream-json | first test (source `result`, cost 0.0123); "without a result line, usage comes from the transcript, each message counted once" |
| an over-budget run waits with reason `budget` | "a spent daily budget keeps the next agent run queued with reason budget, while other runs go on" (mutation check: a higher cap makes it fail) |
| a resume reuses the session id | "a retry resumes the session its run left, on the run's machine, up to resume.max" |

`agent-def.test.ts` covers the agent block's checks, prompt rendering and the manifest check (DR501).

Commands (private DB `devrounds_test_p4_t03`):

- `pnpm typecheck`: pass.
- `pnpm lint`: pass.
- `pnpm test`: 569 pass, 0 fail (559 before the change).
- `cargo build --release --workspace`: ok.
- `cargo test --workspace`: pass on 4 of 5 runs. One run had 1 failure in a 5-test binary that I could not identify, because the condensed output dropped its name; the next four runs were clean. Per the rule I did not rerun it to make it pass; it is listed under risks.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --check`: clean.
- `devrounds gate run`: not run (shared DB).

## AgentEvent (coordinator's scope addition)

The engine owns `AgentEvent` (`engines/agent-runtime/contract.ts`), which has six kinds:

- `message` (role, chars)
- `tool_call` (call, name)
- `tool_result` (call, status)
- `permission_request` (tool, decision)
- `usage` (message id plus tokens)
- `result` (outcome success|error|limit, session id, cost, usage, final text, structured value)

A provider's only output-side job is `parseLine(text) -> AgentEvent[]`. The claude-code provider maps stream-json to these events. The engine stores them per run in `agent_events`, keyed by log line, so a resent segment adds nothing. It then derives everything from them: usage, cost, session, limit, the stalled summary's last event and the text/json result.

Tool events carry name, duration_ms (paired call to result, across segments) and status only. The test asserts that the tool's input and output never reach `agent_events`. Message events keep a character count, never text. The final answer is kept only for result kinds `text` and `json`, which need it.

## Decisions

- A job type with `agent` runs `command.program` when given (tests use node plus the fake agent), otherwise the provider's `program` (`claude`). Its argv is the job type's args followed by the provider's args. Job args feed `{{job.args.N}}` and are not appended. `orphan_policy` defaults to `let_finish`.
- The prompt is rendered at enqueue only to refuse a missing value (DR101). Dispatch renders it again for the Offer. Only `{{job.args.N}}` and `{{input.key}}` exist.
- Session: claimedOffer stores a new uuid on `runs.agent_session_id` (`--session-id`), so a re-sent Offer carries the same one. A resume passes `--resume <previous id>`. At the end, the result's session id wins.
- `reported` results ignore the exit code, as cx-env does. A `done` label finishes the run. A `park` label fails it as `unclassified` with summary `parked: <label>`. Any other label fails it. No row means no_outcome. `text` and `json` become a `run_results` row with `reported_by` null. A missing answer, or json that does not parse, is no_outcome.
- Who may report: any tenant member token plus the run being `running`. Narrowing it to "only the run itself" needs a per-run token (seam below).
- Resume: only `queueRetry` with cause `retry` resumes (an automatic retry or a person's). A requeue never does. It needs the last run's session and machine, and the job must have resumed fewer times than `resume.max` (default 2). The new run gets `resumed_from_run_id` and `pinned_machine_id`, and `claim_run` honours the pin. A revoke unpins queued resumes so they start fresh elsewhere.
- Budgets: per project, for a job type or for the member who made the job. Daily caps (USD, tokens = in + out, tenant time zone) hold queued agent runs in `claim_run` via `run_over_budget`. They never stop a running one. `usd_per_run` lowers `max_budget_usd` passed to the runtime. Setting a budget is human-only (DR453).
- Stall detection is the executor's: no output growth and CPU under 1% of wall time for `stall_s`. An executor without the `stall` feature ignores `stall_s`, so its runs only end at `timeout_s`.
- `engine.no-tool-names`: `control-plane/src/providers/**` added to the exclude in `roadmap/conventions/devrounds.yaml`. Engine code names no runtime.

## Seams

- T01 (vault): the manifest's `secrets` is empty for claude-code. When T01 lands, the provider declares what it needs there, and `AgentCommand.env` is where per-run secret values would reach the run. Today the agent's `devrounds` token comes through the job type's `env_allow`.
- T02 (hub): the provider has a marked spot for `--mcp-config` and `--strict-mcp-config`. A per-run hub token would also let `reportResult` accept only the run itself.
- T16 (flows): a flow step reads `RunView.agent.result` (label, data). `runs.parent_run_id` exists (P4-T08) but nothing sets it yet.

## Risks and leftovers

- Migration order: 0032 and 0033 assume T01's 0029 to 0031 merge first. The Kysely migrator refuses unordered migrations, so whichever lands second must be renumbered.
- A resume pinned to a machine that stays offline (not revoked) waits until it returns. Only a revoke unpins it.
- The intermittent `cargo test` failure above (1 in 5 runs, test not identified).
- Not done: `GET /api/indicators/agents` and a web view of agent runs, neither of which is in the acceptance. OTel spans carry no usage attributes.
