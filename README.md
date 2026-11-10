# crit

Local-first AI code review in your terminal. crit runs the agent CLI you already
use (Claude Code, Codex or Cursor) headlessly, collects its findings through a
small MCP server, and shows them in an interactive full-screen UI where you
check what to keep, apply the fixes, and undo them. Nothing leaves your machine
except what your agent CLI already sends.

> Version: `1.1.0` (internal distribution; not published to npm). The package name `@crit/cli` and
> the `$schema` URLs in the generated JSON schemas are placeholders until a final
> name is chosen.

## Install

Requires Node 24+, git, and at least one of `claude`, `codex`, `cursor-agent`
logged in.

### Internal team setup (macOS / Linux)

With read access to this repository and normal Git SSH authentication, run:

```sh
git clone --depth 1 git@github.com:essensus-io/crit.git && bash crit/scripts/install.sh
```

No GitHub CLI is needed. You need read access to the `essensus-io` organization.
If you authenticate over HTTPS instead of SSH, use
`https://github.com/essensus-io/crit.git`.

Setup builds the CLI and installs the `crit` command into `~/.local/bin` without
sudo or publishing anything to npm. pnpm is downloaded automatically at the
version pinned by this repository. If setup adds a directory to your shell's
PATH, open a new terminal afterwards. Each person needs their own logged-in agent
CLI; the first review guides them through provider selection.

Then, from any repository:

```sh
crit doctor             # check the local setup
crit review             # connect a provider and open the review screen
```

Already have a checkout? Run this from its root:

```sh
pnpm install:cli          # same as: bash scripts/install.sh
```

To update, run this from your Crit checkout:

```sh
git pull --ff-only && bash scripts/install.sh
```

Updates
preserve each person's provider settings and review history; the installed app
works even if the checkout is removed. `CRIT_INSTALL_PREFIX` overrides the
default `~/.local` installation directory.

You can also share `scripts/install.sh` directly. Outside a checkout it fetches
the source into a temporary directory and removes it after installation. The
default source is `essensus-io/crit`; set `CRIT_INSTALL_REPO` to another `org/repo` or a full Git URL, and
optionally `CRIT_INSTALL_REF` to a branch or tag (default: `main`):

```sh
CRIT_INSTALL_REPO=essensus-io/crit bash install.sh
```

To remove the command (settings and history are kept):

```sh
npm uninstall --global --prefix "$HOME/.local" @crit/cli
```

## Use

```sh
crit                             # the start screen: pick what to review, see the cost, press enter
crit review                      # the same; reviews never start by themselves
crit review --now                # skip the start screen and review straight away
crit review --staged             # staged changes (the start screen opens with it selected)
crit review --commit HEAD~1      # one commit
crit review --branch feat/x      # another branch or a PR link, no checkout; you can only post comments
crit review src/billing          # paths, folders, globs (add --diff for changed files only)
crit review --all                # the whole project (asks first)
crit review --dry-run            # files, skipped files, runs and token estimate; no agent calls
crit review --no-tui --format md # a report for CI: json, md or sarif; --fail-on major exits 3
crit review --gh                 # review and post the findings to this branch's GitHub PR (needs gh)
crit open                        # reopen the latest saved review
crit apply / crit undo           # apply all checked fixes / undo the last apply
crit history                     # browse, compare (--compare a b), rm, prune --older-than 90d
```

### Pull request comments

`crit review --gh` (or `--pr`) runs the review without the screen and posts every open finding as
one GitHub review with inline comments on the open pull request of your branch. In the
review screen, `c` posts the finding you are on to the PR and `enter` applies the checked
fixes locally; that is all. Press `o` then `g` on the start screen or
in a review to connect GitHub (it runs `gh auth login` for you). It needs the GitHub CLI (`gh`, logged in
with `gh auth login`) and finds the PR before the review starts, so a missing PR costs no
tokens. Findings whose code is not in the PR diff go in the review text, findings already
posted are skipped on a re-run, and fixes are attached as `diff` blocks.

### Reviewing someone else's branch

`crit review --branch <name-or-PR-link>`, or **Another branch or PR…** on the start screen, reviews a branch
you are not on. Nothing is checked out: crit diffs and reads the files straight from git (fetching the
branch from `origin` if you don't have it) and compares it with the base branch. Fixes cannot be applied
to your working tree, so `enter` and `x` refuse; press `c` to post a finding to that branch's PR, or add
`--gh` to post them all.

### The start screen

Running `crit` in a terminal opens the start screen. Pick a scope (this branch against
its base, staged changes, the last commit, the whole project, or paths you type), see
how many files, runs and tokens it would cost, and press `enter` to start. Past
reviews of the repository are listed on the right (`tab`, then `enter` reopens one).
`o` changes the provider, model, effort and depth. When a review is finished, `q`
brings you back here; `q` again quits.

### The screen

The review is one scrolling stream: each file with findings shows the code around
them (changed lines marked `+`, syntax highlighted for TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, Swift, Ruby, PHP, C/C++/C#, CSS, HTML, JSON, YAML, Markdown, SQL and shell), and every finding is a card right under the lines
it is about. `○` is pending, `✓` accepted, `✗` dismissed. The bottom line says how
far you are ("2 of 5 reviewed · 1 accepted") and lists only the keys that work
right now; press `?` for all of them.

It runs on the terminal's alternate screen: your terminal's own scrollback is
untouched and comes back when you leave, and only the panels inside crit scroll.

| Key             | Does                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `j` `k` `↑` `↓` | next / previous finding (the mouse wheel too)                                                                                   |
| `space`         | check the fix to apply it (again to uncheck). Unchecked fixes are left alone                                                    |
| `d`             | skip: dismiss with a reason, remembered as a false positive (again to restore)                                                  |
| `enter`         | apply every checked fix, once you have been through all findings (it tells you if some were not looked at)                      |
| `i`             | propose your fix: tell the AI what it should be; it writes it in the background, then check it or not                           |
| `c`             | post this finding to this branch's GitHub PR as a comment, fix attached if it has one                                           |
| `x`             | apply just this fix now                                                                                                         |
| `r`             | re-run the review of this scope, reviewing every file again (no cache)                                                          |
| `PgUp` `PgDn`   | scroll the code                                                                                                                 |
| `/`             | search: words, `sev:major`, `lens:security`, `file:cart`, `has:fix`, `is:pending`, `is:filtered`                                |
| `.`             | actions: propose a fix, edit it in `$EDITOR`, ask a question, re-check the file, copy as a prompt, use my fix                   |
| `o`             | options: provider, model, reasoning effort, depth, save as default, rules on/off                                                |
| `y`             | copy the finding as a prompt for another agent                                                                                  |
| `tab` `]` `[`   | next / previous file (`h` `l` or the arrows switch between the files list and the code; in the list `j` `k` jump between files) |
| `g`             | first finding                                                                                                                   |
| `?` `q`         | help · back to the start screen (quit when opened with `crit open`)                                                             |

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
