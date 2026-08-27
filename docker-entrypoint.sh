#!/bin/sh
set -e

# Seed-once file copy (M-132, 2026-08-26), same pattern jmfederico-pi-web/
# oh-my-pi already use: dsh-home-seed/ ships baked into the image (COPY'd
# to /app/dsh-home-seed in the Dockerfile) and gets copied into place here
# on first boot ONLY — every check below is guarded so an existing
# (possibly agent-edited) file/dir is never overwritten by a restart.
#
# Previously (pre-M-132) these paths were bind-mounted DIRECTLY from a live
# git checkout of local-ai-machine on the host, so any edit was immediately
# a commit-ready change to that checkout — dsh-deploy is now a pulled
# image with no checkout on the box, so that specific property (instant
# git-trackability) is gone. What it doesn't affect: dsh's own "creator
# mode" is a built-in @deepseek-ai/dsh capability (plain filesystem writes
# to wherever its config directory is mounted), not something this repo
# implemented or is redesigning — dsh still gets a writable, durable
# directory to self-edit here, exactly as before, it's just no longer
# automatically a live git working tree underneath it.
mkdir -p "$DSH_HOME/profiles"
if [ -z "$(ls -A "$DSH_HOME/profiles" 2>/dev/null)" ]; then
  cp -r /app/dsh-home-seed/profiles/. "$DSH_HOME/profiles/"
fi
if [ ! -f "$DSH_HOME/AGENTS.md" ]; then
  cp /app/dsh-home-seed/AGENTS.md "$DSH_HOME/AGENTS.md"
fi
mkdir -p "$DSH_HOME/.agent-presets"
if [ -z "$(ls -A "$DSH_HOME/.agent-presets" 2>/dev/null)" ]; then
  cp -r /app/dsh-home-seed/agent-presets/. "$DSH_HOME/.agent-presets/"
fi
# /dsh-home-seed: the whole dsh-home-seed tree, at this separate top-level
# path specifically because dsh's own settings-file plugin (each profile's
# cordis.patch.yml, `id: settings`, config.path) points at
# /dsh-home-seed/settings.yaml instead of the default $DSH_HOME/
# settings.yaml — a real requirement, not cosmetic: dsh-atomic-write saves
# settings via a same-directory temp file + rename, and a single-file bind
# mount previously made that rename fail with EBUSY (a rename can never
# replace an active bind-mount point). That constraint doesn't actually
# apply to an ordinary seed-copied directory the way it did to a per-file
# mount, but the path itself is left exactly where dsh's own
# cordis.patch.yml files already expect it — not "cleaned up," since
# touching that config is out of scope for a deployment-mechanism change.
mkdir -p /dsh-home-seed
if [ -z "$(ls -A /dsh-home-seed 2>/dev/null)" ]; then
  cp -r /app/dsh-home-seed/. /dsh-home-seed/
fi

if [ -z "$LOCAL_AI_MACHINE_API_KEY" ]; then
  echo "LOCAL_AI_MACHINE_API_KEY is not set - refusing to start with no way to authenticate to litellm." >&2
  exit 1
fi

# $DSH_HOME's non-git-tracked state (sessions/, storages/, credentials) comes
# from a separate host bind mount (docker-compose.yml) and may be empty on
# first boot; dsh creates what it needs under it at runtime. Nothing to seed
# here.

# Third-party (non-@deepseek-ai-scoped) bundle packages need BOTH of these
# together, confirmed empirically (M-122, two failed single-fix attempts
# before this): a `dependencies` declaration in the profile's own
# package.json (dsh-home-seed/profiles/web/package.json) AND a physically
# resolvable node_modules entry right at the profile directory
# (/dsh-home/profiles/web/) — neither alone was sufficient, only both
# together produced a clean boot. That directory is bind-mounted from
# docker-compose.yml's dedicated profile-node-modules mount — NOT the same
# path this file's seed-copy above populates, which must never get stray
# generated files written into it (it's still the seed-once destination
# dsh itself edits via "creator mode", not a scratch/build directory).
# Idempotent: safe to re-run every boot.
mkdir -p "$DSH_HOME/profiles/web/node_modules"
ln -sfn /app/node_modules/dsh-web-search-searxng "$DSH_HOME/profiles/web/node_modules/dsh-web-search-searxng"

# GitHub App credential (M-132, replaces the old raw chris_github_key SSH
# mount + a separate GH_TOKEN PAT with one mechanism, both for git and gh):
#
# 1. git: a credential.helper backed by github-app-git-credential-helper.mjs
#    mints a genuinely fresh installation token PER git operation — no
#    caching, no refresh logic needed, git just asks again next time.
#    credential.helper only applies to HTTPS remotes, never SSH, so a
#    URL-rewrite rule transparently maps any git@github.com:/ssh://
#    style clone/push to https://github.com/ first — otherwise a session
#    that happens to use an SSH-style URL would silently bypass the
#    helper entirely and just fail with no credential at all.
# 2. gh CLI: unlike git, `gh` does NOT consult git's credential.helper for
#    its own API calls (pr create, etc.) — it reads its own persisted
#    token from ~/.config/gh/hosts.yml via `gh auth login`. Since that
#    token is a snapshot, not minted fresh per call like git's, it has to
#    be refreshed proactively before the ~1h installation-token lifetime
#    (a non-configurable GitHub limit) runs out — a background loop
#    re-authenticates every 45 minutes, comfortably inside that window.
#    Same scrubbedParentEnv reasoning as before (M-122): dsh's subprocess
#    layer strips any env var matching /KEY|PASSWORD|SECRET|TOKEN/i before
#    spawning a session's bash tool, so a file-backed `gh auth login`
#    (writes to hosts.yml, not process.env) is what actually survives
#    into a session, not the token itself.
if [ -n "$GITHUB_APP_ID" ]; then
  git config --global credential.helper "/app/github-app-git-credential-helper.mjs"
  git config --global url."https://github.com/".insteadOf "git@github.com:"
  git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

  (
    while true; do
      token="$(node /app/github-app-token.mjs 2>/dev/null)" || true
      if [ -n "$token" ]; then
        echo "$token" | env -u GH_TOKEN gh auth login --with-token >/dev/null 2>&1 || true
      fi
      sleep 2700
    done
  ) &
fi

exec "$@"
