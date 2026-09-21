#!/bin/sh
# Self-healing `gh` wrapper. The real gh binary lives at /usr/local/bin/gh.real.
#
# WHY: the entrypoint's background loop keeps a fresh GitHub App installation
# token in $DSH_HOME/.gh-installation-token every 45 min and feeds it to
# `gh auth login`. But that loop is a fragile background child of dsh's own
# process — it can die (a reload, a signal to dsh's process group, a manual
# re-run of the entrypoint, a container quirk). When it does, the token in
# gh's hosts.yml expires after its ~1h lifetime and every `gh` API call fails
# with an auth error. This wrapper makes `gh` (and `gh api`) self-healing:
# if the cached token is missing or older than ~40 min, it mints a fresh one
# and re-auths before delegating to the real binary. The common (fresh-token)
# path is a single file-age check — no subprocess, no added latency.
#
# This is why the entrypoint loop calls gh.real directly: it IS the refresher,
# so routing it through this wrapper would double-mint on the slow path.
TOKEN_FILE="${DSH_HOME:-/dsh-home}/.gh-installation-token"
MAX_AGE=2400  # 40 min — comfortably inside the 1h installation-token lifetime
now=$(date +%s)
age=999999
[ -f "$TOKEN_FILE" ] && age=$(( now - $(stat -c %Y "$TOKEN_FILE") ))
if [ "$age" -ge "$MAX_AGE" ]; then
  tok="$(node /app/github-app-token.mjs 2>/dev/null)" || true
  if [ -n "$tok" ]; then
    ( umask 077; printf '%s\n' "$tok" > "$TOKEN_FILE" )
    printf '%s\n' "$tok" | env -u GH_TOKEN /usr/local/bin/gh.real auth login --with-token >/dev/null 2>&1 || true
  fi
fi
exec /usr/local/bin/gh.real "$@"
