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

# gh wrapper: a plain directory of just this one symlink, prepended onto
# the dsh systemd unit's PATH ahead of the box's own system-wide `gh`
# (see configuration.nix's dsh.service PATH comment) - this does NOT
# touch or shadow that system-wide `gh`, which chris's own OAuth session
# and the M-021 benchmark still use directly.
mkdir -p "$REPO_DIR/.bin"
ln -sfn "$REPO_DIR/gh-wrapper.sh" "$REPO_DIR/.bin/gh"
echo "gh wrapper linked: $REPO_DIR/.bin/gh -> gh-wrapper.sh"

# git credential helper + insteadOf rewrites (M-154, ported from the old
# Docker entrypoint's per-boot setup). --unset-all before --add each time:
# url.<base>.insteadOf is multi-valued, so a later plain `git config` call
# would refuse to overwrite once it holds more than one value - confirmed
# live in the old Docker setup (crash-looped on the container's second-ever
# restart before this fix). Safe to re-run this script any number of times.
git config --global credential.helper "$REPO_DIR/github-app-git-credential-helper.mjs"
git config --global --unset-all url."https://github.com/".insteadOf 2>/dev/null || true
git config --global --add url."https://github.com/".insteadOf "git@github.com:"
git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"

# Boot smoke test, run the way an agent session will actually see the
# helper: dsh's subprocess layer (dsh-subprocess's scrubbedParentEnv)
# strips GITHUB_APP_PRIVATE_KEY_PATH from every session shell (matches
# /KEY|PASSWORD|SECRET|TOKEN/i) - unsetting it here reproduces that,
# so a regression in the fixed-path fallback surfaces now rather than as
# a mid-session git push failure. Non-fatal: gh itself never consults
# git's credential helper, and a failing mint still leaves the gh
# fallback (see the helper's own header comment).
cred_out="$(printf 'protocol=https\nhost=github.com\n\n' | \
  env -u GITHUB_APP_PRIVATE_KEY_PATH node "$REPO_DIR/github-app-git-credential-helper.mjs" get 2>/dev/null)" || cred_out=""
case "$cred_out" in
  *"password=ghs_"*) echo "git credential helper: boot smoke test OK (minted a real installation token)" ;;
  *) echo "warning: git credential helper boot smoke test produced no installation token - git pushes may be broken (gh unaffected)" >&2 ;;
esac

echo "== init complete. Start/restart the 'dsh' systemd service to pick this up. =="
