#!/usr/bin/env bash
# Create a worktree for one item, with its own node_modules.
#
#   scripts/new-worktree.sh <name> [branch]
#
# Makes .claude/worktrees/<name> under the MAIN checkout (even when run from inside another
# worktree), on a new branch (default: <name>) cut from a freshly fetched origin/main, then runs
# `npm ci` in it.
#
# Why each step:
# - origin/main, fetched: branching off whatever happens to be checked out has carried an unmerged
#   change into an unrelated PR.
# - npm ci: a worktree has no node_modules. Without its own, module resolution walks up into the
#   main checkout's node_modules and the build fails on whatever that copy lacks (@xterm/xterm,
#   2026-09-23), with an error that does not say so. Never symlink the main checkout's
#   node_modules instead: electron-builder resolves through the link to 50 deps @undefined.
# - Refuse an existing directory: if a file write creates the path first, `git worktree add`
#   fails with "already exists". Create the worktree before writing anything into it.
set -euo pipefail

name=${1:?usage: scripts/new-worktree.sh <name> [branch]}
branch=${2:-$name}

main=$(git worktree list --porcelain | awk 'NR == 1 { print $2 }')
dir="$main/.claude/worktrees/$name"

if [ -e "$dir" ]; then
  echo "new-worktree: refusing, $dir already exists" >&2
  exit 1
fi

git -C "$main" fetch --quiet origin main
git -C "$main" worktree add -b "$branch" "$dir" origin/main
cd "$dir"
npm ci

echo "new-worktree: ready at $dir (branch $branch, origin/main $(git rev-parse --short HEAD))"
