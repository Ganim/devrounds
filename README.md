# DevRounds

Multi-tenant AI dev platform. Read `MANIFESTO.md` for the principles and `AGENTS.md` for the invariants.

```
pnpm install
pnpm db:up      # Postgres 17 on localhost:15433 (databases devrounds, devrounds_test)
pnpm test
pnpm typecheck
pnpm lint
```

`docker/init.sql` creates the databases only when the `devrounds_pg` volume is new; on an existing volume create
them by hand.

Run the control plane on this machine (Windows):

```
pnpm -F web build                  # web/dist is gitignored; without it the server serves no roadmap view
devrounds-admin init               # ~/.devrounds/server.json
devrounds-admin migrate            # also adds authSecret (session cookies) to server.json; run it before serve
devrounds-admin service install    # scheduled task DevRounds: supervisor + server on 127.0.0.1:4992
```

Then create the tenant and an agent token, log the agent CLI in and load the roadmap:

```
devrounds-admin bootstrap --tenant <name> --project devrounds --name DevRounds --human <name>   # prints a human token once
devrounds-admin token create --tenant <name> --member <agent> --kind agent                      # prints an agent token once
devrounds login --url http://127.0.0.1:4992 --token <agent token> --project devrounds
devrounds plan import roadmap/snapshot.yaml
devrounds-admin login create --tenant <name> --member <human> --email <email>                  # prints a web password once
```

A tenant can hold several projects: `devrounds-admin project add --tenant <name> --key <key> --name <project name>`.
Every `devrounds` command except `login` takes `--project <key>` to use that project for one invocation instead of
the configured one; a key outside the token's tenant answers DR201.

The web view at http://127.0.0.1:4992/ signs in with that email and password (Better Auth, schema `auth`). A session
cookie only reads: every change goes through the CLI or the API with a token (DR402). `devrounds-admin login remove`
deletes a login and its sessions. Besides the roadmap, the view shows machines (free memory, the needs reserved by
offers and the reserve), queues, jobs, runs and one run with its log, at `#/machines`, `#/queues`, `#/jobs`, `#/runs`
and `#/run/<id>`. Logs go to `~/.devrounds/logs/`. `devrounds-admin service uninstall` stops and
removes the task.

The task runs `supervise.ts` under a hidden `conhost`, and `supervise` restarts `serve` when it exits. `supervise`
exits when the process that started it is gone, and `serve` stops with it, so stopping the task (`schtasks /End`,
Stop-ScheduledTask) stops both and the next run starts the code on disk. Started by hand from a shell
(`node control-plane/src/service/supervise.ts`), `supervise` exits when that shell closes. A `serve` that finds its port
taken exits with DR504, naming the process that holds the port.

## Executor

The executor is a Rust workspace under `executor/` (Windows 11, toolchain pinned in `executor/rust-toolchain.toml`;
rustup picks it up only when cargo runs inside `executor/`). Its crates are copied from devlanes;
`executor/NOTICE` lists the origin and every change.

```
cd executor && cargo build --release   # target/release/devrounds-executor.exe
pnpm test:executor                       # cargo test for the whole workspace
pnpm lint:executor                       # rustfmt check + clippy with -D warnings
```

The `sh.exe` tests need Git for Windows on `PATH`.

Pair this machine and run the executor as a service (the control plane must be running):

```
devrounds machine pair-code --name <machine>                       # human token; prints the pair command
executor\target\release\devrounds-executor pair --url http://127.0.0.1:4992 --code <code>
executor\target\release\devrounds-executor service install          # scheduled task DevRoundsExecutor
```

`service install` needs a paired home (`~/.devrounds/executor`, or `DEVROUNDS_EXECUTOR_HOME` set as a user variable so
the task sees it). It copies the binary to `<home>\bin`, so later builds neither fail on a locked file nor change the
running service; run it again to install a new build. The task starts `supervise` under a hidden console at logon (and
every 5 minutes if it is gone); `supervise` keeps `run` going with the control plane's restart backoff (1 s doubling to
30 s, reset after 5 min up) and writes `<home>\logs\executor-YYYY-MM-DD.log` (UTC days, rolling to `.1`, `.2`, ...
past 10 MB, 14 days kept). One `supervise` runs per home; a second one exits at once. `run` exits when its supervisor
does; runs keep going and the next `run` reports them as orphans. `service uninstall` stops and removes the task and the
copy, and keeps the home; run it from the build, not from the installed copy, which cannot delete itself.

