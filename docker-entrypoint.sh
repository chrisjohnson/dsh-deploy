#!/bin/sh
set -e

# Unlike jmfederico-pi-web, there is no seed-once file copy here: settings.yaml
# and profiles/ are bind-mounted DIRECTLY from the git-tracked dsh-home-seed/
# in this repo (see docker-compose.yml), not copied into a separate runtime
# location. An edit under those paths — by a human, or by dsh's own agent in
# a session — IS an edit to the checked-out git working tree on the host,
# ready to `git add`/commit. That is the whole point (M-122: dsh "creator
# mode" compatibility) and it must not be undone by copying seeds elsewhere.

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
# docker-compose.yml's dedicated (non-git) profile-node-modules mount — NOT
# from dsh-home-seed/profiles/ itself, which is the git working tree on the
# host and must never get stray generated files written into it.
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
