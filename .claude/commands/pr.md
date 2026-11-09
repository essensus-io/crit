Create or update a pull request for the current branch with the GitHub CLI (`gh`).

1. Run `git status`, `git log <base>..HEAD --oneline` and `git diff <base>...HEAD --stat` to see what the branch
   contains. The base is the branch it will merge into (`gh pr view --json baseRefName` if a PR exists,
   otherwise the repository default).
2. If a PR already exists for the branch (`gh pr view`), update its title and body with `gh pr edit`.
   Otherwise create one with `gh pr create`. Never force-push, and never push without being asked.
3. Title: conventional commit format `type(scope): subject`, scope = the package or area
   (`schema`, `store`, `core`, `providers`, `mcp`, `testkit`, `cli`, `tui`). Example:
   `feat(tui): check fixes with space and apply them with enter`.
4. Body: fill the template. Summary is 1-3 sentences on what changes for a user and why. Under Changes, list
   the packages touched and one line each. Leave the checklist as is, but only keep a box ticked if you ran it.

```md
## Summary

## Changes

- `packages/<name>`:

## Checks

- [ ] `pnpm check` (oxlint + oxfmt)
- [ ] `pnpm check-types`
- [ ] `pnpm test`
- [ ] Tried it in a real terminal (UI changes only)
```

End the PR description with:

🤖 Generated with [Claude Code](https://claude.com/claude-code)
