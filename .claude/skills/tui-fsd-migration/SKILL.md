---
name: tui-fsd-migration
description: Move the crit terminal UI (apps/cli/src/tui) to the Feature-Sliced layout with kebab-case file names, step by step and without changing behaviour. Use when asked to restructure, rename or split TUI files, or to place new TUI code in the right layer.
---

# TUI → feature-sliced layout

Target layout and rules: `.claude/rules/tui/folder-structure.mdc`. Read it first. This skill is the plan for
getting there from the current flat folder. **Behaviour does not change in any step**: if a test needs
editing for anything but an import path or a renamed symbol, stop and ask.

## Current files → target

| Current (`apps/cli/src/tui/`) | Target                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme.ts`                    | `shared/lib/theme.ts`                                                                                                                          |
| `highlight.ts`                | `shared/lib/highlight.ts`                                                                                                                      |
| `widgets.tsx`                 | `shared/ui/{panel,bar,status-bar,spinner,viewport,picker,menu}.tsx`, `shared/lib/text.ts` (`truncate`, `wrapText`), `shared/hooks/use-tick.ts` |
| `components.tsx`              | `shared/ui/{hrule,footer,status,diff-view,text-input,choice}.tsx` (its `truncate` duplicates `widgets` → delete)                               |
| `screen.tsx`                  | `shared/ui/screen.tsx`, `shared/hooks/use-screen.ts`                                                                                           |
| `session.ts`                  | `features/review-session/model/review-session.ts` (+ types), `prompt.ts` → `lib/finding-prompt.ts`                                             |
| `filter.ts`                   | `features/review-filter/lib/{parse-query,visible-items,triage,file-tree}.ts`                                                                   |
| `stream.ts`, `card.ts`        | `features/finding-stream/lib/{build-stream,finding-card}.ts`                                                                                   |
| `switcher.ts`                 | `features/model-switching/lib/{create-switcher,describe-choice}.ts`                                                                            |
| `useSwitching.tsx`            | `features/model-switching/hooks/use-switching.tsx` (+ the picker stages as `ui/`)                                                              |
| `ProgressScreen.tsx`          | state and reducer → `features/run-progress/lib/`, component → `views/run/progress-view.tsx`                                                    |
| `App.tsx`                     | `ReviewApp` → `views/review/review-view.tsx`, `RunApp` → `views/run/run-view.tsx`                                                              |
| `StreamScreen.tsx`            | `views/review/stream-view.tsx`                                                                                                                 |
| `ProposalScreen.tsx`          | `views/review/proposal-view.tsx`                                                                                                               |
| `HelpOverlay.tsx`             | `views/review/help-view.tsx`                                                                                                                   |
| `HomeScreen.tsx`              | `views/home/home-view.tsx` (`HomeApp` → `HomeView`)                                                                                            |
| `history.tsx`                 | `views/history/history-view.tsx` + `app/launch-history.tsx` (`historyTui`)                                                                     |
| `start.tsx`                   | `app/{render-full-screen,terminal-editor,summary-line,make-switcher,make-session,launch-home,launch-review,launch-run}`                        |

Renames: `ReviewApp` → `ReviewView`, `RunApp` → `RunView`, `HomeApp` → `HomeView`, `HistoryApp` → `HistoryView`,
`*Screen` → `*View`, `HelpOverlay` → `HelpView`.

## Steps (one commit each, in this order)

1. **Rename only.** `git mv` every file to kebab-case in place (`HomeScreen.tsx` → `home-screen.tsx`), fix
   imports, nothing else. Use `git mv` so history follows the file.
2. **Create the layers and move whole files** into `shared/`, `features/`, `views/`, `app/` as in the table,
   without splitting any file yet. Add a barrel `index.ts` to each folder and switch cross-folder imports to
   the barrels. Add `tui/index.ts` re-exporting `app/`, and point the commands at it.
3. **Split the big files** (`widgets`, `components`, `ProgressScreen`, `App`, `start`, `filter`,
   `switcher`) one file at a time into the files in the table. Dedupe while splitting (`truncate`).
4. **Rename symbols** (`*App`/`*Screen` → `*View`) with the file names, in one mechanical commit.
5. **Then** the quality work, as separate commits: break `review-view.tsx` into keymap + actions + subviews,
   move derived data into feature `lib`, replace `ReviewSession` class with a factory. These are the only
   steps allowed to change code beyond moves.

## Each step must pass

`pnpm check`, `pnpm check-types`, `pnpm test` (all green, same test count), then
`pnpm --filter @crit/cli build`. For steps 2-4 also run the CLI once in a real terminal (`crit`, open a
review, `q`) because the unit tests cannot see a broken lazy import.

## Safe-move checklist

- Resolve relative imports from the **old** location of the file you moved, or they point nowhere.
- A barrel that re-exports a file which imports the same barrel is a cycle: siblings import each other
  directly.
- Moving a file that has a test: rename the test to match and keep its assertions unchanged.
- Do not touch `packages/*` in this migration.
- Never leave the tree half-moved: if a step cannot be finished, `git checkout -- apps/cli` and
  `git clean -fd apps/cli/src/tui`, then redo it smaller.
