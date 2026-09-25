# dsh-deploy

Native (no Docker) install of [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)
("dsh", DeepSeek Harness) for `local-ai-machine`, run as a NixOS systemd
service instead of a container.

**Status: promoted (M-153/M-154).** This replaces the previous Docker/
GHCR-image deploy entirely - `dsh.local-ai-machine.johnsonlab.dev` now
routes here. The old container is stopped (`docker-compose down`) but its
image/volumes are left in place in case investigation is ever needed; see
the M-153/M-154 fleet cards on `local-ai-machine` for the full port/drop
history (`dsh-claude-cli` and `@goodandready/dsh-image-gen` were dropped
per Chris's explicit decision; everything else - patches, the GitHub App
credential system, Playwright, bundle-plugin dependencies - was ported
and is live).

## What dsh is

dsh is a coding-agent CLI/web tool, similar in spirit to Claude Code. This
repo runs its `web` subcommand (`dsh web`) as a long-running native process.

## Layout

- **`package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml`**: the
  dependency graph. `pnpm-workspace.yaml`'s `overrides` block pinning every
  `@deepseek-ai/dsh-*` package to the exact installed version is
  load-bearing even for this bare install — see `AGENTS.md`'s "Upgrading
  the dsh version" section for why, and
  `scripts/update-dsh-overrides.mjs` for the regeneration tool.
- **`.dsh/`**: dsh's own `DSH_HOME`, living *inside* this checkout on
  purpose. `/home/dsh/.dsh` is a symlink into `/home/dsh/dsh-deploy/.dsh`
  (dsh's default settings-file location, `$DSH_HOME/settings.yaml`, needs
  no override here — that redirect the old Docker setup needed was purely a
  bind-mount rename limitation, moot on a real filesystem). Config edits —
  whether pushed here directly or made by dsh's own "creator mode" — land
  as plain git diffs in this directory. `.gitignore` lists the known
  state/secret subpaths (`sessions/`, `attachments/`, `cache/`, `storages/`,
  `keys/`, credentials) that must never be committed.
- **`init.sh`**: standalone, manually-run setup/re-init script (symlinks
  `~/.dsh`, runs `pnpm install`, links the `gh` wrapper, sets up git
  identity/credential.helper). **Not** wired into the systemd service —
  run it by hand over SSH whenever you actually want to (re)initialize.
- **`patches/`**: `pnpm patch` diffs against specific installed package
  versions, applied automatically via `pnpm-workspace.yaml`'s
  `patchedDependencies` on every `pnpm install` — real upstream bugs
  fixed without forking, not local customization.
- **`github-app-token.mjs` / `github-app-git-credential-helper.mjs` /
  `gh-wrapper.sh`**: dsh's git/gh identity is a GitHub App installation
  (not Chris's personal account) - scoped access, auto-rotating ~1h
  tokens, commits/PRs attributable to the App rather than Chris
  personally. `dsh-gh-token-refresh.service`/`.timer`
  (`local-ai-machine`'s `configuration.nix`) keeps the token fresh;
  `gh-wrapper.sh` self-heals if that timer ever misses a beat.
- **`.dsh/profiles/web/plugins/`**: local, plain-file plugins (not npm
  packages) - `continue-kicker.mjs` (auto-continue on interrupted/
  max-tokens turns), `image-search-searxng.mjs`, `model-switch.mjs`,
  `semantic-loop-kicker.mjs`.

## Running it

The box's NixOS config declares a `dsh` systemd service (`User = "dsh"`,
the same account that's long handled this repo's self-redeploy trigger)
that runs `dsh web --host 127.0.0.1 --port 3081`. Two ways to reach it:

- **`https://dsh.local-ai-machine.johnsonlab.dev`** — Caddy reverse-proxies
  to `127.0.0.1:3081` with a Host/Origin header rewrite (both forced to
  `localhost:3081`), since dsh's own loopback fence
  (`dsh-client-connection`'s `isTrustedApiRequest`) hard-pins its
  privileged settings/credentials plane to a literal `localhost`/
  `127.0.0.1` Host header - no proxy topology satisfies that without the
  rewrite.
- **An SSH tunnel straight to the loopback bind** (`ssh -L
  3081:127.0.0.1:3081 local-ai-machine`) - the same access pattern every
  other unauthenticated local service on this box uses, useful when you
  want to bypass Caddy entirely (e.g. debugging the proxy itself).
