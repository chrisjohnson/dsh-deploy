# KAN-16 — Start planning: released and pinned; the production deploy + restart is what remains

**Status: released and pinned on `main`. NOT yet deployed to production.**
PR #67 merged, `dsh-kanban-v0.13.0` is tagged, and this repo's pin moved to it.
**The only thing left is section 2: pulling and installing in the live checkout
and restarting the service — a human step in a planned window.**

| thing | where | state |
| --- | --- | --- |
| dsh-kanban change | [PR #67](https://github.com/chrisjohnson/dsh-plugins/pull/67), commit `11c1d29`, merge commit `05b370e` | **merged into `main`** |
| release tag | `dsh-kanban-v0.13.0` → `05b370e23a11146e6650cdeeb48017fab5f3445a` | **pushed** (`gh api .../refs/tags/dsh-kanban-v0.13.0` confirms) |
| this repo's pin | `package.json` + `.dsh/profiles/web/package.json` | **both read `dsh-kanban-v0.13.0`**, root `pnpm-lock.yaml` resolved to `05b370e` |
| install proof | the KAN-16 worktree, both trees installed | root and `.dsh/profiles/web` both report **0.13.0**; every pre-restart assertion below passed here |
| production | `/home/dsh/dsh-deploy`, service `dsh` | **untouched** — still 0.12.1 on disk and in memory. Sections 1 and 2 have not been run there. |


## What the change is

A Backlog ticket that plans *when picked up* can now be planned from the board
without dragging it into Working. A small **Start planning** button sits on the
card, and the same one next to the pencil in the ticket detail hero: it sets
that ticket's `planTiming` to `now` and nudges the engine, which runs the plan
session right there in Backlog. When the plan lands the ticket is still in
Backlog, now at **Build**, waiting to be dragged over.

- **No engine change, no schema change, no new config key.** `tick` already
  launched Backlog plan-now tickets and `advance` already stopped them at Build;
  both have since 0.5.0. The button is a one-field write onto an existing path.
- On a **parked** plan ticket the button doubles as the **retry**: it lifts the
  park and launches a fresh plan. The guard is "a turn is in flight" plus "a plan
  session is open on a ticket nobody has parked" — not a bare live-session check,
  which would have refused the retry.
- New `startPlanning` action on the existing `action` endpoint; refuses anything
  that is not `backlog`/`plan` with `bad_request`.
- The decision lives in `packages/kanban/src/planning.mjs` (new) because
  `host.mjs` is wiring that cannot be imported without the dsh peer packages —
  inline there, no test could reach it.

Full rationale in the package's `DECISIONS.md` (0.13.0 section) and `README.md`.

## Verification already done

Repo checks on the branch (`npm run check` = verify + hook gate + all suites):

```text
verify:            0 error(s), 0 warning(s) across 11 package(s)
check-plugin-hooks: checked 1 client file(s): 0 violation(s), 0 warning(s)
tests:             751 tests, 681 pass, 0 fail, 70 skipped
                   (kanban alone: 246 tests, 206 pass, 0 fail, 40 skipped)
npm pack --dry-run: src/planning.mjs present in the tarball
```

The 70 skips are the peer-package-gated suites, identical on `main`. All five CI
checks on PR #67 (compose, contract, tests on node 20.9.0 / 22 / 24) passed
before the merge, and the reviewer independently mutation-tested the new
assertions — deleting the column/phase guard, making the `planTiming` write a
no-op, dropping the client rule's `planTiming` condition, and forcing the card
button off each produced a test failure, so the suite genuinely constrains this
behaviour.

Lab: `scripts/lab.sh up --name kan16 --port 3099`, `dsh-kanban` **linked** to
`/home/dsh/dsh-lab/plugins/dsh-plugins-kan16/packages/kanban`, so the board ran
0.13.0 code against a real engine with real model routes. Evidence kept in
`/home/dsh/dsh-lab/kan16-evidence/` (probe script, screenshots, smoke
`RESULTS.md`); the lab is now unlinked and stopped.

```text
smoke --only ui,kanban-recovery   14 PASS, 0 FAIL, 0 SKIP
  incl. "no `slot entry crashed` or React errors in the console"
  and the full kanban-recovery scenario (kick, park, degraded) unaffected

browser end-to-end (kan16-e2e.mjs) 8 PASS, 0 FAIL
  card offers Start planning on a Backlog at_pickup plan ticket   PASS
  no button on an already-plan-now ticket                         PASS
  click starts planning WITHOUT opening the detail                PASS
  detail hero offers the same button next to the pencil           PASS
  second click while the plan session runs -> bad_request         PASS
  plan lands: backlog/implement, plan stored, button gone         PASS
  moved to Working -> build session runs                          PASS
  console clean                                                   PASS
```

Two caveats, stated plainly:

- The last row moved the ticket through the `move` endpoint, not a real drag:
  HTML5 `draggable` does not respond to synthetic mouse events reliably in
  headless Chromium. The card's drop handler posts that same endpoint, and
  `engine.test.mjs`'s *a plan-now ticket plans in Backlog and stops at Build
  until dragged to Working* covers the drag semantics.
- The parked-retry path is covered by a unit test (parked ticket with a live plan
  session), not by the lab run — parking a real plan on demand would have meant
  a deliberately failing planner route.

## 1. Already done — release and pin (2026-11-02, KAN-16 session)

### 1a. Merged and tagged

[PR #67](https://github.com/chrisjohnson/dsh-plugins/pull/67) merged into
`dsh-plugins` `main` as merge commit `05b370e23a11146e6650cdeeb48017fab5f3445a`,
and the lightweight tag was cut on that merge commit per `docs/releasing.md`:

```text
refs/tags/dsh-kanban-v0.13.0 -> 05b370e23a11146e6650cdeeb48017fab5f3445a
```

### 1b. Pin bumped in both manifests, lockfile resolved

`package.json` and `.dsh/profiles/web/package.json` both moved
`dsh-kanban-v0.12.1` → **`dsh-kanban-v0.13.0`** (a two-line, value-only diff),
and `pnpm install --lockfile-only` rewrote the root `pnpm-lock.yaml`, which now
resolves the tag to the merge commit:

```text
dsh-kanban@https://codeload.github.com/chrisjohnson/dsh-plugins/tar.gz/05b370e23a11146e6650cdeeb48017fab5f3445a#path:/packages/kanban
```

### 1c. Both trees installed and asserted — in the KAN-16 worktree, not production

To prove the pin actually installs and that the assertions below are correct,
**both** trees were installed in this worktree (`.dsh-worktrees/ready-lupine`).
A root-only install is the trap `AGENTS.md` records — it updates the host side
and silently leaves the browser half on the old tag — so both were done:

```text
root version:    "version":"0.13.0"
profile version: "version":"0.13.0"
client startPlanning: 6   client kb-planbtn: 3   host startPlanning: 3
planning.mjs present: yes
pnpm run check: check-no-links: ok (4 files checked)
```

**This is not the production deploy.** `/home/dsh/dsh-deploy` was not pulled, not
installed into, and not restarted; it is still on 0.12.1 both on disk and in
memory. Section 2 is what actually moves production.

### 1d. Committed and pushed to `main`

The pin, the lockfile and this handoff are committed and pushed to `main` in this
repo (direct pushes are authorized here by `AGENTS.md`).

## 2. Production deploy — Chris, planned window only

Run this in the live checkout. **Both trees must be installed** or the browser
keeps the old plugin while the host looks updated:

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin main  # the pin commit from 1d
grep -n 'dsh-kanban' package.json .dsh/profiles/web/package.json   # both must read v0.13.0

pnpm install                                   # root tree
cd .dsh/profiles/web && pnpm install && cd /home/dsh/dsh-deploy
pnpm run check                                 # check-no-links: ok

# PRE-RESTART ASSERTIONS — do not restart until all of these hold:
grep -m1 '"version"' node_modules/dsh-kanban/package.json                      # 0.13.0
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json    # 0.13.0
grep -c 'startPlanning'  .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 6 (rule, card, hero, Column plumbing, handler, act call)
grep -c 'kb-planbtn'     .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 3 (two css rules + the class use)
grep -c 'startPlanning'  .dsh/profiles/web/node_modules/dsh-kanban/src/host.mjs     # 3 (import, action branch, the call)
test -f .dsh/profiles/web/node_modules/dsh-kanban/src/planning.mjs && echo planning.mjs present
```

All six of those assertions are the ones that passed in 1c, so their expected
values are verified, not guessed. If the version greps do not read 0.13.0, the
profile tree is still the old tarball: re-run `pnpm install` inside
`.dsh/profiles/web` before touching the service.

## 3. Production restart — Chris, planned window only

**A session running on the production service cannot restart it** — a restart
ends every session in it, including the one doing the restart. This step is a
human one, in a planned window. Before restarting, check the board: a blue,
glowing card is a turn running; a static red one is parked and safe.

```sh
sudo systemctl restart dsh
```

## 4. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i kanban | head
# expect: applied: db=… routes=/api/kanban/{board,…,worktree,events,sessionInfo}
```

Then in the GUI (:3081) — **hard-reload the tab first**; the client half is
snapshotted at boot:

- **The button appears.** Open the Kanban panel. Any Backlog card still at
  **Plan** that plans *when started* shows a small blue **Start planning** pill
  under its meta row. A card already at Build, already planning now, mid-turn, or
  waiting on your answer shows none.
- **Click it on a card.** The card turns blue and says *Grilling / planning*; the
  ticket detail does **not** open (the click is stopped before the card's own
  handler). The ticket stays in Backlog.
- **The detail hero has it too.** Open such a ticket: **Start planning** sits next
  to the pencil.
- **When the plan lands** the card is still in Backlog, badge now **Build**, and
  the button is gone. Drag it to Working and the build starts, exactly as before.
- **Console is clean.** No `slot entry crashed in '…'`, no `Minified React error`.
  The client change adds no React hook — the button is a conditional element in
  components that already call their hooks unconditionally at the top — so no slot
  entry's hook order moved.
- **Nothing else changed.** Model routing, Analytics, timeline, approval, the
  `kanban_*` tools and every other board gesture are untouched.

## Rollback

Pin the previous tag, reinstall both trees, restart in a planned window:

```sh
cd /home/dsh/dsh-deploy
git revert <the 0.13.0 pin commit>   # or edit both manifests back to dsh-kanban-v0.12.1
pnpm install
cd .dsh/profiles/web && pnpm install
pnpm run check
# then: sudo systemctl restart dsh   (Chris, planned window)
```

No migration and no new config key, so a rollback is a pin change and a restart
and nothing else. A ticket that was started with **Start planning** keeps
`planTiming: now` after a rollback and will plan as soon as it is dragged to
Working — the old engine still honours that field.
