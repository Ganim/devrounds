# P5-T07 report (stage A, design tokens, primitives and patterns)

Branch `lane-p5-t07` from `main` (9f3d0aa). Started with `devrounds task start P5-T07` (no phase refusal, so no
phase edit). Not done, not pushed.

## What landed

- `ui/tokens.css`: the only file that names a color. A raw scale on `:root`, then semantic tokens (surfaces, text,
  accent, `--state-*`, links, focus, shadows, reader and log colors) for `:root, [data-theme='dark']` (the default)
  and `[data-theme='light']`, both taken from the cx-env panel (page-v2 Harmony tokens and the v2 light theme).
  Tokens derived from other tokens (`--accent-gradient`, `--accent-glow`) are declared again on `[data-theme]` so a
  light subtree inside a dark page resolves them in light. Type, spacing, radius, z-layers and motion are tokens too.
- `ui/base.css` (element defaults, focus ring, scrollbars), `ui/legacy.css` (the old page selectors rewritten on
  tokens, to be deleted as P5-T12 and T09 port pages), `ui/style.css` now only imports the three.
- `ui/theme.ts`: key `devrounds.theme`, `setTheme`, `currentTheme`, and the boot script that `build.ts` inlines into
  index.html so the first paint has the right theme (saved choice, else prefers-color-scheme, else dark).
- Primitives: Button (variants, `confirm` two-step), IconButton, Badge, Dot, Card, Ring, ProgressBar, Segmented,
  Toggle, Input/Textarea/Field, Select, Table, Dialog (native, bottom sheet under 900 px), Popover, Menu, Combobox,
  Toast (top layer above dialogs), Tooltip, Spinner, EmptyState, Banner, ErrorBox, Loading, Mono, Time,
  ThemeToggle, and Icon (Lucide subset, ISC header). Pill is gone; run, task and job states use Badge with
  `lib/tones.ts`.
- Patterns: ListCard, StatStrip, SortableList/Grip and Kanban (one pointer drag hook with a keyboard fallback),
  Thread/Bubble, ComposerShell, LogView (windowed, follows the tail), Pager.
- `lib/`: tones, time (`formatAgo`), rank (`rankMatches`), reorder (`moveItem`), 3 tests.
- `ui/tokens.test.ts`: fails on a hex, color function or named color in any CSS value outside tokens.css, and on a
  quoted hex or color function in TS/TSX; a synthetic case checks the rule itself.
- `gallery.html` (built from `ui/gallery.tsx`): every primitive and pattern in dark and light side by side;
  `?open=dialog|toast` opens the overlays.

## Validation

- `pnpm typecheck` ok; `npx biome check web` ok (114 files; repo-wide lint still has 3 errors that are on main:
  two docs/superpowers specs and roadmap/fixtures/conventions/clickmax-v2.yaml).
- `node --test "web/src/**/*.test.ts" "scripts/**/*.test.ts"` 32/32.
- `node build.ts` ok (app.js about 556 KB, app.css 46 KB, gallery.js 254 KB).
- Visual check: the build served on port 4987 by a throwaway server forwarding GETs only to the live control plane;
  Playwright with Edge took screenshots of the gallery in both themes at 1400 and 390 px, the dialog (desktop and
  phone bottom sheet) and the toast, and every app route in dark and light at 1280 plus phone runs and phase. No page
  errors and no horizontal overflow; the only console error is the missing favicon.

## Risks

- AppPage, MasterDetail and Graph are not built: the shell belongs to T09, and Graph to T12/C1 with lazy splitting.
- `build.ts` changed (gallery entry, inline theme script), which may conflict with T09's code splitting.
- The theme key lives in `ui/theme.ts`; T08's prefs may also want to own it.
- legacy.css stays until T12. DependencyGraph (features/) was edited to use state tokens.
- `ui/index.ts` now imports style.css, so any consumer of ui/ pulls in the global styles.
- The color test is regex-based; it catches the usual forms, not colors built at runtime.
- Dialog reads `--vvh`/`--kb` for the phone keyboard; T09's shell is expected to set them.
- The run detail route was only screenshotted with an empty id.
- The primitives and patterns commits only typecheck together with the next commit, which moves features off Pill.
