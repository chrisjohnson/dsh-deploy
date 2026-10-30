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
  "dsh-model-switch": "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-model-switch-v0.2.1&path:/packages/model-switch"
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
- **Runtime rewrites**: DSH rewrites `.dsh/profiles/web/cordis.patch.yml` when settings
  are changed in the UI (picking a model in a session rewrites the
  `agent-default-model` row; `welcomeNoticeVersion`; plugin enable/disable). The edit
  preserves comments above rows, ordering and `!!js` tags, but replaces the `config:`
  node of a written row, so comments INSIDE that `config:` block are lost and its
  formatting may change. Keep long explanatory comments ABOVE the `- id:` line. Expect
  small value-only drift in this tracked file; commit it as the settings-UI change it
  is, as was done with `settings.yaml` before.

### Changing a plugin

The loop, all as the `dsh` user on the box, no sudo (the human path is
`ssh local-ai-machine 'sudo -u dsh -n bash -s' < script.sh`). Run `scripts/lab.sh` from
any checkout of this repo; it never writes to production:

```sh
scripts/lab.sh up                        # private instance on :3099, copy of prod data
scripts/lab.sh link model-switch         # pin it to ~/dsh-lab/plugins/dsh-plugins (cloned if missing)
#   edit ~/dsh-lab/plugins/dsh-plugins/packages/model-switch/..., then:
scripts/lab.sh restart                   # no live reload: restart to pick the edit up
scripts/lab.sh smoke --only model-switch,sessions
scripts/lab.sh smoke                     # everything, before you release
#   PR to dsh-plugins, merge, release tag <pkg>-v<ver> (that repo's docs/releasing.md)
scripts/lab.sh unlink model-switch       # back to the released pin
scripts/lab.sh down
#   dsh-deploy PR: new tag spec in BOTH package.json files, `pnpm install` in the
#   root AND in `.dsh/profiles/web`, then
pnpm run check                           # fails if a link:/file: pin or local path is present
```

**Install the pin in both trees, or the browser keeps the old plugin.**
`.dsh/profiles/web/` is its own pnpm install (own `node_modules` and
`pnpm-lock.yaml`, written by `dsh plugin`, not by the root install), and the
profile-local copy is what the web app serves as a plugin's client half. A
root-only `pnpm install` updates the host side and silently leaves the browser side
on the previous tag: no error, no log line, the panel just behaves like the old
version. So after `git pull`: `pnpm install` at the root, then
`cd .dsh/profiles/web && pnpm install`, and prove it with
`grep -c '<string only the new code has>' .dsh/profiles/web/node_modules/<pkg>/src/client.mjs`.
From a browser tab,
`!!document.getElementById('<the plugin style tag id>')?.textContent.includes('<that string>')`
says whether the loaded page has the new script; a hard reload picks up a
refreshed file, and if it still does not, the client half was snapshotted at boot
and needs the restart. (Hit for real on the `dsh-model-capacity` 0.3.0 pin,
2026-10-30: root copy 0.3.0, profile copy still the 0.2.0 tarball from three days
earlier.)

`scripts/lab.sh link <pkg> <path>` takes any checkout; `status` shows linked vs pinned
packages and the tracked-file drift. Never restart or signal the production `dsh` service
from a session running on it: that ends every session in it, including yours. Prepare the
command and let Chris run it in a planned window.

**A `link:` or `file:` pin is never the committed state.** Rollback is pinning the
previous tag, reinstalling, and restarting in a planned window.

### The lab (`scripts/lab.sh`, `scripts/lab-smoke/`)

A lab is a clone of this repo under `~/dsh-lab/<name>` with its own `node_modules` (shared
pnpm store), its own `DSH_HOME`, a throwaway `HOME`, and its own port (3099). It is started
with the production unit's own node binary, flags (`--expose-internals`) and environment,
read from the running service's `/proc` entries, so it boots the way production does. It
copies a snapshot of production's `sessions`, `attachments`, `storages` and `plugins` state
(read-only on the production side) so checks run against real history.

