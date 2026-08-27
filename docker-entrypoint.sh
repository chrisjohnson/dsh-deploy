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

# Persist GH_TOKEN into gh's own config file (M-122), not just process.env.
# dsh's subprocess layer (dsh-subprocess's scrubbedParentEnv) strips any env
# var matching /KEY|PASSWORD|SECRET|TOKEN/i - including GH_TOKEN itself -
# before spawning a sandboxed bash tool call, by hardcoded design (no
# allowlist config exists yet; its own README notes this as "future work").
# So GH_TOKEN alone authenticates a direct `docker exec dsh gh ...` but is
# invisible to a session's own bash tool, confirmed live: `gh auth status`
# succeeded outside a session and failed with no token found inside one.
# `gh auth login` writes to ~/.config/gh/hosts.yml instead - a FILE, not an
# env var, so the scrub never touches it (the same reason SSH-key git auth
# already worked fine inside sessions: key files, not env vars). This
# survives container recreates since /home/node is its own durable mount
# (see the volumes entry above). Idempotent (skips if already authenticated,
# e.g. from a previous boot) and safe to re-run every boot; `gh auth login`
# itself refuses to persist while GH_TOKEN is still in ITS OWN environment,
# hence the `env -u`.
if [ -n "$GH_TOKEN" ] && ! env -u GH_TOKEN gh auth status >/dev/null 2>&1; then
  echo "$GH_TOKEN" | env -u GH_TOKEN gh auth login --with-token
fi

exec "$@"
