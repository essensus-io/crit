---
name: commit-messages
description: Write commit messages in crit's conventional format, type(scope): subject, with scopes taken from the monorepo's packages. Use when asked for a commit message, to review staged changes, or to commit.
---

# Commit messages

Format: `type(scope): subject`

- **type**: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `style`, `revert`.
- **scope** (optional but preferred): the package or area touched.
  - Packages: `schema`, `store`, `core`, `providers`, `mcp`, `testkit`, `config`
  - App: `cli` for commands and wiring, `tui` for the terminal UI (`apps/cli/src/tui`)
  - Cross-cutting: `deps`, `release`, `docs`
  - Several packages for one change: use the one that owns the behaviour; mention the others in the body.
- **subject**: imperative, lower-case, no trailing period, under 72 characters, says what changed for a
  reader of the log (`fix(core): skip cached files whose finding was rejected`), not how.

## Examples

- `feat(tui): check a fix with space and move on to the next finding`
- `fix(core): do not cache a file when the agent's finding was rejected`
- `refactor(cli): split the review command into parse and run`
- `test(providers): cover the Models API fallback`
- `build(deps): bump drizzle-orm`

## How to write one

1. Read `git diff --staged` (or `git diff` if nothing is staged) and `git status`.
2. One commit is one logical change. If the diff mixes a refactor and a behaviour change, say so and suggest
   splitting it rather than writing "and".
3. Pick the type from the intent, the scope from the paths, then write the subject.
4. Add a body only when the why is not obvious: wrap at 100, explain the cause and the decision, not the diff.
5. Run `pnpm check` first when asked to commit; the pre-commit hook runs oxlint and oxfmt on staged files.

## Trailer

Commits made by Claude end with a blank line and the `Co-Authored-By: <model> <noreply@anthropic.com>` line
for the model that wrote them (the exact line is given in the session's attribution instructions; never
copy it from an older commit).

Never add a Cursor trailer. Never `--no-verify`. Never push or amend unless asked.