- `link` pins a package to a local checkout in the lab only. pnpm accepts `link:` in this
  hoisted workspace and `node_modules/<pkg>` becomes a symlink to the checkout, but a
  linked package's `@deepseek-ai/*` peers resolve from its real path, outside
  `node_modules`, and fail to import. While anything is linked the lab therefore starts
  node with `--preserve-symlinks`. `file:` copies the files, needs no flag and goes stale
  on edits, so `link:` is the one to use. A symlink also bypasses the package's `files`
  allowlist, so `link` runs a pack check for files the published tarball would lack.
- `smoke` modules, runnable alone with `--only`: `boot` (isolation, boot log, composed
  profile), `ui` (sidebar, plugin pages, every right-sidebar tool, no `slot entry crashed`),
  `sessions` (reopens copied sessions, restarts the lab, reopens them: the session-format
  gate), `completion`, `web-search`, `image-search`, `webp`, `model-switch` (a real
  `switch_model` call must succeed with no `INVALID_TOOL_OUTPUT`), `scheduled-queue`,
  `loop-watchdog`, `worktree` (on a scratch repo the harness makes), `continue-kicker`
  (kills the lab mid-turn and expects exactly one kick). `--skip-model` skips every check
  that needs a real model turn; those show as SKIP, never PASS. A module whose plugin is
  not mounted is SKIP. Results: `<lab>/.lab/smoke/RESULTS.md`, `results.json`, `shots/`.
- Drift is information: DSH rewrites tracked files such as `cordis.patch.yml` when a
  setting changes in the lab UI, and `status` lists them without treating them as a failure.
- Model checks send real requests to the local models. `smoke` refuses to run them while a
  speed benchmark is running; wait, use `--skip-model`, or pass `--force` knowingly.

Safety rules:

- **Registered working copies are real directories shared with production.** The lab
  starts without the worktree registry, so the worktree plugin only sees copies the lab
  makes. `--with-worktrees` copies the registry and warns loudly; with it, never Remove,
  convert or archive a registered copy from the lab.
- The lab refuses port 3081, a busy port and any directory inside the production checkout;
  `down` signals only the lab's own processes. It never copies `.dsh/keys`, the scheduled
  queue or other schedule state, and drops the GitHub App identity from the environment.
  The loop watchdog runs observe-only.
- `lab.sh prod-check save` before and `compare` after fingerprints the unit start time,
  :3081, the checkout and every registered copy's HEAD, read-only.
- `smoke --only sessions` opens only sessions whose last turn ended cleanly: reopening an
  interrupted one makes continue-kicker run a turn in that session's real workspace.

Lab recipes (all lab-only, never committed):

- `LAB_ROOT` (default `~/dsh-lab`) holds labs as `$LAB_ROOT/<name>`; `--name`/`LAB_NAME` pick one, `--port`/`LAB_PORT` its port.
  The lab clone has its own `cordis.patch.yml`: edit it there (it is a plain tracked-file diff, shown by `status`).
- Pin by hand the way `lab.sh link` does: set `"<pkg>": "link:<abs path>/packages/<dir>"` in the root and
  `.dsh/profiles/web/package.json`, `pnpm install` (not frozen), start node with `--preserve-symlinks`.
  Swap back by restoring both manifests and `pnpm-lock.yaml` from git and `pnpm install --frozen-lockfile`.
- `lab.sh kill` SIGKILLs the lab server mid-turn (crash test); `lab.sh up` brings it back with the same data.
- To force an error halt (for example to exercise continue-kicker's `kickOnError`), point a lab-only provider's `baseURL`
  in the lab's `cordis.patch.yml` at the dead route `http://127.0.0.1:1/v1`; every turn on it then fails at once.
- Plugin loggers are quiet by default; the `logToStderr` setting makes plugin logs reach the lab's stderr log
  (`lab.sh logs`).
- DSH rewrites tracked files in the lab (for example `cordis.patch.yml` when a setting changes); that is information, not a failure.

When a check fails: read the detail line and the `FAIL-*.png` screenshot in
`<lab>/.lab/smoke/shots/`, then `lab.sh logs`. A model-turn failure that quotes a 500 or
"Connection error" means the model backend is down, not the change. Re-run just that
module with `--only` after fixing; `lab.sh reset` rebuilds the lab's data from production.

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
