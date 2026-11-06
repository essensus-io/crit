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

The review is one scrolling stream: each file with findings shows the code around
them (changed lines marked `+`, syntax highlighted for TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, Swift, Ruby, PHP, C/C++/C#, CSS, HTML, JSON, YAML, Markdown, SQL and shell), and every finding is a card right under the lines
it is about. `○` is pending, `✓` accepted, `✗` dismissed. The bottom line says how
far you are ("2 of 5 reviewed · 1 accepted") and lists only the keys that work
right now; press `?` for all of them.

It runs on the terminal's alternate screen: your terminal's own scrollback is
untouched and comes back when you leave, and only the panels inside crit scroll.

| Key                   | Does                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `j` `k`               | next / previous finding                                                                                                                                       |
| `a`                   | accept the fix (again to undo); on a finding without a fix, get one: the AI writes it in the background while you keep reviewing, or you describe or write it |
| `d`                   | dismiss with a reason, remembered as a false positive (again to restore)                                                                                      |
| `enter`               | show or hide the full explanation, fix and thread in place                                                                                                    |
| `A`                   | apply every accepted fix (then `enter` for the working tree, or `b` for a new branch): accepting stages a fix, `A` writes the accepted ones to your files     |
| `R`                   | re-run the review of this scope (unchanged files come from the cache, so only changed files cost tokens)                                                      |
| `↑` `↓` `PgUp` `PgDn` | scroll the code (the mouse wheel too)                                                                                                                         |
| `/`                   | search: words, `sev:major`, `lens:security`, `file:cart`, `is:filtered`                                                                                       |
| `.`                   | actions: propose a fix, edit it in `$EDITOR`, ask a question, re-check the file, copy as a prompt, use my fix                                                 |
| `o`                   | options: model, provider, reasoning effort, depth, save as default, rules on/off                                                                              |
| `y`                   | copy the finding as a prompt for another agent                                                                                                                |
| `h` `l`               | files list ⇄ code · `g` `G` first / last finding                                                                                                              |
| `?` `q`               | help · back / quit                                                                                                                                            |

Model, provider, effort and depth apply to the _next_ ask, proposal or re-check. While
a review runs, `m` `P` `E` `D` `S` change the next run instead and `r` retries with
them; finished files are cached, so a retry only pays for what is left.

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
