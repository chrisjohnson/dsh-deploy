#!/usr/bin/env bash
# Manual init/re-init for the native (no-Docker) dsh install (M-153).
#
# Deliberately NOT wired into the `dsh` systemd unit or any NixOS
# activation script - the unit only ever runs `dsh web`. Run this by hand
# over SSH (as the `dsh` user) whenever you actually want to (re)initialize:
# after the first clone, or after pulling changes that need a fresh
# `pnpm install`. The service must be startable/stoppable without this ever
# running again.
#
# Assumes this script is already checked out (i.e. `git clone` into
# /home/dsh/dsh-deploy happened once, by hand, before the first run here).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME_LINK="$HOME/.dsh"
DSH_HOME_TARGET="$REPO_DIR/.dsh"

echo "== dsh-deploy init: $REPO_DIR =="

mkdir -p "$DSH_HOME_TARGET"

if [ -L "$DSH_HOME_LINK" ]; then
  current_target="$(readlink "$DSH_HOME_LINK")"
  if [ "$current_target" != "$DSH_HOME_TARGET" ]; then
    echo "refusing to touch existing symlink $DSH_HOME_LINK -> $current_target (expected $DSH_HOME_TARGET)" >&2
    exit 1
  fi
  echo "symlink already correct: $DSH_HOME_LINK -> $DSH_HOME_TARGET"
elif [ -e "$DSH_HOME_LINK" ]; then
  echo "refusing to overwrite existing non-symlink path $DSH_HOME_LINK" >&2
  exit 1
else
  ln -s "$DSH_HOME_TARGET" "$DSH_HOME_LINK"
  echo "linked $DSH_HOME_LINK -> $DSH_HOME_TARGET"
fi

cd "$REPO_DIR"
echo "running pnpm install..."
pnpm install

echo "== init complete. Start/restart the 'dsh' systemd service to pick this up. =="
