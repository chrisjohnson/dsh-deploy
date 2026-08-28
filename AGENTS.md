# AGENTS.md — dsh-deploy

## What this repo is

The CI-built container image and Docker Compose service fragment for `dsh`
(`@deepseek-ai/dsh`), vendored into `local-ai-machine` as a read-only Nix
flake input. See `README.md` for what dsh is and the full layout
(`dsh-home-seed/` config-as-code, the GitHub App credential mechanism,
etc.).

## Deploy mechanism

CI (`.github/workflows/build.yml`) builds and pushes an image to
`ghcr.io/chrisjohnson/dsh-deploy` on every branch push (tagged by branch
name and full commit SHA; `latest` only on the default branch).
`local-ai-machine` consumes this repo two separate ways:

- This repo's `docker-compose.yml` is pulled in as a pinned Nix flake
  input — `local-ai-machine`'s `docker/docker-compose.yml` includes it via
  a stable symlink that `configuration.nix`'s `linkComponentCompose`
  activation script maintains. Bump the pin with
  `deploy.sh --update-input dsh-deploy` in `local-ai-machine`, then a
  normal deploy switch.
- The image itself is an ordinary GHCR pull, controlled independently by
  `DSH_DEPLOY_TAG` in `local-ai-machine`'s `docker/.env` (empty defaults
  to `:latest`) — this lets a specific branch or commit's own
  CI-published tag be run and tested on the box before that change merges
  to this repo's `main`.

See `local-ai-machine`'s own `AGENTS.md` ("Component deploy mechanism")
for the general pattern shared across all the vendored component repos
from this same split.

## Credentials

dsh needs its own git/`gh` write credentials for git operations it
performs *while running* (commits, pushes, PRs made as part of a coding
session) — this is a separate concern from whatever credential a
human/agent session pushing changes *to this repo's own source* uses
(that's just normal `gh auth`/git push from wherever that session is
working).

`dsh`, `oh-my-pi`, and `pi-web` share one GitHub App installation for
this. `GITHUB_APP_ID`/`GITHUB_APP_INSTALLATION_ID` are plain (non-secret)
env vars — real values live on `local-ai-machine`'s M-131 board card —
plus a private key file mounted read-only at
`GITHUB_APP_PRIVATE_KEY_HOST_PATH` (`/home/chris/.secrets/github-app-agent-key.pem`
on the box), never committed. Permissions: Contents/Pull requests/Actions/
Workflows read-write, Metadata read-only (GitHub's mandatory baseline).

`github-app-token.mjs` and `github-app-git-credential-helper.mjs` mint a
fresh ~1h installation token per use — no caching, nothing persisted to
disk by these scripts themselves. See the README's "GitHub App
credential" section for how git (`credential.helper` + an
SSH-to-HTTPS URL rewrite) and `gh` (a background `gh auth login` refresh
loop every 45 minutes) each consume it.

## Git workflow

**Direct pushes to `main` are explicitly authorized in this repo** — no
PR workflow, no worktree-branch requirement, same as `local-ai-machine`
itself. CI builds and publishes an image on every push to any branch, not
just `main`.

## If the standard deploy path itself is broken, or is repeatedly getting in the way

Sidestepping it is a legitimate thing to do — but flag it and confirm with
Chris first rather than silently improvising a different deploy
mechanism, same as `local-ai-machine`'s own rule.