`devrounds run start <jobType> --cwd <path>` queues a run (`--machine <name>` pins it, `--queue <key>` picks a queue);
it never fails because no executor is connected. The control plane's scheduler offers queued runs to connected machines
that sent a `MachineReport` in the last 30 s, the one with the most free memory first, as long as the run's learned
memory need fits in free memory minus the reserve (a tenth of the total, at most 2 GiB) minus the needs already
offered there. It wakes on a Postgres NOTIFY (`devrounds_scheduler`) when a run is queued or ends, when an executor
connects or reports, and on a poll every `schedulerPollS` seconds (default 15, `DEVROUNDS_SCHEDULER_POLL_S`), which
keeps placing runs if its LISTEN connection is down. `offerTimeoutS` (default 120, at least 5,
`DEVROUNDS_OFFER_TIMEOUT_S`) is how long an executor has to answer an Offer. Both go in `server.json` or the
environment. An Offer with no answer in time (any event of the run, `Delayed` included, answers it) is withdrawn: the
run stops with class infra, a new run of the same job is queued (cause `requeue`, which never counts toward the job
type's `max_attempts`), and the executor's live session, if any, is closed with 4408. Stopping an offered run of a
machine that is not connected ends it at once the same way, withdrawn, with class cancelled. The next `HelloAck` lists
the runs withdrawn in the last 7 days, and the executor drops those it still holds before they start (one already
started is stopped). At start, `serve` gives every pending Offer a full timeout again before its first tick, so offers
made before a crash are not withdrawn while their executors reconnect. The control plane pings each executor session
every 15 s and ends it after two pings go unanswered; the executor drops a session that sent no frame for 45 s and
reconnects after 1 s, doubling to 30 s, each wait moved by up to ±20 %.

```
pnpm footprint    # after 60 s with no job running: private bytes of both services against their budgets
pnpm e2e          # the executor end to end through the scheduler (scenarios below), then the footprint
```

`pnpm footprint` finds what the `DevRounds` and `DevRoundsExecutor` tasks run: the control plane's `supervise.ts` and the
`main.ts serve` under it, and the executor copy's `supervise` and `run` (a lane's or the e2e's processes do not count,
and a missing one fails its side by name). It waits until `GET /api/machines` reports no running job for 60 s (`DEVROUNDS_URL`/`DEVROUNDS_TOKEN` or the
`devrounds login` config) and fails over 50 MB (executor) or 300 MB (control plane), 1 MB = 1 000 000 bytes.
`--control-plane-pids` and `--executor-pids` measure given processes instead; `--idle-ms` changes the window.

`pnpm e2e` installs nothing: it builds the release binaries, starts its own control plane on the test database at
port 4993 (offers expire after 5 s, the scheduler polls every 2 s) and its own executor under `supervise` with a home
and a `tree-fixture` copy in `.superpowers/tmp`, pairs it into a fresh tenant and runs the job types of
`roadmap/fixtures/job-types`, every run placed by the scheduler: synthetic, `pnpm lint`, a schedule every 60 s, the dag
batch red then green, a retry, an offer that expires on a suspended `run` and is requeued, an orphan, and a re-pair.
It then measures the footprint of its own processes (and `serve` alone against a 230 MB early warning) and stops
those, and only those, so an installed executor service is left alone. It needs Postgres (`pnpm db:up`) and takes
about 4 minutes, most of it the schedule's first fire and the 60 s idle window.

`pnpm devlanes-sync --fetch` fetches upstream devlanes into the gitignored `executor/.devlanes-cache`, stamps the fetch time
and fails (exit 1) listing every upstream commit that touches a mapped crate, partial copy or workspace file and is not
yet ported or recorded as `[[reviewed]]` in `executor/devlanes-sync.toml`. It also fails when a mapped path vanishes
upstream or `synced_commit` is missing from the cache. Without `--fetch` it only reads the cache. `pnpm test` runs the
same check against the cache as it is, so it only proves "nothing new since the last fetch" and fails when that fetch is
older than 7 days: run `pnpm devlanes-sync --fetch` first (CI must do the same).

## Queues, batches and schedules

Every run waits in a queue of its project. `default` is created the first time a run uses it; any other queue is
created first:

```
devrounds queue set <key> [--priority <n>] [--concurrency <n>|none] [--machine-concurrency <n>|none]
                    [--job-types <a,b>|none]
devrounds queue list     # depth = runs queued, in flight = offered, admitted or running
```

