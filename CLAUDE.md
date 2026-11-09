# crit

A local-first AI code review CLI. It runs Claude Code, Codex or Cursor headlessly, collects findings
over an MCP server, and shows them in a full-screen terminal UI. pnpm + Turborepo monorepo, Node 24,
TypeScript 6 (ESM, strict), Ink 8 + React 19, Vitest, oxlint/oxfmt, Drizzle on `node:sqlite`.

## Commands

- `pnpm check` lint + format check (oxlint, oxfmt); `pnpm fmt` fixes formatting
- `pnpm check-types` type-check every package (turbo); `pnpm test` all tests; `pnpm test:coverage`
- `pnpm --filter @crit/cli build` build the binary to `apps/cli/dist`
- `pnpm --filter @crit/schema generate` regenerate the JSON Schemas after a schema change

## Rules

Project rules are in `.claude/rules`. Read them before changing code:

@.claude/rules/general/core-standards.mdc
@.claude/rules/general/monorepo-structure.mdc

Always read `.claude/rules/cli/folder-structure.mdc` before touching `apps/cli`. Scoped rules, read when you work in that area:

- `.claude/rules/general/testing.mdc` tests
- `.claude/rules/cli/react-components.mdc`, `.claude/rules/cli/terminal-ui.mdc` Ink components and terminal behaviour
- `.claude/rules/technologies/store-drizzle-sqlite.mdc` `packages/store`
- `.claude/rules/technologies/schema-zod.mdc` `packages/schema`

Skills: `commit-messages` (every commit), `turborepo` (turbo config and CI).

## Hard constraints

- Never run `npm publish`; the package name stays `@crit/cli`.
- Never touch the real crit database or `providers.json` in tests or scripts; use a temp dir.
- Never print or commit credentials. Commits use `type(scope): subject` (see the commit-messages skill).
- Run `pnpm check`, `pnpm check-types` and `pnpm test` before saying a change is done.
