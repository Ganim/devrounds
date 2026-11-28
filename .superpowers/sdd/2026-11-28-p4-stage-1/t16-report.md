# P4-T16 report: flow engine (job, wait, branch, park; versioned documents)

Branch `lane-p4-t16` (from main), commits:

- `2a37265` Flow engine: migration 0035_flows (flows, flow_runs, flow_node_runs, due_flow_waits), document checks, engine,
  service, DR203 and DR314, job end hook (jobs/outcome.ts) and wait wake (scheduler tick).
- `316efc2` Flow API (`/api/projects/:key/flows`, `/flow-runs`) and CLI (`devrounds flow set|run|show|list|runs|cancel|resume`).

## Criteria

1. A loop bounded by max_visits runs end to end on synthetic job types: engine.test.ts "a loop bounded by max_visits
   runs end to end and parks one visit past its bound" (job, wait, branch, park, finish; trail, visits, job task,
   templates, plan events) and "a red build waits and builds again; a green one branches to finish".
2. One live flow run per (flow, source_key): partial unique index `flow_runs_live_source` plus an advisory lock;
   engine.test.ts "one live flow run per (flow, source key)..." (also across versions) and cli.test.ts "flow set, run,
   show and cancel over the server; a second run for one source key exits 1 with DR314".
   The flow run is linked to a task, and plan events `flow_run_start|flow_run_end|flow_run_resume` are written.

## Coordinator additions

- (a) A park node records `{reason, ask_schema}`, where `ask` is an optional, small JSON Schema subset (object of
  string/number/integer/boolean, enum, bounds, required). `POST /flow-runs/:id/resume` (human only, DR453) checks the
  answer and fails DR101 at `/answer/<field>`. engine.test.ts "a park node with ask resumes with a checked answer that
  the next node reads". Everything fits in 0035; 0036 and 0037 stay free. Rerun-from-node was not built and is
  left as a separate task.
- (b) Version pinning was already in the design: `flow_runs.flow_id` points at one version row, and the engine reads
  that document at every step. engine.test.ts "flow set stores a new version only when the document changes; a run
  keeps its version" proves it: v2 changes the path, and the running v1 run still follows v1.

## Tests (private DB devrounds_test_p4_t16 only)

`DEVROUNDS_TEST_DATABASE_URL=...p4_t16 DEVROUNDS_TEST_ADMIN_DATABASE_URL=...p4_t16 pnpm test`: 573 pass, 0 fail.
`biome check --error-on-warnings .`: clean. `tsc -p control-plane`: clean. `tsc -p web` has 3 errors, the same count
on main without this branch, so they are not caused by it. `devrounds gate run` was not run.

## Risks

- Migration order: 0035 can land before 0029-0034, and Kysely's Migrator refuses out-of-order migrations, so the
  merge order matters, or a rename is needed.
- Triggers (webhook/schedule) and event waits are not built (T17). Job outcome labels are only done/failed/stopped
  until T03 reports results.
- Cancel stops the live job run before answering (prepareStop). A run on an offline machine (DR350) is left as it is
  and only logged; its later end moves nothing.
- DR203 is reused for "no park node to resume at".
