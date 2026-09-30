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

## Plugins live in `chrisjohnson/dsh-plugins`, not in this repo

New plugin **source** goes to `git@github.com/chrisjohnson/dsh-plugins.git`
(`packages/<name>`), never to `.dsh/profiles/web/plugins/`. That repo is public,
CI-tested, and publishes to npm; this repo is a **consumer** that installs published
versions and owns the deployment's configuration of them. A working checkout lives at
`.plugin-dev/dsh-plugins` (gitignored) — it is a second workspace root, which is what
makes creator-mode work possible (see below).

`.dsh/profiles/web/plugins/` still holds the plugins that have not been extracted yet.
Its `AGENTS.md` still governs those files. Do not add new ones there.

### When a plugin moves to the plugins repo

Move it when it is *done knowing about this machine*: no absolute paths, no provider or
model ids baked in, no reading another plugin's state files, no generated client pinned
to a core version by string matching. Each of those becomes a config key with a
documented unset behaviour — not a default that happens to work here. If it still knows
something, either parameterise it now or leave it in-tree; a published plugin that
silently does nothing off-author is worse than an absent one.

### Guardrails (the full set lives in the plugins repo's AGENTS.md)

- Official `@deepseek-ai/*` packages are **peer** deps, never direct deps, and peer
  ranges need the prerelease branch (`>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-0`) or prerelease
  harness builds ERESOLVE. Never declare bare `cordis`.
- Bundle `cordis.patch.yml` carries **no `config:`** — a patch layer replaces a row's
  whole config object instead of merging, so every key in the bundle is a key the user
  must restate. Values live in this repo's profile patch.
- `dsh.client` requires an `./client` export. Client halves get the React hook-order
  treatment (conditional hook call ⇒ blank GUI region, `Minified React error #311`).
- No `entry-rN.mjs` cache-busting shims in a published package.
- Decisions worth testing go in a module that imports nothing from dsh.

### Testing a change, then shipping it

1. **Creator mode, in the plugins checkout** (`.plugin-dev/dsh-plugins`): `npm run check`
   — verify contract + hook gate + unit tests, no install, no dsh needed.
2. **Composition smoke**: `DSH_DEPLOY_DIR=/home/dsh/dsh-deploy node
   scripts/compose-smoke.mjs` — real `dsh plugin add` into a throwaway profile under
   `.lab/`, real import, asserts the layer lands. Never touches `.dsh/profiles/web`.
3. **Runtime**: `node scripts/lab.mjs up --settings …` boots a private dsh on port 3099
   with its own `DSH_HOME`. **Never restart or signal the production `dsh` systemd
   service from a session running on it** — that ends every session in it, including
   this one. Prepare the command and let Chris run it in a planned window.
4. **Release** from the plugins repo: changelog + version bump + tag
   `<package>-v<version>`; CI green first. See its `docs/releasing.md`. Never
   `unpublish`; `deprecate` instead.
5. **Promote here**, in a separate commit from any config change.

### Consuming a published version from this repo

```sh
pnpm add dsh-model-switch@0.1.0            # exact version, in the ROOT package.json
node_modules/.bin/dsh plugin --profile web add dsh-model-switch@0.1.0
DSH_HOME="$PWD/.dsh" HOME=/tmp/x node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config
```

Rules, all of them learned the hard way:

- **Pin exact versions.** The profile has **no lockfile and no `pnpm-workspace.yaml`**,
  so a caret floats silently and a "known good" profile becomes unreproducible. Same for
  the existing profile deps: when you next touch them, pin them.
- Root `package.json` **and** the profile both get the dep: the Cordis loader resolves a
  plugin row from the *installation*, so a profile-only install composes but fails to
  import at boot.
- **Never commit a `link:` or `file:` spec into the profile.** Live-editing a plugin from
  this deployment is a creator-mode activity that ends before the commit; the profile
  gets registry versions only.
- Rollback = pin the previous exact version, reinstall, restart in a planned window. A
  version you published cannot be unwritten, only deprecated — which is why step 3 is
  runtime-verified before step 4.
- Config for a published plugin belongs in this repo (profile patch row or deployment
  patch), never in the plugin's bundle patch.
