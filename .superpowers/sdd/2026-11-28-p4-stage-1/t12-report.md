# P4-T12 report: job environment mode

Branch `lane-p4-t12` (from main efc601f), worktree `C:/Users/Guilherme/Code/devrounds-lanes/p4-t12`.

## Commits

- 83af1d9 Run a job's environment probe before the run and report it on RunStarted
- 904346d Job type environment: run inside the cwd's devlanes lane and show the lane on the run
- 217b14d Format the environment mode files
- dc1c2dd E2E: run a job type inside this worktree's devrounds-e2e lane
- 2d26ab5 README: document job type environment mode

## Design

Job type field `environment: {provider: devlanes, mode: with|status}` (migration 0052: `job_types.environment`, `runs.environment`, both jsonb). The control plane provider (`control-plane/src/environments/`) wraps the command (`with` → `devlanes with -- <cmd>`) and adds `environment_probe` (`devlanes status --json`) to the offer. The executor runs the probe in the job cwd inside the admission slot (15 s timeout, 1 MiB cap; `executor/crates/executor/src/environment.rs`) and sends `RunStarted.environment {output, exit_code, error}`. The control plane reduces it to the cwd's lane and stores it in `runs.environment`; `GET /api/runs/:id` and `devrounds run show` show it. Protocol change is additive: optional fields, new feature `environment`; old peers ignore them. Hub tools are left for T02.

## Validation (private DB devrounds_test_p4_t12)

- `cargo build --release --workspace`: ok. `cargo test --workspace`: 269 passed, 0 failed. clippy clean.
- `pnpm typecheck`: ok. `pnpm test`: 563/563 passed. `npx biome check --error-on-warnings .`: clean.
- `pnpm e2e`: PASS (240 s). The lane stage ran node inside `devrounds-e2e@1`, read `mark lane-lane1` from the lane env, and cleaned the lane registration afterwards. No devrounds-e2e lane is left.

## Risks

- The probe runs before the command, so it delays start by up to 15 s, and a stop during the probe waits for it.
- The job type `env` allowlist has to include what devlanes needs (PATH, USERPROFILE, APPDATA, LOCALAPPDATA, ...). See `roadmap/fixtures/job-types/lane.yaml`.
- Old executors still run the wrapped command, but they report no lane ("predates feature environment"). Placement does not gate on the feature.
- If the job type changes between offer and RunStarted, the reading is stored against the new environment config.
- `devlanes status --json` (~110 KB for clickmax, capped at 1 MiB) rides RunStarted. Only the reduced lane is stored.
- The e2e registers a `devrounds-e2e` project lane per worktree and cleans it in `finally`.
