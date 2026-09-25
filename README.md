# dsh-deploy

Native (no Docker) install of [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)
("dsh", DeepSeek Harness) for `local-ai-machine`, run as a NixOS systemd
service instead of a container.

**Status: M-153, minimal bootstrap.** This branch (`native-no-docker`)
deliberately strips the repo down to the smallest thing that proves the new
architecture — just `@deepseek-ai/dsh` itself, a base provider/model config,
and one working test session. The previous Docker-based `main` still runs
untouched, side by side, for comparison. Everything this repo used to carry
(patches, custom plugins, the GitHub App credential system, Playwright,
bundle-plugin dependencies) is catalogued for a follow-up port/drop review
before any of it comes back — see the M-153 fleet card on `local-ai-machine`
for that inventory and the staging plan.

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
  `~/.dsh`, runs `pnpm install`). **Not** wired into the systemd service —
  run it by hand over SSH whenever you actually want to (re)initialize.

## Running it

The box's NixOS config declares a `dsh` systemd service (`User = "dsh"`,
the same account that's long handled this repo's self-redeploy trigger)
that runs `dsh web --host 127.0.0.1 --port 3081` — a different port from
the existing Docker container's `3080`, so both can run side by side.
Reached the same way every other unauthenticated local service on this box
is: an SSH tunnel to the loopback bind, never a reverse proxy (dsh's
frontend needs a secure browser context and pins its own config to a
literal `localhost`/`127.0.0.1` Host header — no proxy topology satisfies
both at once).
