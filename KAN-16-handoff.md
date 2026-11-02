# KAN-16 — Start planning: verification record, and the release / pin / restart steps still owed

**Status: code complete and lab-verified. NOT released, NOT pinned, NOT deployed.**
The plugin change sits on an open pull request; the release tag does not exist
yet, so this repo's pin is deliberately untouched. Everything in section 1 is a
step for a human, in order.

| thing | where | state |
| --- | --- | --- |
| dsh-kanban change | [`feat/kanban-start-planning`](https://github.com/chrisjohnson/dsh-plugins/tree/feat/kanban-start-planning) @ `11c1d29`, [PR #67](https://github.com/chrisjohnson/dsh-plugins/pull/67) | open, CI + lab green |
| release tag | `dsh-kanban-v0.13.0` | **does not exist yet** |
| this repo's pin | `package.json` + `.dsh/profiles/web/package.json` | still `dsh-kanban-v0.12.1` (branch `dsh/ready-lupine` fast-forwarded onto `main` `fc267e1`, so it is on the current released base, not the stale 0.6.0 one) |
| production | `/home/dsh/dsh-deploy`, service `dsh` | untouched — still 0.12.1, as intended |

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

The 70 skips are the peer-package-gated suites, identical on `main`.

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

## 1. What is left, in order

### 1a. Merge and tag (dsh-plugins)

After reviewing PR #67, per that repo's `docs/releasing.md`: merge it, then cut
the tag on the merge commit and push it.

```sh
git -C ~/dsh-lab/plugins/dsh-plugins-kan16 fetch origin
git -C ~/dsh-lab/plugins/dsh-plugins-kan16 tag dsh-kanban-v0.13.0 origin/main
git -C ~/dsh-lab/plugins/dsh-plugins-kan16 push origin dsh-kanban-v0.13.0
git -C ~/dsh-lab/plugins/dsh-plugins-kan16 describe --tags   # dsh-kanban-v0.13.0
```

### 1b. Pin it here, in both manifests

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin main
for f in package.json .dsh/profiles/web/package.json; do
  node -e '
    const fs = require("fs"); const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.dependencies["dsh-kanban"] = "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-kanban-v0.13.0&path:/packages/kanban";
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  ' "$f"
done
grep -n 'dsh-kanban' package.json .dsh/profiles/web/package.json   # both must read v0.13.0
pnpm install --lockfile-only        # updates the root pnpm-lock.yaml
```

### 1c. Install BOTH trees, then check

A root-only install updates the host side and silently leaves the browser half on
0.12.1 — this repo's `AGENTS.md` calls that out as a real production miss.

```sh
cd /home/dsh/dsh-deploy
pnpm install
cd .dsh/profiles/web && pnpm install && cd /home/dsh/dsh-deploy
pnpm run check                                    # check-no-links: ok

# PRE-RESTART ASSERTIONS — do not restart until all of these hold:
grep -m1 '"version"' node_modules/dsh-kanban/package.json                      # 0.13.0
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json    # 0.13.0
grep -c 'startPlanning'  .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 6 (rule, card, hero, Column plumbing, handler, act call)
grep -c 'kb-planbtn'     .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 3 (two css rules + the class use)
grep -c 'startPlanning'  .dsh/profiles/web/node_modules/dsh-kanban/src/host.mjs     # 3 (import, action branch, the call)
test -f .dsh/profiles/web/node_modules/dsh-kanban/src/planning.mjs && echo planning.mjs present
```

If the version greps do not read 0.13.0, the profile tree is still the old
tarball: re-run `pnpm install` inside `.dsh/profiles/web` before touching the
service.

### 1d. Commit and push this repo

```sh
cd /home/dsh/dsh-deploy
git add package.json .dsh/profiles/web/package.json pnpm-lock.yaml
git commit -m "pin dsh-kanban 0.13.0: Start planning — plan a Backlog ticket without moving it"
git push origin main
```

## 2. Production restart — Chris, planned window only

**A session running on the production service cannot restart it** — a restart
ends every session in it, including the one doing the restart. This step is a
human one, in a planned window. Before restarting, check the board: a blue,
glowing card is a turn running; a static red one is parked and safe.

```sh
sudo systemctl restart dsh
```

## 3. Post-restart verification

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
