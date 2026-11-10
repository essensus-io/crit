# Changelog

## 1.1.0

### GitHub integration

- Post findings to the pull request of your branch. In the review screen, `c` posts the finding you are on as
  an inline comment. `crit review --gh` (alias `--pr`) runs a review without the screen and posts every open
  finding as one GitHub review.
- Fixes are attached as GitHub suggested changes when they are a small edit of lines that exist unchanged on
  the PR, so they can be committed with one click. Other fixes are shown as a short diff without file headers.
- Findings whose code is not part of the PR diff go in the review text instead of being dropped. Findings
  already posted are skipped on a re-run, and `@mentions` in model text are defused so nobody is notified.
- The pull request is looked up before the review starts, so a missing PR or a missing `gh` login costs no
  tokens.
- Connect GitHub from `o` then `g`, on the start screen or in a review. It shows the active account and runs
  `gh auth login` for you when you are signed out. Works with several saved accounts, even when one is broken.
- Needs the GitHub CLI (`gh`). crit stores no GitHub credentials.

### Review another branch

- `crit review --branch <name-or-PR-link>`, or **Another branch or PR…** on the start screen, reviews a branch
  you are not on. Nothing is checked out: crit diffs and reads files straight from git and fetches the branch
  from `origin` when you do not have it. Accepts a branch name, `origin/name`, a GitHub PR link or a `/tree/`
  link.
- The base branch is the nearest one, not the first one found, so the diff is not inflated by a stale
  `origin/main`.
- Fixes of such a review cannot be applied to your working tree. Post comments instead.

### Minor fixes

- Choosing a provider, model, effort or depth now returns to the options menu instead of dropping you on the
  main screen, and the confirmation shows at the bottom of the menu.
- Provider is the first item in the options menu.
- `pnpm install:cli` runs the install script.
- The install source moved to the `essensus-io` organization.
- Windows: paths, line endings and shell commands behave the same as on macOS and Linux, so the Windows CI
  tests pass.
- `apps/cli/src/views` now holds only screens. Command runners moved to `app/runners`.
