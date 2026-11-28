# P5-T06 report (stage A0, R0 restructure)

Branch `lane-p5-t06` from `main` (efc601f). Task started with `devrounds task start P5-T06` (no phase refusal, so no
phase edit). Not done, not pushed.

## What moved

- `app/`: `main.tsx` (Root, App, page table), `Login.tsx`, `routes.ts` (patterns + nav; the hash `if/else` is gone).
- `data/`: `contract.ts` (the only file with server types, type-only; `Wire<T>`; every endpoint once: method, path
  pattern, project scope, response type), `http.ts` (`request`, `ApiError`, project key, `urlOf`), `resources.ts`
  (`useRemote` kept private and still polling 10 s, `usePages`, one hook per endpoint, session calls).
- `features/`: planning (Roadmap, Phase, DependencyGraph, TaskState), balance, history, conventions, machines, queues,
  jobs, runs (Runs, Run, RunState).
- `ui/`: primitives ErrorBox, Loading, Pill (generic: state class, label, notes); patterns Pager; `style.css` as is.
- `lib/`: format (+ `when`, `shortId`), segments, conventions, with their tests; they restate the two small server
  shapes they need, and tsc checks the server values still fit at the call sites.
- `boundaries.test.ts`: layer rules of design §3 call 2, server types only via `data/contract.ts` type-only,
  `@tanstack/` only in `data`; a synthetic tree asserts each rule's message.
- `contract.test.ts`: `buildServer` with no DB and no listen, routes collected by `onRoute`, every endpoint matched
  (checked that renaming `/runs/:id` makes it fail).

## Validation

- `pnpm typecheck` ok; `pnpm lint` ok (295 files); `node --test "web/src/**/*.test.ts" "scripts/**/*.test.ts"` 27/27.
  Control-plane DB tests not run (no control-plane change).
- `pnpm -F web build` ok (app.js 561 KB, main 563 KB).
- Pages: main's build and this build served on 4997/4998 by a throwaway static server forwarding GETs only to the
  live control plane with the CLI token; headless Edge `--dump-dom` of `#/`, `#/phase/P5`, `#/phase/%25`, `#/balance`,
  `#/history`, `#/conventions`, `#/machines`, `#/queues`, `#/jobs`, `#/runs`, `#/runs?state=failed`, `#/run/<id>`:
  all 12 DOMs byte-identical between main and this branch, none with an error box or stuck loading.

## Risks

- The import scan is a regex, not a parser: an import inside a string or comment could false-positive.
- Unmatched routes now go through `matchRoute` returning `name: null` (roadmap, no nav active), same as before.
- `.superpowers/` is gitignored; this report was added with `git add -f`.
