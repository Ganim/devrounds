# DevRounds P6 Cloud and second tenant — design

Status: written 28/11 by Claude; Guilherme reviews after the fact (he asked on 17/11 not to wait for approval). Decisions
marked **[security]** change who can reach the control plane, a credential or a machine; the phase review reads them
first. Parent spec: `C:/Users/Guilherme/Code/Clickmax/cx-env/docs/superpowers/specs/2026-11-16-devround-foundation-design.md`
("the spec", §2 non-goals, §5.2, §5.3, §5.7, §6, §11.4, §11.6, §14 "Isolation is an engine", §16.6). P1 stage-2 plan
(`docs/superpowers/plans/2026-11-19-p1-stage-2-scheduler.md`, calls 5, 13, 14). P4 design
(`2026-11-28-p4-agent-runs-design.md` §2.A 2, 6, 7; §2.E 27; §2.G 34, 35), which hands P6 the cloud KEK, TLS before
remote `secret-env`, the signed-URL artifact fix and direct webhooks. P5 design (`2026-11-28-p5-interface-design.md`
row 7, calls 6, 7, 11).

Roadmap (28/11): P6 goal "The control plane runs in the cloud and a second tenant works beside Guilherme's"; tasks
P6-T01 cloud control plane, T02 compute providers beyond local (after T01), T03 isolation/container, T04 second tenant
(after T01); T05-T08 were small fixes and are done (DST balance test, unique tenant names, pairing limiter per source,
supervise single-instance lock); T09 agent experiments was added by the controller on 28/11 (§2.G 27-28). P4-T21 (an
`anthropic-api` provider for judgment and triage jobs inside the control plane) also lands on this deployment (§2.A,
last paragraph). Phase criteria: a second tenant runs jobs on the cloud control plane without seeing the
first tenant's data; final review. Phase edge: blocked by P5.

## 1. What exists today (inventory, 28/11, main at `efc601f`)

Paths are relative to `control-plane/src` unless they start with `executor/`.

### 1.1 Control plane process

- `serve` binds `127.0.0.1` only, hard-coded (`main.ts:94`); config fields are `databaseUrl`, `port`, `logsRoot`,
  `logRetentionDays`, `schedulerPollS`, `offerTimeoutS`, `otlpEndpoint`, `authSecret` (`config.ts:13-24`). No host,
  public URL or proxy setting.
- Run as the Windows scheduled task `DevRounds` through `service/supervise.ts` with a single-instance lock (P6-T08);
  `service/install.ts` is PowerShell only. `portHolder` uses netstat on Windows only (`main.ts:110-133`).
  `owner-only.ts` already does `chmod 600` off Windows.
