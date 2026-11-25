# Extracting a project's conventions

The procedure any agent follows to write a project's conventions document and propose it to DevRounds. It runs in a
session today and as an agent-run job type later (P4); the steps and the output are the same. The document schema is
`control-plane/src/conventions/file.ts`; the README section "Conventions" covers the commands.

## Inputs

1. The candidates: `devrounds conventions candidates --cwd <repo>` lists the lines the repo's instruction files already
   state as rules (`Never`, `Always`, `MUST`, `NEVER`, `Do not`, bullets under such headings), as `path:line text`.
   Add `--glob <g>` (repeatable, replaces the defaults) for other instruction files, such as scoped docs or skill files
   checked into the repo. Globs match like rule globs, case-sensitive, and `**` reaches dot directories, so
   `**/*.md` covers `.agents/skills/` and `.claude/commands/`.
2. The layout: the top-level directories and what each holds (package manifests, entry points).
3. Sample code per directory: a few recent files of each kind (route, service, test, migration, component), read to
   see which rules the code actually follows and which it breaks.
4. The active version, when there is one: `devrounds conventions export > conventions.yaml`. Edit that file; never
   start over beside it.

## Output

One conventions file (YAML), whose every rule and fact carries evidence from the repo at `--cwd`:

- `evidence` entries quote the repo: `{path, excerpt, line?, role}`, `excerpt` copied character for character (up to
  300), `role: source` for the line that states the rule, `role: example` for code that follows it. Only files in the
  repo count. Never cite private notes, agent memory, chat logs or anything outside the worktree: the next reader must
  be able to open the file. Never cite a line inside a generated block (between `devrounds:conventions` markers):
  `render` rewrites it from the record, so verify ignores those lines and the excerpt reads as stale. A rule that
  only lives in a generated block cites what enforces it (the test, the lint config) or the code that follows it.
- Candidate output shows a tab as `\t`; write the real character in `excerpt`. Quote a multi-line excerpt with a
  double-quoted YAML string and `\n`; a `>` scalar folds the line breaks away and the excerpt stops matching.
- Prefer a mechanical check over `judgment`, in this order:
  - `pattern` when an added line can show the violation (`forbid`, with `unless` for the allowed form on the same line;
    flags from `imsu`). It needs `paths` and at least one `examples.bad` line it matches; add `examples.good` lines it
    must not match. Both are single lines: the checker reads a diff line by line.
  - `path` when a new file in the wrong place is the violation (`forbid_new: <glob>`).
  - `job_type` when an existing check already enforces it (a lint, a meta-test): `enforced_by: <job type key>`.
  - `judgment` only when none of these can say it; an agent reviewer reads it.
- A new rule starts `severity: warn`, and promoting it to `block` is its own change after the indicators show it fires
  only on real violations. The exception is a rule the repo already enforces by other means (a lint, a test): it can
  start at `block`, since nothing new starts failing.
- `key` names the rule (`area.short-name`), `section` is the heading it renders under (keep the repo's own, such as
  `Never` and `Always`), `title` is the rule in one sentence, `why` the reason it exists.
- `target` names the file the rule renders into when it is not the first of `targets`. Name it explicitly; nothing is
  inferred from globs.
- Facts (`facts:`) describe the project (layout, commands) and carry evidence like rules.

The file's shape:

```yaml
targets:
  - path: AGENTS.md
rules:
  - key: engine.no-sync-fs
    section: Never
    title: Never call the *Sync fs functions in server code
    why: They block the event loop for every tenant.
    paths: [control-plane/src/**/*.ts]
    exclude: ["**/*.test.ts"]
    check: { kind: pattern, forbid: 'Sync\(' }
    examples: { bad: ["readFileSync(path)"], good: ["await readFile(path)"] }
    evidence:
      - { path: control-plane/src/db/pool.ts, excerpt: "await readFile(", role: example }
facts:
  - key: layout.control-plane
    section: Layout
    text: "control-plane/: the TypeScript control plane."
    evidence: [{ path: control-plane/package.json, excerpt: '"name"', role: example }]
```

## Proposing

```
devrounds conventions propose conventions.yaml --cwd <repo> --task <key> --head-sha <commit>
```

`--task` is the task that asked for the extraction. `--head-sha` is the commit the evidence was read at. `propose`
refuses an excerpt that is not in its file and a pattern rule whose examples do not hold, each as DR101 at its line:
fix the file and propose again. Then `devrounds conventions diff <version>` shows what changed; a human member approves
or rejects it. Agents never approve.

After approval, `devrounds conventions render --cwd <repo>` writes the generated blocks; commit them with the change.
