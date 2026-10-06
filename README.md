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

## Podman: the container runtime sessions use

dsh sessions get their own **rootless Podman**, so a session can build and run
containers without `docker` group membership, without sudo, and without ever
touching the box's dockerd workloads. Declared in `local-ai-machine`'s
`configuration.nix`:

```nix
virtualisation.podman = {
  enable = true;
  autoPrune.enable = false;
  dockerSocket.enable = false;   # asserts against virtualisation.docker.enable
  dockerCompat = false;          # ditto — no `docker` shim on PATH
};
systemd.sockets.podman.enable = false;   # closes the rootful API socket

users.users.dsh = {
  subUidRanges = [ { startUid = 1048576; count = 65536; } ];
  subGidRanges = [ { startGid = 1048576; count = 65536; } ];
  linger = true;
};
```

Why each piece is there:

- **`dockerSocket`/`dockerCompat` are off on purpose.** Both carry a NixOS
  assertion against `virtualisation.docker.enable`, and this box runs dockerd.
  They'd also graft a `docker`-compatibility shim onto the rootless daemon —
  the confusing outcome rather than the useful one.
- **`systemd.sockets.podman.enable = false`** closes `/run/podman/podman.sock`,
  which the module otherwise leaves listening. That would be a second,
  *privileged* route into containers; it's verified absent post-deploy.
- **The subuid range is hand-picked, not allocated.** `update-users-groups.pl`
  only ever hands out `100000 + n*65536` and doesn't record declared ranges in
  `%subUidsUsed`, so a range chosen inside that lattice gets reassigned to the
  next user created. 1048576 sits deliberately off-lattice.
- **`linger = true`** keeps the user manager — and so `podman.socket` — alive
  with nobody logged in, which is what makes the socket reachable from the
  systemd-started `dsh` service.

**Runtime shape.** `podman.socket` is a systemd *user* unit. The first command
after a lull socket-activates `podman.service`, which then exits again after
roughly five seconds idle. Two visible, harmless consequences: the first call
after an idle period is slower, and the journal logs
`Found left-over process … (passt.avx2) … while starting unit` whenever a
running container outlived the previous service instance. Neither needs fixing.

State lives under the user: graphroot `/home/dsh/.local/share/containers/storage`,
runroot `/run/user/1002/containers`, overlay + crun, `Rootless=true`. Containers
run as uid 0 inside a user namespace mapped to the range above, and since the
cgroup driver is systemd each shows up as `libpod-<id>.scope` under
`systemctl --user` — so `journalctl --user -M dsh@` and `systemd-cgtop` see them.

**Two entry points, one store.**

| | |
|---|---|
| API socket: `export CONTAINER_HOST=unix:///run/user/1002/podman/podman.sock` (or `-H`) | works unconditionally, including from another account via `sudo`; the standard |
| Local CLI (no `-H`) | same store, same systemd scopes, but fails when a session runs under `NoNewPrivs` — which is exactly why the socket exists |

Another account pointing `CONTAINER_HOST` at the socket needs traversal of
`/run/user/1002` (mode `0700`, no ACL) plus access to the `0660 dsh:dsh` socket,
so in practice it's `sudo podman …` unless those are deliberately opened up.

**Deliberately absent: supervision.** There is no watchdog, so `--restart=…` is
inert, containers don't auto-start at boot, and nothing keeps an experiment up. That's the intended shape — this box is where projects
get built and exercised, and released builds deploy elsewhere — but it means
`sessions start and stop containers` rather than `containers are always there`.

**Deliberately absent: exposure.** Containers publish on loopback
(`-p 127.0.0.1:<port>:<port>`) because dev builds have no auth. Making one
reachable means a Caddy route in `local-ai-machine` plus
`docker compose up -d --force-recreate caddy` — a human step by design. See that
repo's `knowledge/decisions/2026-10-06-bind-mount-stale-inode.md` for why it has
to be *recreate* and not restart.

Reference instance: `trailpilot` (`-p 127.0.0.1:8137:8137`, named volumes
`tp-data`/`tp-cache`), served as
`https://trail-pilot.local-ai-machine.johnsonlab.dev`.