- In-process state that assumes one `serve`: executor sessions (`executor/gateway.ts:71`, `Sessions` map), the pairing
  limiter (`machines/pairing.ts`, memory, P6-T07), Better Auth's rate limit (memory storage, `auth/session.ts:62`), the
  scheduler poke after `HelloAck`/`MachineReport` (P1 plan call 5: "one `pg_notify` per report when a second `serve`
  appears").
- Pairing failures are keyed by `request.ip` with no `trustProxy` (`executor/gateway.ts:403`), correct only while
  nothing sits in front of `serve`.
- Better Auth: `baseURL` and `trustedOrigins` are loopback, `useSecureCookies: false` (`auth/session.ts:47-74`); the
  cookie name `devrounds.session_token` is a constant (`auth/session.ts:13`) matched by a regex in `api/members.ts:8`.
  Cookies only read (DR402, `api/members.ts:18`); P5-T10 adds guarded cookie writes.
- Run log segments are files under `logsRoot/<tenant>/<run>/` with paths relative to the root
  (`runs/log-store.ts:34-41`), pruned after 14 days.

### 1.2 Database roles

- `devrounds-admin migrate` refuses a non-superuser admin connection (`db/migrate.ts:25-38`): the security definer
  functions read across tenants only because their owner bypasses RLS. They are `resolve_token` (0001),
  `redeem_pairing_code` and `resolve_machine_token` (0004), `expired_log_segments` (0006), `claim_run` (0011, 0027),
  `expired_offers` and `rearm_offers` (0013), the schedule sweep (0014), the idempotency sweep (0015),
  `resolve_session` (0016). The app role is forced `nosuperuser nobypassrls` on every migrate (`migrate.ts:74-104`).
- Local Postgres is `postgres:17` in `docker-compose.yml` on `127.0.0.1:15433`, owner `postgres`/`postgres`. AGENTS.md
  records this as an accepted P0 exception "Removed in P6 (cloud, managed owner role)".

### 1.3 Tenancy

- `tenants(id, name unique (0028), timezone)`; every other table has `tenant_id`, forced RLS through `isolate()`
  (`db/migrations/0001_core.ts:163-170`), composite FKs, and the catalog guard (`test-support/catalog.ts`) fails a
  table without them. `withTenant()` (`tenancy/scope.ts`) is the only door.
- Tenants, members, projects, tokens and logins are created by the operator only (`admin.ts`: `bootstrap`,
  `project add`, `token create|revoke`, `login create|remove`). One tenant per login (`members_user` unique index,
  0016; P1 plan call 14).
- Cross-tenant tests exist per module (for example `api/api.test.ts:70`), but nothing lists every route and proves
  each one against a second tenant. No per-tenant limits; usage is only what `runs` rows record.

### 1.4 Executor

- Windows only: every module that touches the OS is `#[cfg(windows)]` (`executor/crates/executor/src/lib.rs`,
  `bins/devrounds-executor/src/main.rs`); OS code lives in `runner-windows`, `metrics-windows`, `sys-windows`, behind
  the `core` traits (`core/src/runtime.rs` `Runner`/`Unit`, `core/src/gate.rs` `PressureSource`). The P1 design (§
  line 121) puts Linux adapters at "the first Linux machine (P6, VPS/cloud)".
- The URL rule already forces TLS off loopback: `http://`/`ws://` reach only `127.0.0.1`, `::1` or `localhost`
  (`executor/crates/executor/src/config.rs:221-262`); TLS is rustls with ring, roots from the OS (workspace
  `Cargo.toml`).
- `Isolation` trait with one implementation, `NoneIsolation` (`executor/crates/executor/src/isolation.rs:31-50`):
  absolute `cwd` that must exist, env allowlist, `env_set`.
- `JobSpec` = job type, program, args, absolute `cwd`, `env_allow`, `timeout_s`, `env_set`
  (`executor/crates/core/src/job.rs`). Protocol 1, features `seq`, `steps`, `log-segments`, `orphans`,
  `trace-context`, `acked-through`, `withdraw`, `job-env` (`executor/protocol.ts:9-18`); P4 reserves `secret-env`,
  `stall`, `pty`, `adopt`.
- Pairing: a human mints a single-use code (`requireHuman`, `machines/pairing.ts:30`), `redeem_pairing_code` creates
  the machine. `machines.compute_provider` (default `local`) and `lifecycle` (`persistent | ephemeral`) exist since
  0004 and are never set to anything else. No workspace table; P4-T11 adds `checkouts` for `/work` worktrees.

### 1.5 Numbers P6 must not collide with

Migrations on main end at `0028`; P4 reserves `0029-0051` (P4 §3). P6 uses `0060-0079`, P7 `0080-0089`. Codes in
`errors/codes.ts`: DR101, 103, 104, 150-153, 201, 202, 301-313, 350-352, 401, 402, 450-453, 501-504, 550-553. P4
reserves DR105, DR154, DR203, DR314, DR353, DR403, DR454, DR505, DR554; P5 adds none. P6 takes DR106, DR315, DR316,
DR319, DR354, DR455, DR506, DR556 (§3).

## 2. Decisions (28/11, Claude)

Each with why and its cost if wrong.

### A. Hosting (T01, T10, T11)

1. **One Linux VM, one `serve`, containers per process.** Docker Compose on the VM runs `caddy` (edge), `control-plane`
   (the image, `serve` under the container's restart policy instead of the Windows supervisor) and `postgres`. Exactly
   one `serve` per deployment in P6: the in-process state of §1.1 stays correct, and the restart of a single process
   is what P1 §11.6 already designed for (executors finish admitted runs, buffer in the outbox, reconnect). Size:
   2 vCPU, 4 GB RAM, a separate 50 GB data volume for Postgres, logs and artifacts (budget §16.6: control plane idle
   ≤ 300 MB, Postgres `shared_buffers` 256 MB). Why: the spec's "the control plane itself ships as a container image";
   a second instance buys nothing at one or two tenants. Cost if wrong: HA needs the P1 call-5 notify path, a shared
   limiter and sticky executor sessions; nothing in the schema changes.
2. **Cloud vendor: AWS, region `sa-east-1` (São Paulo).** One account holds the VM (EC2), the KEK (KMS, §A6), the
   ephemeral pools (EC2, §C) and backups (S3). São Paulo because every hub call from Guilherme's machine is one round
   trip to the control plane (P4 §2.B 10) and his machines are in Brazil. Vendor names live only under `providers/`
   (P4 §2.B 14; the `engine.no-tool-names` rule applies). Not Clickmax's Kubernetes cluster: DevRounds is a product of
   its own and its tenants must not share a blast radius with Clickmax. Cost if wrong: the VM moves with its compose
   file; the KEK moves by rewrapping data keys (P4 envelope design), the pool provider is one module.
3. **[security] Postgres runs on the VM; the owner is a non-superuser role on every deployment, local included
   (T10).** Role `devrounds_owner` with `LOGIN BYPASSRLS CREATEROLE NOSUPERUSER`, owner of the database and of every
   DevRounds object. `assertRoles` (`db/migrate.ts:25`) changes from "superuser" to "BYPASSRLS and CREATEROLE, not
   superuser"; the security definer functions keep reading across tenants because their owner bypasses RLS. The
   superuser is used once, by `devrounds-admin owner init --superuser-url <url>` (creates the role, transfers ownership
   of every object in `public`, `auth` and `devrounds_migrations`, prints the owner URL to put in `server.json`); after
   that `server.json` holds no superuser credential. The AGENTS.md P0 exception is removed. Why on the VM and not a
   managed database: the owner role needs `BYPASSRLS`, which we control on our own server and would otherwise depend
   on each managed product's grants; backups are §A8. Cost if wrong: moving to a managed Postgres later is a
   `pg_dump`/restore plus a check that the product grants `BYPASSRLS`.
4. **[security] Caddy is the only listener; `serve` sits behind it with exact proxy trust.** Caddy (Apache-2.0)
   terminates TLS with ACME on the public host name, redirects 80 to 443, streams SSE and WebSockets unbuffered. `serve`
   listens on `0.0.0.0:4992` inside the compose network only (new config `host`, default `127.0.0.1`; the port is not
   published). New config `publicUrl` (`https://<host>`) and `trustProxy` (the Caddy container address, never a
   range or `true`): Fastify then derives `request.ip` from `X-Forwarded-For` only when the socket is Caddy, so the
   per-source pairing limiter of P6-T07 keeps its meaning (`executor/gateway.ts:403`; its test is adapted to "a header
   from a non-proxy socket is ignored"). Better Auth gets `baseURL = publicUrl`, `trustedOrigins = [publicUrl]` and
   secure cookies when `publicUrl` is https, so the cookie becomes `__Secure-devrounds.session_token`; the name moves
   to one function used by `auth/session.ts` and `api/members.ts`. Security group: 80 and 443 in, nothing else; no SSH
   key on the VM; administration through AWS Systems Manager sessions (IAM-authenticated, no open port), running
   `docker compose exec control-plane devrounds-admin ...` as the owner. Cost if wrong: a forgotten published port is
   caught by the deploy check in T11 (an external probe of every port but 80/443 must fail).
5. **[security] What is public.** Through Caddy: the web app, `/api/*` (member routes need a token or a session, as
   today), `/api/executor/pair` and `/api/executor/connect` (pairing code / machine token), `POST /api/webhooks/github`
   (signature-verified, P4-T11 handler called directly; the P4 pull relay stays as a fallback for 7 days without a
   delivery through it, then its Worker is deleted, P4 §2.G 35), `GET /a/<key>` for unlisted artifacts (below), and
   `GET /api/executor/binaries/*` (§C 16). Nothing else exists to expose. Unlisted artifacts (P4 §2.E 27) are served by
   the control plane from the `storage` engine at `/a/<128-bit key>` with the artifact's expiry, instead of a public
   bucket URL, so private-repo screenshots are no longer reachable on the bucket: this is the "signed-URL proxy" P4
   left to P6. Cost if wrong: P4-T11's criterion "the control plane is never reachable from the internet" holds for
   the local deployment only; this decision supersedes it for the cloud one and the phase review checks both.
6. **[security] KEK provider `kek/cloud-kms`, first implementation AWS KMS.** One symmetric KMS key per deployment;
   the VM's instance role may only `Encrypt`, `Decrypt` and `GenerateDataKey` on that key (no static AWS key on disk).
   Data keys are wrapped and unwrapped through KMS at use and cached in memory for 10 min (P4 §2.A 2 keeps per-tenant
   data keys). The local control plane keeps `kek/dpapi-local`. Cost if wrong: a KMS outage makes secret resolution
   fail with DR505 (P4 code); runs that need no secret go on.
7. **[security] `secret-env` only over TLS.** The gateway marks a session `secure` when the socket is loopback or the
   request reached `serve` through the trusted proxy with `X-Forwarded-Proto: https`. The scheduler never offers a run
   carrying `secret_env` or a hub token to a session that is not `secure` (wait reason `insecure_link`); `run start
   --machine` pinning such a run to such a machine answers DR354. This closes P4 §2.A 6 ("P6 adds TLS before any
   non-local executor may negotiate `secret-env`"); the executor side already refuses plain links off loopback.
   Cost if wrong: none for honest setups; a local executor through a plain reverse proxy has to use https.
8. **Backups: daily EBS snapshots of the data volume (kept 7 days) and a weekly `pg_dump -Fc` to S3 with SSE-KMS
   (kept 8 weeks).** The snapshot covers Postgres, logs and artifacts together (crash-consistent; Postgres recovers from
   WAL); the dump is the portable copy. T01 acceptance includes a restore drill: the latest dump into a scratch
   database, `devrounds plan export` byte-equal to the live one. Cost if wrong: up to 24 h of data lost on a volume
   failure; acceptable at this size.
9. **Deploy = image by commit, migrate, then up.** The image (`docker/control-plane.Dockerfile`, Node 24, `pnpm
   install --frozen-lockfile --prod`, the built `web/dist`) is built by a DevRounds job on `linux-1` (§B 12), tagged
   with the commit sha and pushed to a private ECR repository. `scripts/deploy.ts` runs through SSM: pull, one-shot
   `devrounds-admin migrate`, `docker compose up -d control-plane`, then `GET /api/health` must answer the new version
   within 60 s or the previous tag is restarted. Executor versions stay within the skew window (spec §5.3). Cost if
   wrong: a few seconds of downtime per deploy; executors reconnect.
10. **Cutover of Guilherme's tenant: dump, restore, repoint; rollback within 48 h.** Order: stop the local
    `DevRounds` task (executors buffer); on his machine `devrounds-admin kek rewrap --to cloud-kms` (needs DPAPI and
    the KMS key at once, so it runs there); `pg_dump` of the local database, restore into the cloud one with
    `--no-owner --role devrounds_owner` (Better Auth sessions dropped: the cookie name and origin change anyway); copy
    `logsRoot` and the local artifacts (paths are relative, §1.1); start the cloud `serve`; on each machine
    `devrounds-executor repoint --url <publicUrl>`, a new command that opens a session with the existing machine token
    and writes `config.json` only if the new control plane accepts it (DR455 otherwise), so machine ids, learned needs
    and run history carry over; `devrounds login --url <publicUrl>` for the CLI and the `DEVROUNDS_URL` user variable
    for scheduled jobs; the GitHub App webhook URL points at `/api/webhooks/github`. Check: `devrounds plan export`
    before and after are byte-equal, and DevRounds's own gate runs green from his machine. Rollback in the first 48 h
    is the same procedure in reverse (cloud dump back to local); the local database is kept untouched for 14 days,
    then dropped. The local stack (`docker-compose.yml`, `127.0.0.1:4992`) stays for development and tests. Cost if
    wrong: about an hour of downtime; writes made on the cloud after a rollback point are lost.

**Judgment jobs with no executor (P4-T21 on the cloud).** P4-T21's `anthropic-api` provider runs judgment and triage
jobs inside the control plane process. On the cloud deployment they run on the VM with no executor involved: the API
key comes from the vault through the KMS KEK (§A 6), calls leave through the VM's egress (the security group allows
all egress, inbound stays 80/443), tokens and cost land in `tenant_usage_daily` and count against the tenant's limits
(T14), and their concurrency is capped per tenant (default 2) so a burst of triage jobs stays inside the control plane
budget of §16.6. No tenant code runs in these jobs, only model calls, which is why they may share the VM when other
runs may not (§B 12). Cost if wrong: if they outgrow the VM, the same job type moves to a pool machine as an ordinary
agent job.

### B. Linux executor (T12)

11. **Linux adapters behind the existing `core` traits, three crates: `runner-linux`, `metrics-linux`, `sys-linux`.**
    One cgroup v2 per run is the Job Object analog: the run's tree is spawned into it, footprint = `memory.peak` and
    `memory.current` of the cgroup (commit-like: anonymous plus page cache charged to it, spec §16.5's intent), stop =
    the staged signals (SIGTERM to the process group, 10 s grace) then `cgroup.kill`. Memory pressure from PSI
    (`/proc/pressure/memory`) feeds the existing AIMD admission; process identity = (pid, start time from
    `/proc/<pid>/stat`, `boot_id`), so orphan detection works as on Windows. The service is a systemd system unit
    running as user `devrounds` with `Delegate=yes`, so the executor owns its cgroup subtree;
    `devrounds-executor service install` writes it. The "one place that starts processes" invariant gains
    `devrounds_sys_linux::spawn`; `executor-guards.test.ts` checks both. Linux executors negotiate the P1-P2 features
    plus `secret-env` and `stall`; not `pty` (ConPTY is Windows; Linux terminals come with the first Linux interactive
    need) and not `adopt` (an ephemeral machine is replaced, a VPS is drained then restarted). x86_64 only. Cost if
    wrong: a host without cgroup v2 delegation cannot run the executor; `service install` refuses with DR556 instead of
    running unsupervised.
12. **`linux-1`: one persistent Linux VPS in Guilherme's tenant (`compute/vps`), for Linux builds and tests.** It
    builds the Linux executor and the control plane image, and runs a Linux leg of DevRounds's own gate (`cargo test`
    of the Linux crates, `pnpm test` in the control plane image against a Postgres container). Jobs never run on the
    control plane VM (a run there would share a host with every tenant's data). Cost if wrong: one small VM of
    monthly spend; once pools exist (§C) the build can move to an ephemeral pool.

### C. Compute engine (T02)

13. **The `compute` engine with the contract of spec §5.7: `provision`, `describe`, `connect`, `release`.** Registered
    like every engine in P4's registry (§2.B 14). Providers in P6: `compute/local` (today's behaviour, formalized:
    `connect` = the existing pair-code flow), `compute/vps` (a Linux host the tenant already has: `connect` prints the
    pair code, the binary URL with its sha256 and the two commands `devrounds-executor pair` and `service install`;
    DevRounds never holds an SSH key or logs into the host), `compute/aws-ec2` (ephemeral pools, below). Cost if wrong:
    a provider that can only run containers, not an executor, needs a different `connect`; the spec rules those out.
14. **[security] A human admits a pool; the engine pairs the pool's machines.** `devrounds pool set <file>` is human
    only (DR453). Each machine the engine provisions gets a single-use pairing code minted for it, bound to the pool
    (`pairing_codes.pool_id`), with `created_by` = the human who last set the pool and the usual 10 min TTL; a code
    bound to a pool can only create a machine of that pool. The AGENTS invariant "only a human admits a machine to the
    tenant" becomes "a human pairs a machine or admits the pool it belongs to". Cost if wrong: a stolen pool code is
    worth one ephemeral machine slot for at most 10 minutes, then nothing.
15. **Pools scale on demand, release on idle.** A queue may name a pool (`queues.pool_id`); runs of that queue are
    placed only on that pool's machines. Each scheduler tick, per pool: queued runs with no placeable machine and no
    machine already `provisioning` for them → provision, up to `max` and the pool's daily machine-minute budget (wait
    reasons `provisioning` and `compute_budget`). A machine idle for `idle_release_s` (default 600), past
    `max_lifetime_s` (default 4 h) or, with `per_job: true`, after one run, gets `Drain` (new message: stop admitting,
    finish, answer `Drained`), then `release` terminates it. A reaper every 5 min lists the provider's instances by the
    tags `devrounds:deployment` and `devrounds:pool` and terminates any without a live machine row, and marks rows whose
    instance is gone `released`; both are `compute_events`. Cost if wrong: a leaked instance costs money until the next
    reaper pass, at most 5 min.
16. **[security] Ephemeral instances hold nothing worth stealing.** No instance role (no AWS credentials on the
    machine), IMDSv2 required with hop limit 1, a security group with egress only, no SSH key pair, the provider's
    current Ubuntu LTS image. User data carries only the control plane URL, the executor version, its sha256 and the
    single-use pairing code: it downloads the binary from `GET /api/executor/binaries/<version>/linux-x64`, checks the
    sha256, pairs and installs the service. The code is consumed within seconds of boot, so a later reader of user data
    gets nothing. Cost if wrong: a compromised run can read its own machine's executor token; it is revoked when the
    machine is released, and the machine belongs to one tenant (§11.4).
17. **Machine minutes are metered.** `machine_usage` opens a row when a pool machine connects and closes it at
    release; the T14 rollup sums them per tenant and day. Billing is not in P6 (spec §2); the meter exists so limits
    and a later invoice read the same number (spec §14 "Metering per tenant ... from day one").

### D. Workspaces on machines without a checkout (T13)

18. **A job may name a repository instead of a path.** `workspace: {repo: <owner/name>, ref: <branch|sha>}` replaces
    `cwd` in a job, batch or gate request. Dispatch resolves it to `JobSpec.workspace {url, ref}` (feature `workspace`)
    plus, under `secret-env`, a `vcs` installation token with contents read (1 h, P4-T11) as the git HTTP credential,
    passed in environment variables only (never argv, never a remote URL), redacted like any secret. The executor runs
    a `checkout` step before the job: a mirror per (project, repo) under `<home>/workspaces/`, fetched, then a worktree
    per run under `<home>/checkouts/<run>` at the ref, removed at run end; `cwd` = that worktree. A `workspaces` row per
    (machine, project, repo) records the mirror; placement prefers machines whose mirror exists ("warm", spec §5.7).
    Persistent machines keep their mirrors; ephemeral ones start cold. Gates with `--cwd` on Guilherme's machine are
    unchanged. Cost if wrong: a large repository makes cold starts slow (Clickmax: minutes); its jobs stay on persistent
    machines through their queues.

### E. Isolation (T03)

19. **The `isolation` engine has two modes in P6: `none` (today's `NoneIsolation`) and `container`.** A job type gains
    `isolation: {mode, image?, network?, memory_mb?, read_only?}`; a pool sets a floor (`compute_pools.isolation`), so
    every run on a pool machine of a `container` pool runs in a container, with the pool's default image when the job
    type names none. `container` is Linux only: Windows machines report no container capability and such runs are not
    placed there (wait reason `isolation`), as the spec keeps Windows dev machines native (§14). microvm is later.
    Cost if wrong: a Windows-only tenant cannot run untrusted code until it adds a Linux machine or pool.
20. **[security] Container runtime: Podman (Apache-2.0), rootless, started by the executor as the run's child.**
    Defaults: `--rm`, image pinned by digest (`name@sha256:...`; a job type or pool with a tag-only image is refused at
    `jobtype set`/`pool set` with DR106), `--network none` unless the job type says `egress`, `--cap-drop all`,
    `--security-opt no-new-privileges`, `--userns keep-id`, `--pids-limit 4096`, `--memory` from `memory_mb` when set,
    optional `--read-only` with a tmpfs `/tmp`. Mounts: the run's checkout read-write at `/workspace` (workdir) and the
    run dir for outputs; nothing else of the host. Environment by name only (`--env NAME`, the value inherited from the
    Podman process the executor spawned with the allowlisted and secret values), so values never reach argv or a file.
    The container's processes must land inside the run's cgroup, so footprint, learned need and stop work as for any
    run; containers carry the label `devrounds.run=<id>` and the orphan scan at executor start reports labelled
    containers like processes (P1 rule: reported, never re-adopted). Why Podman: daemonless, so the container is a
    process tree the executor supervises instead of a request to a root daemon. Cost if wrong: Docker Engine as a
    second provider of the same mode.
21. **The project environment comes from `devcontainer.json`, image only.** `isolation.from_devcontainer: true` reads
    `.devcontainer/devcontainer.json` from the run's checkout and uses its `image` (digest-pinned, same rule) and
    `containerEnv` names. Dockerfile builds and Dev Container features are not in P6. Cost if wrong: projects that need
    a build publish a prebuilt image.
22. **Machines declare what they can do.** Feature `capabilities`: `Hello.capabilities {os, arch, isolation: [...],
    container_runtime?}` stored in `machines.capabilities`; placement matches a run's isolation mode against it.

Agent jobs under `container` isolation follow §2.G 26 (the agent loop stays outside the container).

### F. Second tenant (T04, T14, T15)

23. **The second tenant is a second person on their own machine; Guilherme's machine never serves it.** The operator
    creates it on the cloud with the existing commands (`devrounds-admin bootstrap`, `login create`), and the person
    pairs their own machine (Windows or Linux) and runs a gate on their own repository. If no second person is
    available when T04 starts, Guilherme operates it with a second email on a `container` pool machine of that tenant
    (§C); his own machine stays in his tenant only, since an executor belongs to one tenant (§11.4). No sign-up, billing
    or tenant picker in P6 (one tenant per login stays; P1 plan call 14). Cost if wrong: a picker later drops the
    `members_user` index.
24. **[security] Isolation is proven route by route, not trusted.** T15 adds `tenancy/cross-tenant.test.ts`: it builds
    the server with two tenants holding data in every table (through the services), collects every registered route
    with Fastify's `onRoute` hook, and requires one case per route in a table in the test; each case calls the route as
    tenant B with tenant A's ids and keys and expects DR201 or an empty result, and the response body is scanned for
    any of A's ids or sentinel strings. A new route without a case fails the test, so the guarantee grows with the API.
    The same cases run as `scripts/e2e/cross-tenant.e2e.ts` against the cloud deployment with two real tokens (T04
    acceptance). Beyond routes: the P5 live stream, executor offers (a machine of B never receives A's run; `claim_run`
    derives the tenant from the machine), hub calls with run tokens, log and artifact file paths (tenant directory
    first, no `..`). Cost if wrong: none; the suite is what the phase criterion asks for.
25. **Per-tenant limits, set by the operator, and usage metering (T14).** `tenant_limits` keys and defaults:
    `api_requests_per_min` 600, `queued_jobs` 1000, `machines` 10, `log_bytes_per_day` 2 GiB, `storage_bytes` 10 GiB,
    `machine_minutes_per_day` 0 (no pool compute until the operator sets it). Limits are set only by
    `devrounds-admin tenant limit set` (owner side), so a tenant never raises its own. Over a limit: API requests and
    new jobs, pairings and artifacts answer DR316 (HTTP 429); log ingest stops storing new segments for the day and
    keeps the run's tail and summary, marking `runs.log_truncated` (delay or trim, never kill, manifesto §6); pool
    provisioning waits with `compute_budget`. `tenant_usage_daily` is rolled up hourly (tenant time zone days) from
    runs, log segments, artifacts, machine usage and P4 token usage; tenants read their own at `GET /api/usage`.
    Cost if wrong: a limit too low shows as DR316 with the limit and usage in its data, and the operator raises it.

### G. Agent runs in containers and agent experiments (T03, T09; controller additions 28/11)

26. **Design direction: the head stays outside, the hands go in.** For an agent job under `container` isolation, the
    agent loop, the model calls, the transcript and the run's hub token stay in the executor process on the host; the
    container only executes the tool calls of kind shell and filesystem, through `podman exec` into one long-lived
    container per run with the checkout at `/workspace`. Why: a prompt-injected or hostile tool call then reaches the
    workspace and nothing else (no model credential, no hub token, no transcript), and the container keeps
    `network: none` although the model calls need egress. What P4 must provide in P4-T03: (a) a session-mode runtime in
    which the executor drives the loop turn by turn instead of handing the whole run to a vendor CLI; (b) the
    vendor-neutral `AgentEvent` type (`message`, `tool_call`, `tool_result`, `usage`, `end`) with a tool executor
    interface that DevRounds implements, so shell and filesystem tools are resolved by DevRounds and the isolation
    engine can route them into the container. P6-T03 implements the container side of that interface; its acceptance
    includes one agent run whose tool calls execute in the container while the credential and the transcript never
    enter it. Fallback, until (a) and (b) exist and for vendor CLIs that execute tools themselves: the whole agent runs
    inside the container with `network: egress` and its run-bound hub token (short-lived, revoked at run end, P4 §2.B).
    Cost if wrong: if P4-T03 ships without the tool executor seam, the split needs a second runtime change; the
    fallback exposes the hub token to tool output, which is acceptable on Guilherme's own pools and is what the split
    removes before other tenants run agent jobs on pools.
27. **A prompt or model change to an agent job type ships only after an experiment (T09).** An experiment runs a
    baseline and a candidate agent configuration over a versioned dataset of tasks DevRounds already solved, each case
    in a throwaway worktree, and scores both arms with existing gates. A dataset version is a frozen list of cases; a
    case = a done task (task key, repository, `base_ref` = the parent of the merged PR's first commit, the input the
    agent got, the merged solution's sha for reference). `devrounds experiment dataset add --from-task <key>` appends
    a case and creates a new version; experiments pin one version. Each case × arm runs the job type in a fresh P4-T11
    checkout at `base_ref` (or a P6-T13 workspace on a pool), removed at run end. External writes are off: the run
    token carries `experiment: true`, hub tools of risk `publish-external` (open PR, comment, Linear writes) return a
    recorded stub instead of calling the provider, and `pr_opened` is scored from that stub call. Scores per arm and
    case: `ci_green` = the project's gate (P2 gates) on the arm's final tree; `findings` = the project's review job type
    over the arm's diff, counted by severity; `cost_usd`, tokens and wall time from P4-T03 budgets and usage. The
    experiment has its own P4-T03 budget (`budget_usd`); hitting it stops the experiment as failed. Why: prompt and
    model changes are the changes most likely to regress agent results silently, and solved tasks give a ground truth
    without new labelling. Cost if wrong: each experiment spends model tokens and machine time for cases × 2 runs; the
    default dataset size is 10 cases.
28. **Verdicts and the ship rule.** `passed` = the candidate meets every threshold against the baseline (defaults:
    `ci_green` rate not lower, `pr_opened` rate not lower, blocker and major findings not higher, cost per case at most
    1.2 × baseline); `scored` = the experiment ran with `--score-only` or without thresholds, numbers recorded and no
    ship decision; `failed` = a threshold missed, the budget ran out, or a case could not run after one retry of an
    `infra` failure (a case is never skipped, so a verdict always covers the whole dataset). `devrounds jobtype set` on
    an agent job type whose `model`, `prompt` or runtime config changes requires `--experiment <id>` with verdict
    `passed` and a `candidate_hash` equal to the new configuration, or DR319. A human may ship with `--no-experiment
    --reason <text>` (recorded in plan events); an agent cannot. Cost if wrong: thresholds too strict block a good
    change; the human override and `scored` runs cover that while the defaults are tuned.

### H. Not in P6

Billing, sign-up, public onboarding, a tenant picker, more than one `serve`, microvm isolation, macOS and arm64
executors, Linux PTY sessions, tenant export or deletion.

## 3. Data model, protocol and API per task

Every new table: `tenant_id`, forced RLS through `isolate()`, composite FKs, DR201 for cross-tenant. Reserved
migrations: T10 `0060` (spare: ownership moves in `owner init`, not in a migration, since a migration runs as the
owner), T11 `0061` (spare), T14 `0062-0063`, T02 `0064-0067`, T13 `0068-0069`, T03 `0070-0071`, T04 `0072` (spare),
T09 `0073-0074`, `0075-0079` free. Protocol features reserved: `capabilities`, `workspace`, `isolation`, `drain`.

### A. T10 owner role

No table. `devrounds-admin owner init --superuser-url <url>`; `assertRoles` accepts `BYPASSRLS CREATEROLE
NOSUPERUSER`; the test database setup (`test-support/test-db-urls.ts`) creates the same role, so tests run as they
will in the cloud. AGENTS.md: the P0 superuser exception goes.

### B. T11 image and public serving

Config: `host`, `publicUrl`, `trustProxy`, `kek` (`{provider: dpapi-local | cloud-kms, keyRef}`). Files:
`docker/control-plane.Dockerfile`, `deploy/compose.yaml` (caddy, control-plane, postgres; data volume),
`deploy/Caddyfile`, `deploy/aws/stack.yaml` (CloudFormation: VM, data volume, instance role scoped to the KMS key, the
ECR repository, the backup bucket and pool tags; SSM; DLM snapshot policy), `scripts/deploy.ts`. Routes:
`POST /api/webhooks/github` (raw body, P4-T11 verification and dedup), `GET /a/:key` (unlisted artifact bytes,
`Cache-Control: private, max-age=300`), `GET /api/executor/binaries/:version` (target list with sha256) and
`/:version/:target` (bytes). `GET /api/health` adds `publicUrl` and the KEK provider id.

### C. T01 cloud control plane and cutover

`devrounds-admin kek rewrap --to <provider>`; `devrounds-executor repoint --url <url>` (DR455 `The control plane at
{url} refused this machine's token.`). Gateway: `Session.secure`; wait reason `insecure_link`; DR354 `Run {run}
carries secrets and machine {machine} is not connected over TLS.` Runbook `docs/runbooks/cloud-cutover.md` with the
§2.A 10 order and its checks.

### D. T12 Linux executor

Crates `executor/crates/{runner-linux,metrics-linux,sys-linux}`; `devrounds-executor service install` writes
`/etc/systemd/system/devrounds-executor.service` (`User=devrounds`, `Delegate=yes`, `Restart=always`). DR556
`cgroup v2 delegation is unavailable: {reason}.` Guards: `executor-guards.test.ts` accepts
`devrounds_sys_linux::spawn` as the Linux spawn point. Gate: `roadmap/fixtures/gates/devrounds-linux.yaml`.

### E. T02 compute engine and pools

```
compute_pools   id, tenant_id, key, provider, spec jsonb (region, instance_type, disk_gb, image_ref), isolation
                none|container, default_image null, min int default 0, max int default 2, idle_release_s int default
                600, max_lifetime_s int default 14400, per_job bool default false, machine_minutes_per_day int null,
                enabled bool, created_by (member, human), updated_at; unique (tenant_id, key)
machines        + pool_id null, provider_ref text null, arch text, provisioned_at, drain_requested_at, released_at,
                  release_reason idle|lifetime|per_job|manual|reaped|failed
pairing_codes   + pool_id null
queues          + pool_id null
compute_events  id, tenant_id, pool_id, machine_id null, kind provision|connected|drain|release|reap|error,
                data jsonb, at
machine_usage   id, tenant_id, machine_id, pool_id null, started_at, ended_at null
```

Protocol feature `drain`: server `Drain{}`, client `Drained{}`. Wait reasons `provisioning`, `compute_budget`. Codes:
DR315 `Machine {machine} still has {count} live runs.` (manual release without `--drain`); DR506 `Compute provider
{provider} failed to {action}: {reason}.` (also recorded as a `compute_events` error). API: `GET /api/pools`,
`PUT /api/pools/:key` (human), `GET /api/pools/:key` (machines, events, minutes today), `POST
/api/pools/:key/machines/:name/release` (human; `drain` flag). CLI: `devrounds pool set <file> | list | show <key> |
release <key> <machine> [--drain]`, `devrounds machine connect --provider vps --name <n>` (prints the commands). UI
reads (P5 pages, later): pool list with live and provisioning machines, minutes against budget, events.

### F. T13 workspaces

```
workspaces  id, tenant_id, project_id, machine_id, repo, root, last_fetch_at, bytes bigint;
            unique (tenant_id, machine_id, project_id, repo)
jobs        + workspace jsonb null ({repo, ref})
```

Protocol feature `workspace`: `JobSpec.workspace {url, ref}`; the credential travels in `secret_env`. Job, batch and
gate files accept `workspace:` where they accept `cwd`; exactly one of them (DR101). `GET /api/machines/:m` lists
workspaces.

### G. T03 isolation/container

```
job_types   + isolation jsonb ({mode none|container, image?, network none|egress, memory_mb?, read_only?,
              from_devcontainer?})
machines    + capabilities jsonb
```

Protocol features `capabilities` (`Hello.capabilities`) and `isolation` (`JobSpec.isolation {mode, image, network,
memory_mb, read_only}`). Wait reason `isolation`. DR106 `Image {image} must be pinned by digest (name@sha256:...).`

### H. T14 limits and usage, T04 second tenant, T15 cross-tenant suite

```
tenant_limits       id, tenant_id, key, max bigint, set_at; unique (tenant_id, key)
tenant_usage_daily  id, tenant_id, day date, runs int, run_seconds bigint, machine_minutes bigint, log_bytes bigint,
                    storage_bytes bigint, tokens_in bigint, tokens_out bigint, cost_usd numeric;
                    unique (tenant_id, day)
runs                + log_truncated bool default false
```

DR316 `Tenant limit {limit} reached: {used} of {max}.` (HTTP 429). API `GET /api/usage?period=day|week`. Admin:
`devrounds-admin tenant list` (names, member and machine counts, usage today; no tenant data), `tenant limit set
--tenant <n> --key <k> --max <n>`, `tenant limit show --tenant <n>`, `tenant usage --tenant <n> [--days 30]`. T15:
`tenancy/cross-tenant.test.ts`, `scripts/e2e/cross-tenant.e2e.ts`. T04: `docs/runbooks/second-tenant.md`
(bootstrap, login, out-of-band delivery of the printed password, pairing, first gate).

### I. T09 agent experiments

```
experiment_datasets  id, tenant_id, project_id, key, version int, created_by (member), created_at;
                     unique (tenant_id, project_id, key, version)
experiment_cases     id, tenant_id, dataset_id, task_key, repo, base_ref, reference_sha, input jsonb;
                     unique (tenant_id, dataset_id, task_key)
experiments          id, tenant_id, project_id, dataset_id, job_type, baseline jsonb, candidate jsonb,
                     candidate_hash, thresholds jsonb null, budget_usd numeric, state queued|running|done|cancelled,
                     verdict passed|scored|failed null, verdict_reason text null, created_by (member), started_at,
                     finished_at
experiment_results   id, tenant_id, experiment_id, case_id, arm baseline|candidate, run_id, gate_run_id null,
                     review_run_id null, ci_green bool, pr_opened bool, findings jsonb ({blocker, major, minor}),
                     tokens_in bigint, tokens_out bigint, cost_usd numeric, wall_s int;
                     unique (tenant_id, experiment_id, case_id, arm)
job_types            + experiment_id null (the experiment the current agent config shipped with)
```

Run tokens gain `experiment: bool`; the hub returns a recorded stub for `publish-external` tools when it is set. DR319
`Job type {type} changes its model or prompt without a passed experiment.` CLI: `devrounds experiment dataset add
--key <k> --from-task <task>...`, `experiment dataset show <k>[@<v>]`, `experiment run --dataset <k>@<v> --job-type
<t> --candidate <file> [--thresholds <file>] [--score-only] [--budget-usd <n>]`, `experiment show <id>` (per-case
table, verdict and reason), `experiment cancel <id>`; `jobtype set ... --experiment <id> | --no-experiment --reason`.
API `GET /api/projects/:key/experiments`, `GET /api/projects/:key/experiments/:id`. The experiment is a P4-T16 flow
(fan out cases × arms, then gate and review per arm, then score), so its runs, waits and retries are the flow
engine's.

## 4. Stages and PR decomposition

Parallel rules as P4 §4: one worktree per track under `.worktrees/`, a private test database per worktree, migration
numbers, codes and protocol features as reserved in §3, one PR per track (a short stack above ~1500 changed lines),
a fresh-reviewer stage review at the end of each stage.

**Stage 1 — local and independent (startable once the phase edge changes, §5; six tracks).**

| Track | Tasks                                                | Acceptance                                                                                                                                                                                        |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a    | T10 owner role                                       | local `migrate` and the whole suite run with `devrounds_owner` (no superuser in `server.json`); every definer function still resolves across tenants; the AGENTS.md exception is gone             |
| 1b    | T11 image and public serving                         | the image runs the suite in a container; behind a local Caddy, pairing failures from two clients land in two buckets; secure cookie set over https; SSE passes unbuffered                         |
| 1c    | T12 Linux executor (on `linux-1`)                    | `cargo test` of the Linux crates green; a run's peak matches its cgroup `memory.peak`; stop kills the tree; DevRounds's gate runs on `linux-1` through a loopback-free https link                 |
| 1d    | T15 cross-tenant suite                               | every registered route has a case; removing one case fails the meta-test                                                                                                                          |
| 1e    | T14 limits and usage                                 | each limit answers DR316 with its data; log trimming keeps tail and summary; usage day totals match the runs table in the tenant time zone                                                        |
| 1f    | T09 agent experiments (after P4-T03, P4-T11, P4-T16) | a 3-case dataset from done DevRounds tasks runs both arms in throwaway checkouts; no external write happens; a candidate that costs 2 × fails; `jobtype set` without a passed experiment is DR319 |

**Stage 2 — cloud and Linux capabilities (2a after 1a, 1b, P4-T01, P4-T11; 2b after 1c and P4-T03; 2c after 1c).**

| Track | Tasks                   | Acceptance                                                                                                                                                                                                                                                                                                        |
| ----- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2a    | T01 cloud control plane | cutover done per §2.A 10; plan export byte-equal; DevRounds gate wall time from his machine ≤ local baseline +10 %; restore drill passes; only 80/443 answer from outside; webhooks arrive direct                                                                                                                 |
| 2b    | T03 isolation/container | a container run's peak is in its learned need; stop leaves no container; `--network none` blocks egress (test); a tag-only image is DR106; an executor restart reports a live container orphan; one agent run executes its tool calls in the container while the credential and transcript stay outside (§2.G 26) |
| 2c    | T13 workspaces          | a job by `workspace:` runs on `linux-1` with no local checkout; the token never appears in argv, logs or `run show`; a second run on the same machine is placed warm                                                                                                                                              |

**Stage 3 — pools and the second tenant (3a after 2a, 2b, 2c; 3b after 2a, 1d, 1e).**

| Track | Tasks              | Acceptance                                                                                                                                                                           |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3a    | T02 compute engine | a queued run on a pool queue provisions an instance, pairs, runs in a container and the machine is released after idle; a killed instance is reaped; budget 0 waits `compute_budget` |
| 3b    | T04 second tenant  | tenant B on the cloud runs a gate on its own machine; the cross-tenant e2e passes against the deployment with both tenants' real tokens (phase criterion 1); phase review            |

## 5. Tracker mapping (commands to run; not executed)

In Git Bash, prefix commands whose arguments start with `/` with `MSYS_NO_PATHCONV=1` (P4-T15's title was stored as
`C:/Program Files/Git/work and /ship ...` that way; fix it with `task edit P4-T15 --title`).

```
# Stage 1 needs only delivered P1-P3 work: replace the phase edge with task edges (P4 and P5 precedent, 28/11)
devrounds phase dep rm P6 --blocked-by P5 --reason "P6 stage 1 is local work; cloud tasks carry task edges on P4 (P6 design §5)"

devrounds task edit P6-T01 --reason "P6 design 28/11" --title "Cloud control plane and cutover of Guilherme's tenant" --description "AWS sa-east-1 VM, Caddy, Postgres on the data volume, KMS KEK, backups, deploy, cutover and rollback (P6 design §2.A)."
devrounds task edit P6-T02 --reason "P6 design 28/11" --title "Compute engine with local, vps and ephemeral cloud pools" --description "Engine contract, pools admitted by a human, scale on demand, drain and release, reaper, machine minutes (P6 design §2.C)."
devrounds task edit P6-T03 --reason "P6 design 28/11" --description "isolation engine none|container; rootless Podman in the run's cgroup; digest-pinned images; devcontainer image; agent tool calls run in the container, the agent loop outside (P6 design §2.E, §2.G 26)."
devrounds task edit P6-T04 --reason "P6 design 28/11" --description "A second person's tenant on the cloud, on their own machine; cross-tenant e2e against the deployment (P6 design §2.F 23)."

# P6-T09 was added by the controller on 28/11; if it already exists, run the same text as `task edit P6-T09` instead
devrounds task add P6-T09 --phase P6 --title "Agent experiments: score prompt and model changes on solved tasks" --blocked-by P4-T03 --blocked-by P4-T11 --blocked-by P4-T16 --criterion "Both arms run every case of a pinned dataset version in throwaway checkouts with external writes stubbed" --criterion "Verdict passed, scored or failed from gates, review findings and cost; jobtype set on a changed agent config needs a passed experiment (DR319) or a human override"
devrounds task add P6-T10 --phase P6 --title "Non-superuser owner role for migrations and admin" --criterion "migrate and the test suite run as devrounds_owner (BYPASSRLS, CREATEROLE, not superuser)" --criterion "The P0 superuser exception is removed from AGENTS.md"
devrounds task add P6-T11 --phase P6 --title "Control plane image and public serving behind a TLS proxy" --criterion "trustProxy is the proxy address only; pairing failures stay keyed by the real client address" --criterion "Unlisted artifacts are served by the control plane at /a/<key>, not by a public bucket URL"
devrounds task add P6-T12 --phase P6 --title "Linux executor (cgroup v2, PSI, systemd)" --criterion "A run's peak and stop go through its cgroup; no process outside sys-linux spawn (guard test)" --criterion "DevRounds's gate runs green on linux-1"
devrounds task add P6-T13 --phase P6 --title "Workspaces: jobs by repository on machines without a checkout" --blocked-by P6-T12 --blocked-by P4-T11 --criterion "The git credential never appears in argv, a remote URL, logs or run show" --criterion "Placement prefers a machine whose mirror exists"
devrounds task add P6-T14 --phase P6 --title "Per-tenant limits and usage metering" --criterion "Limits are set only owner-side; over a limit the API answers DR316 with limit, used and max" --criterion "Log trimming keeps the run's tail and summary and never stops the run"
devrounds task add P6-T15 --phase P6 --title "Cross-tenant suite over every route" --criterion "Every registered route has a cross-tenant case; a missing case fails the test" --criterion "The suite runs against the cloud deployment with two real tenants"

devrounds dep add P6-T01 --blocked-by P6-T10 --reason "the cloud owner is not a superuser"
devrounds dep add P6-T01 --blocked-by P6-T11 --reason "the image and proxy settings are what gets deployed"
devrounds dep add P6-T01 --blocked-by P4-T01 --reason "kek/cloud-kms extends the vault"
devrounds dep add P6-T01 --blocked-by P4-T11 --reason "webhooks move from the relay to the cloud endpoint"
devrounds dep add P6-T02 --blocked-by P6-T12 --reason "pool machines run the Linux executor"
devrounds dep add P6-T02 --blocked-by P6-T03 --reason "container pools isolate every run"
devrounds dep add P6-T02 --blocked-by P6-T13 --reason "ephemeral machines have no checkout"
devrounds dep add P6-T03 --blocked-by P6-T12 --reason "containers run on Linux machines"
devrounds dep add P6-T03 --blocked-by P4-T03 --reason "agent tool calls route into the container through the session-mode runtime and AgentEvent"
devrounds dep add P6-T04 --blocked-by P6-T14 --reason "a second tenant needs limits on a shared control plane"
devrounds dep add P6-T04 --blocked-by P6-T15 --reason "the phase criterion is proven by the cross-tenant suite"

devrounds criterion add P6-T01 --text "secret-env and hub tokens are offered only to sessions over TLS (DR354 for a pinned run otherwise)"
devrounds criterion add P6-T01 --text "plan export is byte-equal before and after the cutover; a restore drill from the latest dump passes"
devrounds criterion add P6-T01 --text "From outside only ports 80 and 443 answer; administration goes through SSM, no SSH key exists"
devrounds criterion add P6-T02 --text "Pool machines pair only with single-use codes bound to a pool a human set; no cloud credential exists on them"
devrounds criterion add P6-T02 --text "A leaked instance is terminated by the reaper within 5 minutes"
devrounds criterion add P6-T03 --text "Container runs are inside the run's cgroup: peak, learned need and stop work as for native runs"
devrounds criterion add P6-T03 --text "Images are digest-pinned (DR106); network none by default; secret values never on argv or disk"
devrounds criterion add P6-T03 --text "An agent run executes its shell and filesystem tool calls in the container; the model credential, hub token and transcript never enter it"
devrounds criterion add P4-T03 --text "Session-mode runtime driven by the executor and a vendor-neutral AgentEvent type with a tool executor interface (needed by P6-T03)"
devrounds criterion add P6-T01 --text "P4-T21 judgment jobs run in the cloud control plane with no executor, counted in tenant usage and limits"
devrounds criterion add P6-T04 --text "Tenant B runs a gate on its own machine on the cloud control plane"
devrounds link add P6 --kind doc --ref docs/superpowers/specs/2026-11-28-p6-cloud-tenant-design.md --title "P6 design"
```

The invariant edits (`a human pairs a machine or admits its pool`, `devrounds_sys_linux::spawn`, the cloud address
beside `127.0.0.1:4992`) go through `devrounds conventions propose --task <key>` in T02, T12 and T01, and a human
`conventions approve` (P3 rule, DR453 for agents); the "Accepted P0 exceptions" list is edited by hand in T10.

## 6. Left to the builder

- The exact cgroup layout under the executor's delegated subtree, and how rootless Podman places a container inside
  the run's cgroup (`--cgroup-parent` on the delegated subtree or `--cgroups=split`): the T03 acceptance tests decide.
- The CloudFormation template's shape, instance types beyond the §2.A 1 size, the Ubuntu image lookup, EBS type.
- Caddy settings for SSE and WebSocket timeouts; the health probe used by `deploy.ts`.
- KMS data key cache size; rewrap batching.
- Mirror garbage collection on persistent machines (size cap per workspace root).
- Whether `tenant_usage_daily` is a rollup table or a view once the numbers are known; index choices.
- The pool YAML schema details beyond §3.E, and per-provider manifest fields.
- Experiment threshold file format, the default dataset size beyond 10 cases, and how findings severities map from the
  review job type's output.

## 7. Needs the owner (credential, money or a secret he holds)

1. **AWS account and billing** in `sa-east-1`: the control plane VM, its data volume and snapshots, the KMS key, ECR,
   the backup bucket, `linux-1`, and ephemeral pool instances; an AWS Budgets alarm at an amount he chooses. He runs
   the CloudFormation stack once (or gives the builder a scoped setup role for that run).
2. **A host name and its DNS record** for the control plane (for example under a domain he owns), pointing at the VM's
   static address, so Caddy can obtain the certificate.
3. **GitHub App settings**: changing the webhook URL to `<publicUrl>/api/webhooks/github` at cutover (App admin
   access).
4. **At cutover, on his machine**: `devrounds-admin kek rewrap --to cloud-kms` needs his Windows profile (DPAPI KEK)
   and temporary KMS access at the same time; the P4 KEK recovery passphrase stays his.
5. **Pool spend for the second tenant**: the `machine_minutes_per_day` limit he allows, if the second tenant runs on
   a DevRounds pool.
6. **Model spend for experiments (T09)**: each experiment's `budget_usd` is charged to his model provider account
   (cases × 2 agent runs); he sets the default budget, and P4-T21's API key in the vault is his.
7. **The second tenant's person and email** (or a second email of his), and handing them the password `login create`
   prints once.
8. Not a design approval but a human-only step: approving the conventions proposals that change AGENTS.md invariants
   (P3 rule).
