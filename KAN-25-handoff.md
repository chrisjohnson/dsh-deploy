# KAN-25 — clicking the sidebar Kanban row lands on the board: deploy + restart handoff

Shipped in `dsh-plugins`:

| package | tag | merge commit | what it changes |
| --- | --- | --- | --- |
| dsh-kanban | **`dsh-kanban-v0.12.1`** | `2ab93ed` ([PR #66](https://github.com/chrisjohnson/dsh-plugins/pull/66)) | Re-clicking the sidebar **Kanban** row while the kanban panel is already the active panel resets the page to the **Board** — closing an open ticket detail or the Analytics view. Client half only: no schema change, no new config key, no host-side behavior change. **This is the version to deploy.** |

Pinned in this repo (branch `dsh/witty-quarry`, fast-forwarded to `main` as
`6cdd164`): both `package.json` and `.dsh/profiles/web/package.json` move from
`dsh-kanban-v0.12.0` to **`dsh-kanban-v0.12.1`**, root `pnpm-lock.yaml` updated
(it resolves the tag to `2ab93ed`), and **both installed trees verified at
0.12.1** — the root `node_modules/dsh-kanban` and the profile tree dsh actually
serves the browser half from (`.dsh/profiles/web/pnpm-lock.yaml` is gitignored
by design; it is written by the install, not committed). The worktree was first
fast-forwarded onto `main` (`018450c`, the 0.12.0 pin) so this pin builds on the
current released state.

## What changes on the board

- **The sidebar row becomes a "back to the board" gesture.** Clicking the
  **Kanban** row in the sidebar while you are already inside the kanban panel
  now does what the top **Board** button does: show the board, close the ticket
  detail, leave the Analytics view. Before 0.12.1 the click did nothing at all
  in that state — the row calls `layout.selectPanel("kanban")`, which writes
  the same value into the layout store, so no subscriber notification fired,
  the main-slot `entryKey` was unchanged, and `KanbanPage` stayed mounted with
  whatever internal `view` / `selectedId` / `detail` it had.
- **Only this plugin's own row is affected.** The click is caught in the
  document's capture phase (before React's own handler) and only acted on when
  the clicked button contains `.kb-nav-icon-wrap` — the plugin-unique sidebar
  icon, rendered in both the wide sidebar and the collapsed rail — *and* the
  layout service reports `panelInfo.activePanelId === "kanban"`. A click that
  merely *opens* the panel is untouched (the page mounts on the board anyway),
  and every other panel row keeps its normal selection behavior.
- **Nothing else moved.** Board, detail, timeline, Analytics, model routing, the
  engine, the `kanban_*` tools and the Host RPC surface are byte-identical to
  0.12.0 apart from this listener, the `goBoardRequest` callback it calls, and
  `"layout"` added to the client's `exports.inject`.

## 1. Update the live checkout (needs write access to `/home/dsh/dsh-deploy`)

**Both trees must be installed** — a root-only install updates the host side and
silently leaves the browser half on 0.12.0 (this repo's `AGENTS.md`):

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin main  # 6cdd164, the pin commit
grep -n 'dsh-kanban' package.json .dsh/profiles/web/package.json
# both lines must read dsh-kanban-v0.12.1

pnpm install                                  # root tree
cd .dsh/profiles/web && pnpm install && cd -  # the tree dsh actually loads from
pnpm run check                                # check-no-links: ok

# PRE-RESTART ASSERTIONS - do not restart until all six hold:
grep -m1 '"version"' node_modules/dsh-kanban/package.json                        # 0.12.1
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json      # 0.12.1
grep -c 'kanban-goBoardRequest' .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 2
grep -c 'kb-nav-icon-wrap'      .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 3
grep -c 'activePanelId'         .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 1
grep -c '"layout"'              .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 2
```

If the version greps do not read 0.12.1, the profile tree is still the old
tarball: re-run `pnpm install` inside `.dsh/profiles/web` before touching the
service.

## 2. Production restart — Chris, planned window only

A restart ends every session running in the service, including any agent
session on this box. Do not run it from a session, and pick a window with no
kanban workflow turn in flight (check the board first: a blue, glowing card is a
turn running; a static red one is parked and safe).

```sh
sudo systemctl restart dsh
```

## 3. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i kanban | head
# expect: applied: db=… routes=/api/kanban/{board,…,worktree,events,sessionInfo}
```

Then in the GUI (:3081) — **hard-reload the tab first**, the client half is
snapshotted at boot:

- **Ticket detail → row click → board.** Open the Kanban panel, click any card
  so its detail renders, then click the **Kanban** row in the sidebar again.
  The board columns render and the detail is gone. (Before this deploy the
  second click did nothing.)
- **Analytics → row click → board.** Click **Analytics** in the page header,
  then the sidebar **Kanban** row. The board renders and Analytics is gone.
- **Collapsed rail works too.** Collapse the sidebar, open a ticket, click the
  Kanban icon in the rail: same reset.
- **Opening the panel is unchanged.** From a normal conversation, click the
  Kanban row: the panel opens on the board exactly as before.
- **Console is clean.** No `slot entry crashed in '…'` and no
  `Minified React error` anywhere in the browser console — the change adds a
  document listener and a module-scope callback, no new React hook, so no slot
  entry's hook order moved.

## Lab evidence (before release)

Lab `kan25` (`:3099`, `~/dsh-lab/kan25`, cloned from `main` at `018450c`),
`dsh-kanban` **linked** to the release checkout
(`/home/dsh/dsh-lab/plugins/dsh-plugins-kan25/packages/kanban`). Evidence kept
in `/home/dsh/dsh-lab/kan25-evidence/` (probe scripts + screenshots; the lab
shots live under `<lab>/.lab/smoke/shots/`).

- **Playwright click-through** (`kan25-probe.mjs`, `RESULT: PASS`):

  ```text
  linked client has goBoardRequest marker: true
  1. row click from the conversation: {"board":true,"detail":false,"analytics":false}
  2. card clicked, detail open:       {"board":false,"detail":true,"analytics":false}
  3. row click from the detail -> board: {"board":true,"detail":false,"analytics":false}
  4. analytics open:                  {"board":false,"detail":false,"analytics":true}
  5. row click from analytics -> board: {"board":true,"detail":false,"analytics":false}
  6. rail: detail open:               {"board":false,"detail":true,"analytics":false}
  7. rail row click -> board:         {"board":true,"detail":false,"analytics":false}
  4d. left kanban for another panel:  {"panel":"Plugins","board":false}
  8. leave and return via the row:    {"board":true,"detail":false,"analytics":false}
  console problems (all): []
  console fatal (slot crash / React minified): []
  ```

  Screenshots: `KAN-25-01-board.png` … `KAN-25-08-return-to-panel.png`.
- **Control run against the released 0.12.0** in the same lab
  (`kan25-control.mjs`), to prove the probe measures the fix and not the lab:

  ```text
  linked client has goBoardRequest marker: false
  installed version: 0.12.0
  after row click: {"detailStillOpen":true,"boardVisible":false}
  RESULT: old client reproduces the bug: the row click left the detail open
  ```
- `node --test packages/kanban/test/*.test.mjs` — **236 tests, 0 failures**
  (40 skipped: the tiers that need a configured host).
- `node scripts/verify.mjs` — 0 errors, 0 warnings across 11 packages.
  `node scripts/check-plugin-hooks.mjs packages/kanban` — **0 violations, 0
  warnings** (no new React hook anywhere). `npm run check` — green.
- `node scripts/compose-smoke.mjs kanban` — `ok dsh-kanban (imports, not
  skipped, layer + 1 row(s), profile wiring)`.
- `npm pack --dry-run` in `packages/kanban` — 32 files, allowlist unchanged.
- CI on PR #66: `contract`, `tests` on Node 20.9 / 22 / 24, and `compose` — all
  pass; the tag `dsh-kanban-v0.12.1` was cut on the merge commit `2ab93ed`.
- `scripts/lab.sh smoke --only ui --skip-model` with the plugin linked: **6 PASS,
  0 FAIL, 0 SKIP** (`<lab>/.lab/smoke/RESULTS.md`) — sidebar entries present,
  Plugins / Context Insights / Automation tasks pages render, every
  right-sidebar tool opens, and *no `slot entry crashed` or React errors in the
  console*.

## Rollback

Rollback is pinning the previous tag, reinstalling **both** trees, and
restarting in a planned window — the same path as the deploy:

```sh
cd /home/dsh/dsh-deploy
sed -i 's/#dsh-kanban-v0.12.1/#dsh-kanban-v0.12.0/' package.json .dsh/profiles/web/package.json
pnpm install && (cd .dsh/profiles/web && pnpm install)
pnpm run check
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json   # 0.12.0
sudo systemctl restart dsh
```

Nothing in 0.12.1 writes state that 0.12.0 cannot read: the board schema is
untouched (V5, same as 0.12.0) and the change is one browser-side listener.

## Decisions worth knowing about

- **Why a document listener instead of a core change.** The row is core's
  (`sidebar.panellist` `PanelRow`), and its click is exactly "select this
  panel" — correct behavior for every panel. "Re-selecting the panel you are
  already on should reset it" is a per-panel opinion, so it lives in the plugin
  that owns the panel and ships with it. Core needed no change, and no other
  panel's row behaves differently.
- **Why capture phase.** The reset has to be applied on the same click that
  selects the panel; a bubble-phase listener would race React's own handler and
  a future core change to that handler would silently reorder the two.
- **Why the `activePanelId` guard.** Without it the listener would fire on the
  click that *opens* the panel too. That is harmless today (the page mounts on
  the board) but it would also catch a click while another panel is showing,
  calling a stale callback from a page that is no longer mounted. The guard
  makes the reset mean exactly "you asked for the board while already on
  kanban".
- **If the layout service is ever absent** the guard degrades to always
  resetting rather than never — the safe direction, since `goBoardRequest` only
  exists while `KanbanPage` is mounted and a stale call is a React no-op.
- **Analytics is included deliberately.** The human's answer for this ticket was
  that the row always lands on the board, from Analytics as well as from a
  ticket detail.
