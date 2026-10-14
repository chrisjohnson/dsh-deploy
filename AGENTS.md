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

Plugin **source** lives only in `github.com/chrisjohnson/dsh-plugins`
(`packages/<dir>`), never in this repo. That repo is public and CI-tested; this repo is
a **consumer**: it installs a released version of each plugin and owns the deployment's
configuration of it. Releases are lightweight git tags `<pkg>-v<ver>` (for example
`dsh-loop-watchdog-v0.1.0`).

Released plugins in use: `dsh-better-git-worktree`, `dsh-continue-kicker`,
`dsh-image-search-searxng`, `dsh-loop-watchdog`, `dsh-model-switch`,
`dsh-scheduled-queue`. There is no plugin source in this repo.

### Where things live

- **Install**: the exact tag spec, in the dependencies of **both** the root
  `package.json` and `.dsh/profiles/web/package.json` (the Cordis loader resolves a
  plugin row from the installation, so a profile-only install composes but fails to
  import at boot):

  ```
  "dsh-model-switch": "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-model-switch-v0.2.0&path:/packages/model-switch"
  ```

  Also list the package in the profile's `dsh.profile.bundles`; `pnpm add` alone installs
  without enabling. Never install by bare name from npm: an unscoped `dsh-*` name can
  belong to an unrelated author.
- **Deployment values**: rows in `.dsh/profiles/web/cordis.patch.yml`. A package's bundle
  inserts its own row with no config; this repo adds a config-only row by `id`. **A row's
  `config` replaces the plugin's whole config object**, so list every key the row needs;
  anything omitted falls back to the package default. Key names and defaults are in each
  package's README at its tag.
- **Settings model**: every user-facing setting (model providers, default model,
  subagent routes, plugin config) is a row in `cordis.patch.yml`. There is no
  `settings.yaml`.

### Changing a plugin

1. Check out `dsh-plugins` locally and temporarily pin the profile to it with a `link:`
   spec (in the root and profile `package.json`).
2. Edit the local copy.
3. Test it in a lab or upgrade clone of this repo (`dsh --profile web --dump-config`,
   and a private instance on its own `DSH_HOME` and port). **Never restart or signal the
   production `dsh` service from a session running on it**: that ends every session in
   it, including this one. Prepare the command and let Chris run it in a planned window.
4. Open a PR to `dsh-plugins`.
5. Merge, then release: a release PR bumps the version and CHANGELOG, and the tag
   `<pkg>-v<ver>` is cut on the merge commit (see that repo's `docs/releasing.md`). Never
   `unpublish`; deprecate instead.
6. In a dsh-deploy PR, replace the temporary pin with the new tag spec (both
   `package.json` files, plus any row change).

**A `link:` or `file:` pin is never the committed state.** Rollback is pinning the
previous tag, reinstalling, and restarting in a planned window.

### Guardrails for plugin code (full set in the plugins repo's `AGENTS.md`)

- Official `@deepseek-ai/*` packages are peer deps, never direct deps, with peer ranges
  that cover prereleases (`>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`).
- A bundle's `cordis.patch.yml` carries no `config:`; values live in this repo's rows.
- Client halves need the React hook-order treatment (next section).

### Client halves are live browser React

A plugin's `client*.{js,mjs}` mounts as a slot entry into the same React root as core,
with no build, typecheck or test between an edit and a user's browser. The slot renderer
injects standard state as **hook-valued props** (`useInput`, `useProjection`,
`useSessions`, ...). Each call expands to several real hook slots, so the hooks a
component calls must never depend on which props it got. Do not write
`var x = useInput ? useInput(sel) : null`, a `typeof seat !== "function"` guard, a
try/catch around a seat, or an early `return` above a hook. A session-maybe entry adopts
its first session without remounting, so a prop's presence can differ between renders of
one mounted component; React then throws `Minified React error #311` (`#310` when the
list grew) and the region renders as an empty `<div>`, which only a page reload clears.
Instead, call unconditionally over a stable module-scope fallback and branch on the
result:

```js
var NO_SEAT = function () { return null; };
var input = (props.useInput || NO_SEAT)(sel);
if (!input) ...
```

or branch on the element (two components, or one keyed by seat presence). The gate is
`node scripts/check-plugin-hooks.mjs <dir>` in a `dsh-plugins` checkout.

If a GUI region goes blank, the console logs `slot entry crashed in '<slotKey>':` and the
slot renders `<div data-slot-error="<slotKey>">`; `#311`/`#310` mean a hook count changed
in the entry that owns that slot, so look at the plugin before suspecting core.
`dsh-context` and `dsh-better-sidebar` are npm-installed: do not hand-patch
`node_modules`; pin, reproduce and report upstream. Nothing takes effect until the
service restarts, and a restart ends every session running in it.
