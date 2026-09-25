# AGENTS.md — dsh-deploy

## What this repo is

**M-153/M-154: native NixOS systemd service, promoted to `main`.** dsh
runs directly on `local-ai-machine` (`User = "dsh"`, no Docker), and this
repo *is* the checkout that service runs from — `.dsh/` (dsh's own
`DSH_HOME`) lives inside it, so config state is plain git-tracked instead
of seed-copied into a container bind mount. See `README.md` for the
current layout. The previous Docker/GHCR-image deploy is gone entirely
(Dockerfile, docker-compose.yml, docker-entrypoint.sh, the CI image-build
workflow) - see the M-153/M-154 fleet cards on `local-ai-machine` for the
full port/drop history of what carried over from that setup and what was
deliberately dropped (`dsh-claude-cli`, `@goodandready/dsh-image-gen`).

## Deploy mechanism

No CI at all currently - there's no image to build. Deploying a change
here means: `git pull` (or `init.sh`'s clone) into `/home/dsh/dsh-deploy`
on the box, run `init.sh` by hand if `package.json`/`pnpm-workspace.yaml`
changed, then restart the `dsh` systemd service - see `README.md`'s
"Running it".

## Git workflow

**Direct pushes to `main` are explicitly authorized in this repo** — no
PR workflow, no worktree-branch requirement, same as `local-ai-machine`
itself.

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
5. Test locally before pushing: `pnpm install`, then boot the real
   profile against a throwaway `HOME` (`DSH_HOME="$(pwd)/.dsh" HOME=/tmp/x
   node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web
   --dump-config` to check composition, then the same without
   `--dump-config` plus a real port to confirm it actually serves) - catches
   anything the lockfile alone wouldn't, no Docker build needed.
   `nodeLinker: hoisted` (`pnpm-workspace.yaml`) is required for
   `dsh-web-search-searxng`'s peer deps to resolve - don't remove it.

Do not fall back to `npm ci --legacy-peer-deps` as a shortcut: it looks
like it resolves fine, but silently skips auto-installing genuinely-
needed peer dependencies. That caused a real production crash-loop
(`ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis-plugin-group`) the first time
this upgrade was attempted.

## If the standard deploy path itself is broken, or is repeatedly getting in the way

Sidestepping it is a legitimate thing to do — but flag it and confirm with
Chris first rather than silently improvising a different deploy
mechanism, same as `local-ai-machine`'s own rule.
