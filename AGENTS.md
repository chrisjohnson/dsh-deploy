# AGENTS.md — dsh-deploy

## What this repo is

**M-153, minimal bootstrap on `native-no-docker`.** This branch replaces
the previous Docker/GHCR-image deploy entirely: dsh runs as a native NixOS
systemd service (`User = "dsh"`), and this repo *is* the checkout that
service runs from — `.dsh/` (dsh's own `DSH_HOME`) lives inside it, so
config state is plain git-tracked instead of seed-copied into a container
bind mount. See `README.md` for the current layout. The GitHub App
credential system, all patches, and every bundle-plugin dependency the old
`main` carried are deliberately not present yet — cataloged for a
follow-up port/drop review (see the M-153 fleet card on `local-ai-machine`),
not lost.

## Deploy mechanism

No CI image build on this branch (`.github/workflows/build.yml` still
targets the old Docker path on `main`). Deploying a change here means:
`git pull` (or `init.sh`'s clone) into `/home/dsh/dsh-deploy` on the box,
run `init.sh` by hand if `package.json`/`pnpm-workspace.yaml` changed, then
restart the `dsh` systemd service — see `README.md`'s "Running it".

## Git workflow

**Direct pushes to `main` are explicitly authorized in this repo** — no
PR workflow, no worktree-branch requirement, same as `local-ai-machine`
itself. CI builds and publishes an image on every push to any branch, not
just `main`.

## Upgrading the dsh version

Dependency install here uses **pnpm, not npm** (`Dockerfile`'s install
step). This isn't a style preference — plain `npm install`/`npm ci`
against `@deepseek-ai/dsh`'s real dependency graph hits genuine, upstream-
confirmed cyclic peer dependencies (e.g. `@deepseek-ai/cordis` ↔
`cordis-plugin-loader` ↔ `cordis-plugin-include`), which sends npm's
Arborist resolver into exponential backtracking — a real, reproducible
25+ minute hang or OOM, not a local misconfiguration (multiple community
bug reports on the upstream repo's Discussions tab confirm this
independently). pnpm's resolver doesn't hit the same pathological case;
the identical tree resolves in ~10-20s.

pnpm alone isn't sufficient either: some of dsh's own internal packages
declare a peer/dependency range on a sibling package that omits the
`-rc.x`/`-alpha.x` prerelease tag (e.g. `^0.1.1` instead of
`^0.1.1-rc.2`). Since every real published version in that line **is** a
prerelease, that bare range is unsatisfiable under strict semver — pnpm
fails loudly (`ERR_PNPM_NO_MATCHING_VERSION`) rather than searching
forever like npm does. `pnpm-workspace.yaml`'s `overrides` block pins
every `@deepseek-ai/dsh-*` package to the exact target version directly,
sidestepping each consumer's (sometimes-wrong) declared range rather than
trying to find and fix each bad range individually — there were 186 of
these packages in the graph at the time this was written, no realistic
way to audit each range by hand.

**To bump the `@deepseek-ai/dsh` version:**
1. Edit `package.json`'s `@deepseek-ai/dsh` dependency to the new version.
2. `node scripts/update-dsh-overrides.mjs <new-version>` — walks the full
   dependency graph via the registry and rewrites `pnpm-workspace.yaml`'s
   `overrides` block to match (takes a minute or two, one `npm view` call
   per package in the graph).
3. `pnpm install --lockfile-only` — should resolve in seconds. If it
   doesn't (a new, different unsatisfiable range not fixed by the
   dsh-wide override — e.g. a bad range on a *non*-dsh-prefixed package),
   the error names the exact package and range; investigate that one
   specifically rather than re-guessing install flags.
4. `pnpm approve-builds --all` — re-approves native postinstall scripts
   (`node-pty`, `koffi`, etc.) if the package set changed; writes to
   `pnpm-workspace.yaml`'s `allowBuilds`. Skipping this silently leaves
   those modules unbuilt rather than failing loudly.
5. Test the built image locally before pushing — see the Dockerfile's
   comment above the install step for the `nodeLinker: hoisted` reasoning
   (required for `dsh-web-search-searxng`'s peer deps to resolve); a real
   `docker build` + `docker run` smoke test (mount throwaway `/dsh-home`
   and `/dsh-home-seed` dirs, set `LOCAL_AI_MACHINE_API_KEY` to any
   value, check `dsh --version` and that `dsh web` stays up) catches
   anything the lockfile alone wouldn't.

Do not fall back to `npm ci --legacy-peer-deps` as a shortcut: it looks
like it resolves fine, but silently skips auto-installing genuinely-
needed peer dependencies. That caused a real production crash-loop
(`ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis-plugin-group`) the first time
this upgrade was attempted.

## If the standard deploy path itself is broken, or is repeatedly getting in the way

Sidestepping it is a legitimate thing to do — but flag it and confirm with
Chris first rather than silently improvising a different deploy
mechanism, same as `local-ai-machine`'s own rule.
