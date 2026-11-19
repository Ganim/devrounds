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

The web view at http://127.0.0.1:4992/ signs in with that email and password (Better Auth, schema `auth`). A session
cookie only reads: every change goes through the CLI or the API with a token (DR402). `devrounds-admin login remove`
deletes a login and its sessions. Logs go to `~/.devrounds/logs/`. `devrounds-admin service uninstall` stops and
removes the task.

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
pnpm e2e          # the executor end to end: synthetic job, pnpm lint, orphan, footprint
```

`pnpm footprint` finds what the `DevRounds` and `DevRoundsExecutor` tasks run: the control plane's `supervise.ts` and the
`main.ts serve` under it, and the executor copy's `supervise` and `run` (a lane's or the e2e's processes do not count,
and a missing one fails its side by name). It waits until `GET /api/machines` reports no running job for 60 s (`DEVROUNDS_URL`/`DEVROUNDS_TOKEN` or the
`devrounds login` config) and fails over 50 MB (executor) or 300 MB (control plane), 1 MB = 1 000 000 bytes.
`--control-plane-pids` and `--executor-pids` measure given processes instead; `--idle-ms` changes the window.

`pnpm e2e` installs nothing: it builds the release binaries, starts its own control plane on the test database at
port 4993 and its own executor under `supervise` with a home and a `tree-fixture` copy in `.superpowers/tmp`, pairs it
into a fresh tenant, runs the job types of `roadmap/fixtures/job-types`, measures the footprint of its own processes and
stops those, and only those, so an installed executor service is left alone. It needs
Postgres (`pnpm db:up`) and takes about 2 minutes, most of it the 60 s idle window.

`pnpm devlanes-sync --fetch` fetches upstream devlanes into the gitignored `executor/.devlanes-cache`, stamps the fetch time
and fails (exit 1) listing every upstream commit that touches a mapped crate, partial copy or workspace file and is not
yet ported or recorded as `[[reviewed]]` in `executor/devlanes-sync.toml`. It also fails when a mapped path vanishes
upstream or `synced_commit` is missing from the cache. Without `--fetch` it only reads the cache. `pnpm test` runs the
same check against the cache as it is, so it only proves "nothing new since the last fetch" and fails when that fetch is
older than 7 days: run `pnpm devlanes-sync --fetch` first (CI must do the same).
