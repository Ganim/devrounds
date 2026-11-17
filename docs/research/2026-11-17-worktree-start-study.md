# Worktree start study (Clickmax monorepo, 17/11/2026)

Run from another session on Guilherme's machine; three rounds, everything removed afterwards (10 worktrees, isolated
store, turbo cache). Nothing in the monorepo was changed. Feeds P2-T09, P2-T15, P2-T16 and P2-T08.

## Setup that worked

A base checkout with trunk installed and built; each new worktree uses the same pnpm store (node_modules files are
hardlinks) and one shared turbo local cache folder.

| Round | Install per worktree | Build (`build-deps`) | From cache |
|-|-|-|-|
| 2 in parallel | ~310 s | 67-74 s | 122-136 of 170 |
| 3 in parallel | 413-432 s | 28-40 s | 170 of 170 |
| 4 in parallel, 1 file edited each | 541-572 s | 51-170 s | 90-92 of 170 |

- Round of 4: each worktree compiled its own version of the edited file (`libs/slug-utils/src/index.ts`); only that
  package and its dependents rebuilt (~78 tasks), the rest came from the base through the cache. The base stayed
  untouched (no modified file, no edit in `dist`).
- Two of the four ran out of memory (`VirtualAlloc failed`) with four simultaneous builds plus the other open sessions;
  rerun one at a time, both passed.
- Round of 2: some tasks missed the cache because both worktrees ran them at the same time, before either wrote it.
- Real cost per worktree ~0.9 GB: 728 MB source + dist, 190 MB unshared node_modules; the other 4 GB of node_modules are
  hardlinks to the base.

## Bottleneck: install

Even with everything downloaded, pnpm creates ~3,600 entries per worktree, and it degrades under concurrency: 160 s
alone, ~550 s with four at once.

pnpm global virtual store (`enableGlobalVirtualStore`) brings install to 15-50 s but breaks the build today: several
packages use types from dependencies they do not declare, which only works through pnpm's hidden hoisting in the normal
layout. Fixed three with `packageExtensions` (fastify-plugin, @fastify/swagger, lucide-react) and more kept appearing
(recharts, amqplib). Adopting it needs a sweep that declares all of them. It also needs
`SKIP_INSTALL_SIMPLE_GIT_HOOKS=1`, because the simple-git-hooks postinstall cannot find the project.

## Pitfalls for any worktree

- With `core.symlinks=false`, `sdk/*/openapi.yaml` check out as text files holding the target path and the SDK build
  fails; fixed by copying the real file over each one.
- pnpm's dependency check before running a script hung waiting for a prompt without a terminal; fixed with
  `verify-deps-before-run=false` and an empty stdin.

## Recommendation

Point every worktree's turbo local cache at one folder (`TURBO_CACHE_DIR`): environment only, no repo change, removes the
rebuild. For install time, the global virtual store, after declaring the missing type dependencies. At most three builds
at once because of memory (in DevRounds: learned need + start-gate decide, not a fixed number).
