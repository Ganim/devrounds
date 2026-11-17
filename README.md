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
devrounds-admin migrate
devrounds-admin service install    # scheduled task DevRounds: supervisor + server on 127.0.0.1:4992
```

Then create the tenant and an agent token, log the agent CLI in and load the roadmap:

```
devrounds-admin bootstrap --tenant <name> --project devrounds --name DevRounds --human <name>   # prints a human token once
devrounds-admin token create --tenant <name> --member <agent> --kind agent                      # prints an agent token once
devrounds login --url http://127.0.0.1:4992 --token <agent token> --project devrounds
devrounds plan import roadmap/snapshot.yaml
```

The web view takes the human token. Logs go to `~/.devrounds/logs/`. `devrounds-admin service uninstall` stops and
removes the task.
