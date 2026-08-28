# dsh-deploy

CI-built container image and Docker Compose service fragment for running
[`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) ("dsh",
DeepSeek Harness) as a service on `local-ai-machine`. This repo owns the
image build and the compose service definition; it does not itself run
anywhere standalone.

## What dsh is

dsh is a coding-agent CLI/web tool, similar in spirit to Claude Code. This
repo packages its `web` subcommand (`dsh web`) so it's reachable as a
long-running local service rather than a one-shot CLI invocation. The
Dockerfile installs `@deepseek-ai/dsh` via npm alongside a handful of CLI
tools dsh's own bash tool can call inside a session (`git`, `gh`, `jq`,
`yq`, `docker` CLI, etc.) and a searxng-backed web-search plugin
(`dsh-web-search-searxng`) that needs to live in the same flat
`node_modules` tree as dsh itself for its peer dependencies to resolve.

The container binds only to `127.0.0.1` (dsh refuses `0.0.0.0`
unconditionally) — reachable via SSH tunnel only, matching this box's
convention for every other unauthenticated local service. There is
deliberately no reverse proxy/TLS in front of it: dsh's frontend needs a
secure browser context, and its own configuration plane hard-pins to a
literal `localhost`/`127.0.0.1` Host header — a plain SSH tunnel straight
to the loopback bind satisfies both requirements at once; no proxy
topology can (see the Dockerfile's top-of-file comment for the fuller
history, including a prior Caddy attempt that was tried and removed).

### `dsh-home-seed/`

`dsh-home-seed/` is baked into the image (`/app/dsh-home-seed`) and holds
dsh's config-as-code defaults: agent presets (`code-local`,
`standard-local` — local-ai-machine-specific compaction/model-picker
tuning layered on dsh's shipped presets), per-profile `cordis.patch.yml`
plugin config, and `settings.yaml` (the litellm-backed model roster dsh's
model picker uses). `docker-entrypoint.sh` copies this tree into
`$DSH_HOME` on first boot only, using `cp -rn` (no-clobber, but recursing
into already-existing directories) so it never overwrites a file dsh's own
"creator mode" has since edited, and so a destination directory Docker
itself pre-created as a mount-point ancestor doesn't cause the whole
seed-copy to silently no-op. `settings.yaml` also gets copied to a second,
separate top-level path (`/dsh-home-seed`) because each profile's
`cordis.patch.yml` points its settings-file plugin there directly.

### GitHub App credential

dsh needs its own git/`gh` write credentials for git operations it
performs while running (commits, pushes, PRs it makes as part of a coding
session) — separate from whatever credential a human or agent session
pushing changes *to this repo's own source* uses. `dsh`, `oh-my-pi`, and
`pi-web` (the sibling agent-tool wrappers from the same repo split) share
one GitHub App installation for this purpose.

- `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` — plain env vars, not
  secret (real values live on `local-ai-machine`'s board card).
- The private key is a file, mounted read-only at
  `GITHUB_APP_PRIVATE_KEY_HOST_PATH` (`/home/chris/.secrets/github-app-agent-key.pem`
  on the host) — never committed to any repo.
- Permissions on the App installation: Contents, Pull requests, Actions,
  and Workflows read-write; Metadata read-only (GitHub's mandatory
  baseline).

`github-app-token.mjs` mints a fresh ~1h installation access token per
invocation via `@octokit/auth-app`; it never caches anything to disk.
`github-app-git-credential-helper.mjs` wraps it as a git
`credential.helper` (`get` reads a token and prints
`username=x-access-token` / `password=<token>`; `store`/`erase` are
no-ops since there's nothing cached to manage). Because
`credential.helper` only applies to HTTPS remotes, `docker-entrypoint.sh`
also rewrites `git@github.com:`/`ssh://git@github.com/` URLs to
`https://github.com/` so an SSH-style clone/push can't silently bypass the
helper. The `gh` CLI doesn't consult git's credential helper for its own
API calls, so a background loop in `docker-entrypoint.sh` re-runs
`gh auth login --with-token` every 45 minutes, comfortably inside the ~1h
token lifetime.

## How it's deployed

This repo publishes a CI-built OCI image to
`ghcr.io/chrisjohnson/dsh-deploy` (see `.github/workflows/build.yml`) —
built and pushed on every branch push, tagged with the branch name and the
full commit SHA; `latest` is additionally applied only on pushes to the
default branch.

`local-ai-machine` vendors this repo two ways:

- **The compose fragment** (`docker-compose.yml` in this repo) is pulled
  in as a Nix flake input, pinned in `local-ai-machine`'s `flake.nix`. A
  stable symlink that `configuration.nix`'s `linkComponentCompose`
  activation script maintains always points at whatever Nix store path is
  currently pinned, and `local-ai-machine`'s own
  `docker/docker-compose.yml` pulls it in via
  `include: - path: /etc/local-ai-machine-components/dsh-deploy/docker-compose.yml`.
  Nix's role here is only vendoring this file's YAML text — this repo is
  a plain, non-flake, read-only vendored source tree from
  `local-ai-machine`'s perspective. Bumping the pin is
  `deploy.sh --update-input dsh-deploy` in `local-ai-machine`, followed by
  a normal deploy switch.
- **The image itself** is an ordinary OCI pull from GHCR, unrelated to the
  Nix pin above. Its tag is `DSH_DEPLOY_TAG` in `local-ai-machine`'s
  `docker/.env` — empty defaults to `:latest`, but can be pointed at a
  specific branch or commit-SHA tag this repo's own CI already published,
  so a change here can be tested on the box before it's merged to `main`.

The compose fragment itself (`docker-compose.yml`) owns dsh's mount
topology and structure (image reference, volumes, environment variable
names); `local-ai-machine`'s own `.env` supplies only the machine-specific
values those variables reference. A self-contained change to dsh's mount
layout (a new durable path, a renamed env var) is a change to this repo
alone, not a coordinated edit across both repos.

## Related repos

Part of the same repo split as `local-ai-machine`, `oh-my-pi-deploy`,
`pi-web-deploy`, and `strix-halo-r9700-llm-builds`. See
`local-ai-machine`'s own `AGENTS.md` ("Component deploy mechanism") for
the general vendoring pattern shared across all of these.
