# KAN-12 — per-role reasoning effort in the Model routing dialog: deploy + restart handoff

Shipped in `dsh-plugins` (PR merged, lightweight tag cut on the merge commit):

| package | tag | merge commit | what it changes |
| --- | --- | --- | --- |
| dsh-kanban | `dsh-kanban-v0.8.0` | `aa4f636` ([PR #56](https://github.com/chrisjohnson/dsh-plugins/pull/56)) | **The Model routing dialog can now set a reasoning effort per role**, and `setRoutes` can persist it. Each role row gets a second dropdown: **Default** plus the levels the selected model actually offers, read from the host model catalog. |

Pinned in this worktree (branch `dsh/gentle-sparrow`): both `package.json` and
`.dsh/profiles/web/package.json` move from `dsh-kanban-v0.7.0` to
`dsh-kanban-v0.8.0`, root `pnpm-lock.yaml` updated (it resolves the tag to
`aa4f636`), and **both installed trees verified at 0.8.0** — root
`node_modules/dsh-kanban` and the profile tree dsh actually serves the browser
half from. The branch was first fast-forwarded onto `main` (`0a3d2e9`, the KAN-11
0.7.0 pin) so this pin builds on the current released state rather than the
0.5.1 state the worktree was cut from.

> **The plan named this release 0.7.0.** It could not be: `dsh-kanban-v0.7.0` was
> cut for KAN-11 ([PR #55](https://github.com/chrisjohnson/dsh-plugins/pull/55))
> while this ticket was being planned, and `main` already pins it. A released tag
> is permanent, so this is the next minor — **0.8.0** — and every `0.7.0` in the
> plan's release and pin steps should be read as `0.8.0`. The deployment pin here
> is therefore 0.7.0 → 0.8.0, not 0.6.0 → 0.7.0.

## What changes on the board

- **The routing dialog gains a second dropdown per role.** Open Kanban →
  **Model routing** → the pencil. Each row is now *label | model picker | effort
  picker*. The effort options come from the live catalog of the model that row
  has selected, so on this box: `big-moe` offers Default / Low / Medium / Xhigh,
  `medium-dense` offers Default / Off / Low / Medium / Xhigh, and `medium-moe`
  (`reasoningEfforts: false` in `cordis.patch.yml`) shows **no effort control at
  all**.
- **Default means "ask the model"** and is stored as `reasoningEffort: null`.
  Picking Default clears a level saved earlier instead of leaving it behind —
  that was the bug in the old write path, which merged into the existing role
  entry and never wrote the key, so a level picked once stayed in force after the
  model was changed under it.
- **Switching a role to a model that does not offer the picked level resets that
  row to Default** in the draft, so a save cannot fail on a stale choice.
- **A save validates every non-null level against the live catalog** and answers
  `bad_request` naming the role, the model and the levels it offers. A level that
  cannot be checked because the provider is unreachable is rejected rather than
  guessed at (`unavailable`).
- **Nothing about dispatch changes.** `roles.<role>.reasoningEffort` has been
  threaded end to end since 0.1 (`config.mjs` validation, `engine.resolveRoute`,
  `dispatch.mjs` into `agentOptions` / `selectForNextRequest`); only the edit
  path was missing. The read-only view already showed the level and is unchanged.
- **No `cordis.patch.yml` change is needed.** The existing `kanban` row keeps
  working as it is. Note that the *first dialog save* writes
  `reasoningEffort: null` explicitly into all four role rows (the dialog always
  sends all four roles), so expect that churn in the tracked file; it decides
  nothing that an absent key did not.
- **Rollback** is pinning `dsh-kanban-v0.7.0` in both manifests, reinstalling both
  trees, and restarting in a planned window. No database migration ships with
  0.8.0 (schema stays at 4) and no config key was renamed, so a rollback needs no
  data step; the only loss is the effort dropdown itself, while any
  `reasoningEffort` already written into the row keeps being honoured by 0.7.0's
  runtime.

## 1. Update the live checkout (needs write access to `/home/dsh/dsh-deploy`)

**Both trees must be installed** — a root-only install updates the host side and
silently leaves the browser half on 0.7.0 (this repo's `AGENTS.md`; hit for real
on the model-capacity 0.3.0 pin):

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin dsh/gentle-sparrow   # -> the pin commit (or merge it to main first)
grep -n 'dsh-kanban' package.json .dsh/profiles/web/package.json
# both lines must read dsh-kanban-v0.8.0

pnpm install                                  # root tree
cd .dsh/profiles/web && pnpm install && cd -  # the tree dsh actually loads from
pnpm run check                                # check-no-links: ok

# PRE-RESTART ASSERTIONS - do not restart until all four hold:
grep -m1 '"version"' node_modules/dsh-kanban/package.json                    # 0.8.0
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json  # 0.8.0
ls .dsh/profiles/web/node_modules/dsh-kanban/src/routing.mjs                 # the new module ships
grep -c 'kb-route-effort-picker' .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs  # 3
```

## 2. Production restart — Chris, planned window only

A restart ends every session running in the service, including any agent session
on this box. Do not run it from a session, and pick a window with no kanban
workflow turn in flight.

```sh
sudo systemctl restart dsh
```

## 3. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i kanban | head
# expect the plugin's own line: applied: db=… routes=/api/kanban/{board,…,setRoutes,…}
```

Then in the GUI (:3081, Kanban panel → **Model routing** → pencil):

- The four rows each show an effort dropdown beside the model picker, with the
  levels of the model that row has: `implementer`/`reviewer`/`planner` on
  `medium-dense` → Default, Off, Low, Medium, Xhigh; `approver` on `big-moe` →
  Default, Low, Medium, Xhigh.
- Pick a level on one role, **Save routing**, then confirm
  `roles.<role>.reasoningEffort: <level>` appears in
  `.dsh/profiles/web/cordis.patch.yml`, that the read-only view shows the level
  (not *default effort*), and that reopening Edit has it selected.
- Set that row back to **Default**, save, and confirm the row reads
  `reasoningEffort: null`.
- Switch a row's model to `medium-moe` and confirm its effort dropdown disappears
  (no reasoning metadata); switch it back and Cancel.
- A turn on a role with a level set should still dispatch: the routed model
  receives `reasoningEffort` in its `agentOptions`, exactly as before.

## Lab evidence (before release)

Lab `kan12` (`:3099`, cloned from `main` at `0a3d2e9`, full copy of production
session data), `dsh-kanban` **linked** to
`~/dsh-lab/plugins/dsh-plugins-kan12/packages/kanban`, then unlinked and the lab
stopped.

- `lab.sh up` / `restart`: boot log clean, no admission rejects, `--dump-config`
  exit 0 with 56 layer annotations. `pack-check`: 30 files in the tarball, every
  referenced file and relative import included (`src/routing.mjs` ships).
- `smoke --only ui`: **6 PASS, 0 FAIL, 0 SKIP** — no `slot entry crashed`, no
  React console errors, every right-sidebar tool opens, the Kanban page renders
  with the new client half.
- `smoke --only kanban-recovery`: **8 PASS, 0 FAIL, 0 SKIP** — the engine
  dispatched real role turns on the routed lab model, kicked 3 times, parked
  `turn failed in implement: max-tokens`, and the degraded (no continue-kicker)
  path parked directly.
- Browser click-through (headless chromium, the production binary, driving the
  real :3099 GUI):
  - edit rows: `medium-dense` → `Default/Off/Low/Medium/Xhigh`, `big-moe` →
    `Default/Low/Medium/Xhigh`, labels from the catalog;
  - switching the planner row to `medium-moe` → `(no control)`;
  - saving `low` on planner wrote `reasoningEffort: low` into the lab's
    `cordis.patch.yml`; read-only then showed `low` and the reopened draft was
    seeded with `low`;
  - choosing Default rewrote it to `reasoningEffort: null` and the read-only view
    went back to *default effort*;
  - console problems: none.
- Stale-effort boot probe: hand-setting `roles.planner.reasoningEffort: ultra`
  (not offered by `medium-dense`) and restarting the lab left the boot **clean** —
  the warning is non-fatal as designed, and the profile still composes. The
  warning *text* is not observable in `lab.sh logs`: unlike continue-kicker,
  dsh-kanban has no `logToStderr` setting, so `ctx.logger` output does not reach
  the lab's stderr log. The warning path is covered by unit tests instead
  (`a stale saved effort warns without taking the profile down`).
- `npm run check` in dsh-plugins on a bare clone: verify gate clean, hooks gate
  **0 violations / 0 warnings**, `node --test` **630 tests, 0 failures** (54
  skipped: the live/browser tiers that need a configured host).
- CI on PR #56: `contract` pass, `tests` pass on Node 20.9 / 22 / 24, `compose`
  pass. (`node scripts/compose-smoke.mjs kanban` locally needs the checkout's
  `@deepseek-ai/*` peers installed, which a fresh clone of this repo does not
  have; CI's `compose` job is the authoritative run of that tier.)

## Decisions needed

1. **Merge the dsh-deploy pin (`dsh/gentle-sparrow`) to `main` now, or hold it for
   the restart window?** Recommend: **hold**, same call as KAN-11's decision #1.
   The pin only takes effect after `pnpm install` in both trees plus a restart, so
   merging early buys nothing, and keeping it on a branch means an unplanned
   `git pull` on the box cannot half-activate 0.8.0 between now and the window.
   Merge it as part of section 1, in the same window as the restart.
2. **Should the deployment set an effort at all, or leave every role on Default?**
   Nothing in this change requires a config edit: the current row has no
   `reasoningEffort` keys and behaves exactly as it does today. If you want, say,
   the reviewer on `medium-dense` at `off` (fast, no thinking) and the approver on
   `big-moe` at `xhigh`, set them from the dialog after the restart — the row is
   rewritten by the plugin, so commit the resulting `cordis.patch.yml` drift as
   the settings change it is.
