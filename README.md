# crit

Local-first AI code review in your terminal. crit runs the agent CLI you already
use (Claude Code, Codex or Cursor) headlessly, collects its findings through a
small MCP server, and shows them in an interactive full-screen UI where you
check what to keep, apply the fixes, and undo them. Nothing leaves your machine
except what your agent CLI already sends.

> Status: pre-release (`0.0.0`, not published). The package name `@crit/cli` and
> the `$schema` URLs in the generated JSON schemas are placeholders until a final
> name is chosen.

## Install

Requires Node 24+, git, and at least one of `claude`, `codex`, `cursor-agent`
logged in.

```sh
npm i -g @crit/cli      # once published; for now: pnpm build && node apps/cli/dist/index.js
crit doctor             # which agent CLIs are installed, logged in, and tested
crit review             # first run walks you through connecting a provider
```

## Use

```sh
crit review                      # the current branch against its nearest base branch
crit review --staged             # staged changes
crit review --commit HEAD~1      # one commit
crit review src/billing          # paths, folders, globs (add --diff for changed files only)
crit review --all                # the whole project (asks first)
crit review --dry-run            # files, skipped files, runs and token estimate; no agent calls
crit review --no-tui --format md # a report for CI: json, md or sarif; --fail-on major exits 3
crit open                        # reopen the latest saved review
crit apply / crit undo           # apply all checked fixes / undo the last apply
crit history                     # browse, compare (--compare a b), rm, prune --older-than 90d
```

### The screen

The UI runs on the terminal's alternate screen: your terminal's own scrollback
is untouched and comes back when you leave, and only the panels inside crit
scroll (`j/k`, arrows, PgUp/PgDn, `g/G`, the mouse wheel).

| Key              | Does                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `j` `k` / arrows | move; scroll long text                                                    |
| `space`          | check or uncheck a finding                                                |
| `enter`          | open a finding: what is wrong, how it fails, the rule, the fix diff       |
| `p`              | propose a fix · `e` edit it in `$EDITOR` · `a` apply checked fixes        |
| `d`              | dismiss with a reason (remembered as a false positive)                    |
| `y`              | copy the finding as a prompt for another agent                            |
| `r`              | re-check this finding's file                                              |
| `R`              | rules panel: turn a rule off (its files are re-checked) or back on        |
| `/` `s`          | search · filter by severity                                               |
| `m` `P` `E` `D`  | change model · provider · reasoning effort · depth for the next AI action |
| `S`              | save the current model/provider/effort as the profile default             |
| `q`              | back / quit                                                               |

While a review runs, the same keys apply to the _next_ run: change something and
press `r` to retry with it. Finished files are cached, so a retry only pays for
what is left.

## Tokens: what a review costs, and how to control it

crit counts **effective tokens** = fresh input + output + 0.1 × cached input, which
is what actually drives cost and rate limits.

- `--dry-run` shows the plan and estimate first; reviews above 500k estimated
  tokens ask before starting (`--yes` skips, `budget.confirmTokens` changes it).
- A hard stop at `budget.maxTokens` (default 2M, `--budget 500k`). The review
  ends as `partial`, keeps its findings, and a re-run resumes from the cache.
  Claude Code reports usage per message so it stops mid-run; Codex and Cursor
  report at the end of a run, so they can overshoot by one run.
- Per-file cache: unchanged files (same content, hunks, rules, lenses, provider,
  model) are answered from the cache at zero tokens, including skeptic verdicts.
- Noise is skipped (lockfiles, generated files, snapshots, binaries, fonts,
  Markdown/SVG, agent config); `--dry-run` lists what was skipped and why.
- The base branch is the _nearest_ candidate (fewest commits ahead), so a branch
  cut from `develop` is not compared with `main`.
- `--depth`:

|         | quick                 | standard (default)               | deep                      |
| ------- | --------------------- | -------------------------------- | ------------------------- |
| Lenses  | correctness, security | all, one pass                    | all, split                |
| Skeptic | off                   | critical/major/minor, fast model | every finding, main model |
| Effort  | low                   | profile                          | high                      |

## Providers and models

```sh
crit providers                         # list profiles
crit providers add codex --model gpt-6-sol --effort low
crit providers models codex --search sol   # live model list from the CLI
crit review --model opus --effort high     # for one run
```

Each profile can have a `fastModel` for cheap work (skeptic, map). Models come
from the CLI itself (`codex debug models`, `cursor-agent --list-models`), with a
fallback list and "Other…" for any name. Only reasoning efforts the chosen model
supports are offered. Codex runs with `--ignore-user-config`, so your
`config.toml` model does not apply; set one on the profile.

## What crit lets the agent do

Reviews are read-only by design. How that is enforced depends on the CLI:

| Provider    | Enforcement                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Only the crit MCP tools plus read tools (`Read`, `Grep`, `Glob`); user settings, other MCP servers and plugins are off. Skeptic runs with no tools.    |
| Codex       | `--sandbox read-only`, ephemeral session, user config ignored, plugins/apps disabled; crit's MCP tools are pre-approved.                               |
| Cursor      | `--mode ask` (read-only) — **weaker**: Cursor has no per-run MCP, so findings come back as JSON on stdout and tool access is whatever ask mode allows. |

Fixes are applied by crit itself (`git apply --check`, backups, `crit undo`), never
by the agent.

## Configuration

- User: `providers.json` and `config.json` in the crit config directory
  (`crit doctor` prints the paths; `CRIT_HOME` overrides).
- Project (optional, committed): `.crit/config.json` — `crit init` creates it.
- Rules are read from `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, and
  `.crit/rules`; `crit rules` lists them, `crit rules add` adds one.
- JSON schemas for both files ship in `schema/` for editor completion.
- Data: a SQLite database (Drizzle ORM, migrations embedded) holds reviews,
  findings, shards and history; `crit history prune` trims it.

## Development

```sh
pnpm install
pnpm check && pnpm check-types && pnpm test      # lint/format, types, unit + e2e
pnpm test:coverage                               # thresholds enforced
CRIT_LIVE=1 pnpm test:live                       # real agent CLIs, opt-in, spends tokens
pnpm --filter @crit/store db:generate            # after editing the Drizzle schema
```

Monorepo (pnpm + Turborepo): `schema` (Zod), `store` (Drizzle + `node:sqlite`),
`core` (scope, rules, sharding, pipeline), `providers` (adapters), `mcp`,
`testkit` (fake agent), `apps/cli`.

MIT licensed.
