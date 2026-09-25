#!/bin/sh
# Self-healing `gh` wrapper. Lives in the dsh systemd unit's PATH ahead of
# the real `gh` (see local-ai-machine/configuration.nix's dsh.service PATH
# comment) - it does NOT replace the box's own system-wide `gh` binary,
# which chris's own OAuth session and the M-021 benchmark still use
# untouched. GH_REAL_BIN (set in that same unit's Environment, resolved
# from nixpkgs' gh derivation) is the actual binary this delegates to.
#
# WHY: the dsh-gh-token-refresh systemd timer keeps a fresh GitHub App
# installation token in $DSH_HOME/.gh-installation-token every 45 min and
# feeds it to `gh auth login`. But a timer can miss a beat (the box was
# down, systemd was reloaded, ...), and when it does, the token in gh's
# hosts.yml expires after its ~1h lifetime and every `gh` API call fails
# with an auth error. This wrapper makes `gh` (and `gh api`) self-healing:
# if the cached token is missing or older than ~40 min, it mints a fresh one
# and re-auths before delegating to the real binary. The common (fresh-token)
# path is a single file-age check — no subprocess, no added latency.
#
# This is why the refresh timer's own service calls $GH_REAL_BIN directly,
# never this wrapper: it IS the refresher, so routing it through the
# wrapper would double-mint on the slow path.
GH_REAL_BIN="${GH_REAL_BIN:?GH_REAL_BIN must be set to the real gh binary}"
# Explicit env var, not $(dirname "$0"): this script is reached via a
# wrapper-directory symlink (see configuration.nix), and resolving the
# real script location from a symlink's own invocation path is exactly
# the class of bug M-154 already hit once with DSH_HOME's symlink
# breaking Node's module resolution - an explicit absolute path sidesteps
# it entirely rather than re-deriving it unreliably.
DSH_DEPLOY_DIR="${DSH_DEPLOY_DIR:?DSH_DEPLOY_DIR must be set to the dsh-deploy checkout}"
TOKEN_FILE="${DSH_HOME:-/dsh-home}/.gh-installation-token"
MAX_AGE=2400  # 40 min — comfortably inside the 1h installation-token lifetime
now=$(date +%s)
age=999999
[ -f "$TOKEN_FILE" ] && age=$(( now - $(stat -c %Y "$TOKEN_FILE") ))
if [ "$age" -ge "$MAX_AGE" ]; then
  tok="$(node "$DSH_DEPLOY_DIR/github-app-token.mjs" 2>/dev/null)" || true
  if [ -n "$tok" ]; then
    ( umask 077; printf '%s\n' "$tok" > "$TOKEN_FILE" )
    printf '%s\n' "$tok" | env -u GH_TOKEN "$GH_REAL_BIN" auth login --with-token >/dev/null 2>&1 || true
  fi
fi
exec "$GH_REAL_BIN" "$@"