The scheduler takes the queue with the highest priority first and the oldest run in it first. `--concurrency` caps
the runs in flight in the queue and `--machine-concurrency` the ones on a single machine (both count offered, admitted
and running runs); `--job-types` lists the job types allowed in it (any other answers DR153).

A batch queues several jobs at once, all or nothing, with dependencies by `ref` inside the file (a cycle answers DR152).
Each job also takes `machine`, `queue` and `task`:

```yaml
jobs:
  - ref: build
    job_type: dag-build
    cwd: C:\src\app
  - ref: test
    job_type: dag-test
    cwd: C:\src\app
    depends_on: [build]
```

```
devrounds batch submit <file.yaml>   # each job with its run
devrounds batch show <id>            # failed and skipped jobs first
```

A job can also carry `args` (appended to the job type's `command.args`, at most 200 of up to 4096 characters) and
`env` (values by variable name, at most 50, names `[A-Za-z_][A-Za-z0-9_]*` up to 200 characters, values up to 4096),
in a batch file or with `devrounds run start ... [--arg <a>]... [--env NAME=value]...` (`--arg=--flag` for a value
that starts with a dash). The job type decides what a job may give: `args_from_job: true` takes job args, and
`job_env: [NAME, ...]` lists the names a job may set (anything else answers DR101 at the job's `args` or
`env/<NAME>`). `env_set: { NAME: value }` gives every run of the job type a value; a job's value for the same name
wins. Names compare ignoring case, as Windows does, and `DEVROUNDS_RUN_ID` is the executor's alone. These values are
stored on the job and the job type and sent to the machine, so they are names and flags (a database name, a shard
number), never secrets: a secret stays in the machine's environment and reaches the run through the job type's `env`
allowlist. The scheduler offers runs only to executors that speak the `job-env` protocol feature, since an older one
would drop these values; update the executor along with the control plane.

```yaml
key: test-shard
command: { program: node, args: [--test] }
args_from_job: true
job_env: [DB_NAME]
env_set: { LOG_LEVEL: warn }
```

A batch job can carry a `cache_key` (1 to 200 characters) that names its inputs, such as a tree hash. The caller
computes it; DevRounds never reads the repo. When a run of the same project, job type and `cache_key` finished within
the last 7 days, the new job ends `finished` at submit and its run points to that run (`cached from <id>` in
`devrounds run show`, `(cached)` in `devrounds batch show`); nothing runs, and the jobs that depend on it can start at
once. The newest such run is the source. A job behind a job that runs is never a hit: a job with `depends_on` is a
hit only when every job it depends on is a hit of the same submit, so the rules above for dependencies still hold. A failed run, a run that was itself a cache hit, an older one, or one of
another job type or project never answers, so the job runs. Cache hits are not counted in `devrounds indicators`.

A job type can state a starting need with `need_mb` (MiB, 1 to 1048576, like the 512 MiB default). It is the memory the
scheduler reserves for a run while the key (job type on a machine) has fewer than 3 samples; from the third on, the
median peak of its last 10 runs wins.

A job is offered only once every job it depends on finished. When one fails or is stopped, every open job waiting on
it, directly or through others, becomes `skipped` and is never offered. A job type's `retry` decides when a failed run
is tried again: `on` lists the failure classes (default `[infra]`), `max_attempts` counts the attempts (default 1, no
retry) and the next attempt is queued `backoff_s × 2^(attempt − 1)` seconds after the run ended (default 30, at most
1 h). A requeue after an expired offer is not an attempt. `roadmap/fixtures/job-types/flaky.yaml` and
`roadmap/fixtures/batches/dag.yaml` are the examples `pnpm e2e` runs.

A schedule queues a job of a job type on a clock:

```
devrounds schedule set <key> --job-type <jt> --cwd <path> (--every <seconds> | --daily HH:MM) [--queue <key>] [--machine <name>] [--disable]
devrounds schedule list
```

`--every` is at least 60 s, counted from the last fire; `--daily` is the wall clock of the tenant time zone. A schedule
whose last job is still open lets that fire pass, and one missed while the control plane was down fires once when it
is back. `schedule set` replaces the whole definition; saving the same timing again keeps the clock.

`devrounds run list` and `devrounds indicators` (runs, queue wait, run time and failure classes per day or week) read
what happened; the web view shows the same at `#/queues`, `#/jobs` and `#/runs`.
