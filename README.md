# DevRounds

Multi-tenant AI dev platform. Read `MANIFESTO.md` for the principles and `AGENTS.md` for the invariants.

```
pnpm install
pnpm db:up      # Postgres 17 on localhost:15433 (databases devrounds, devrounds_test)
pnpm test
pnpm typecheck
pnpm lint
```

Run the control plane on this machine (Windows):

```
devrounds-admin init               # ~/.devrounds/server.json
devrounds-admin migrate
devrounds-admin service install    # scheduled task DevRounds: supervisor + server on 127.0.0.1:4992
```

Logs go to `~/.devrounds/logs/`. `devrounds-admin service uninstall` stops and removes the task.
