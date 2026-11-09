#!/usr/bin/env bash
# Run from a checkout, or distribute this script to teammates directly.
set -euo pipefail

fail() { printf 'crit setup: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail 'Install Node.js 24 or newer, then run setup again.'
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' ||
  fail 'Node.js 24 or newer is required. Upgrade Node, then run setup again.'
command -v npm >/dev/null 2>&1 || fail 'npm is required (it ships with Node.js).'
command -v git >/dev/null 2>&1 || fail 'git is required.'

install_prefix="${CRIT_INSTALL_PREFIX:-$HOME/.local}"
[[ "$install_prefix" = /* ]] || fail 'CRIT_INSTALL_PREFIX must be an absolute path.'
setup_tmp="$(mktemp -d "${TMPDIR:-/tmp}/crit-setup.XXXXXX")"
trap 'rm -rf "$setup_tmp"' EXIT

# A local checkout also supports testing unreleased changes without pushing.
source_root=''
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  candidate_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ -f "$candidate_root/apps/cli/package.json" ]]; then
    source_root="$candidate_root"
  fi
fi
if [[ -z "$source_root" ]]; then
  install_repo="${CRIT_INSTALL_REPO:-ihornovykov/crit}"
  install_ref="${CRIT_INSTALL_REF:-main}"
  printf 'Fetching %s (%s)…\n' "$install_repo" "$install_ref"
  # Use the same SSH keys / credential helper as normal Git operations.
  case "$install_repo" in
    *://*|git@*|/*) install_url="$install_repo" ;;
    *) install_url="git@github.com:${install_repo%.git}.git" ;;
  esac
  git clone --depth 1 --branch "$install_ref" "$install_url" "$setup_tmp/source"
  source_root="$setup_tmp/source"
fi

cd "$source_root"
package_manager="$(node -p 'require("./package.json").packageManager')"
[[ "$package_manager" == pnpm@* ]] || fail 'Expected a pinned pnpm version in package.json.'
printf 'Installing build dependencies and building crit…\n'
npm exec --yes --package="$package_manager" -- pnpm install --frozen-lockfile
npm exec --yes --package="$package_manager" -- pnpm build

# Install the distributable, not a symlink into the checkout. Moving/deleting the
# checkout afterwards does not break crit (or its MCP subprocess).
cd "$source_root/apps/cli"
npm pack --pack-destination "$setup_tmp" >/dev/null
packages=("$setup_tmp"/*.tgz)
[[ ${#packages[@]} -eq 1 && -f "${packages[0]}" ]] || fail 'Expected one CLI package.'
printf 'Installing crit into %s…\n' "$install_prefix"
npm install --global --prefix "$install_prefix" --omit=dev --no-audit --no-fund "${packages[0]}"
"$install_prefix/bin/crit" --version

case ":$PATH:" in
  *":$install_prefix/bin:"*) ;;
  *)
    # Persist the path once. A child process cannot change its parent's PATH,
    # so the new command is available after opening a new terminal.
    shell_config=''
    setup_shell="${SHELL:-}"
    case "${setup_shell##*/}" in
      zsh) shell_config="${ZDOTDIR:-$HOME}/.zshrc" ;;
      bash)
        if [[ "$(uname -s)" == Darwin ]]; then
          shell_config="$HOME/.bash_profile"
        else
          shell_config="$HOME/.bashrc"
        fi ;;
    esac
    printf -v path_line 'export PATH=%q:"$PATH"' "$install_prefix/bin"
    if [[ -n "$shell_config" ]]; then
      if ! grep -Fqx -- "$path_line" "$shell_config" 2>/dev/null; then
        printf '\n# crit CLI\n%s\n' "$path_line" >> "$shell_config"
      fi
      printf '\nAdded crit to %s. Open a new terminal to use it.\n' "$shell_config"
    else
      printf '\nAdd this to your shell configuration:\n%s\n' "$path_line"
    fi ;;
esac
printf '\nSetup complete. In any repository, run:\n  crit doctor\n  crit review\n\nRerun setup to update. Your provider settings and review history are kept.\n'
