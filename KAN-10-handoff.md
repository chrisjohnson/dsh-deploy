# KAN-10 — kanban flow and columns: deploy + restart handoff

Shipped in `dsh-plugins` (PR merged, tag cut on the merge commit):

| package | tag | what it changes |
| --- | --- | --- |
| dsh-kanban | `dsh-kanban-v0.5.0` | the board columns become intended state — **Backlog \| Working \| Done / Discarded**, all grey — and "in flight" / "needs attention" become card-level visual statuses (blue pulsing dot + glow while a workflow turn runs; red glowing card while the engine has parked the ticket). The engine never moves tickets between columns any more. |

Pinned in this worktree (branch `dsh/golden-heron`, commit "pin dsh-kanban
0.5.0"): both `package.json` and `.dsh/profiles/web/package.json` move from
`dsh-kanban-v0.4.4` to `dsh-kanban-v0.5.0`, root `pnpm-lock.yaml` updated, and
`.dsh/profiles/web/node_modules/dsh-kanban` verified to read 0.5.0.

## What changes on the board

- **No more In-flight / Blocked / Needs-attention columns.** Tickets live where
  you put them: Backlog or Working. Done/Discarded stay sinks.
- **`autoPromote` is gone** (config keys `autoPromote` / `autoPromotePerTick`
  are now unknown keys — this deployment's `kanban` row sets neither, so
  `cordis.patch.yml` needs no change). `wipCap` remains, but only as a
  concurrency throttle: Working tickets beyond the cap wait as idle grey cards;
  a drag into Working is never rejected.
- **Backlog + Planning=now tickets plan in place** and stop at Build until you
  drag them to Working. Build/review/approval only ever run in Working.
- **Parking is in place**: a failure, an exhausted attempt budget, a budget
  refusal, or awaiting-approval sets the reason on the row and lights the card
  red wherever it stands. A column drag, Retry, Approve, or a manual
  `kanban_submit_*` lifts it.
- **Blocked is removed** (column, Block/Unblock buttons, create-form option).
- The KPI row and the In-flight chip row above the board are gone; the phase
  badge carries the lifecycle colour (Plan blue, Build teal, Review pink,
  Approval violet, Done green).
- **Schema migration V4** rewrites the tickets table in place on first boot:
  `now` → `working`, `needs_attention` → `backlog` (reason kept — the card still
  glows red), `blocked` → `backlog`. Events, spans, sessions and artifacts are
  untouched (verified on a copy of the production DB: 355 events / 1075 spans /
  106 artifacts intact). The rewrite runs with `PRAGMA foreign_keys=OFF`
  outside the migration transaction; rollback to 0.4.4 after V4 has run would
  leave the new column names in a v4 database (0.4.4 refuses to boot on a newer
  schema — same as any forward migration).

Expected state of the live board right after the restart: KAN-10 (this ticket)
sits in **Working** with a red park from the restart recovery; KAN-6/7/9 sit in
**Backlog** glowing red (their `needs_attention` reasons carried over); KAN-1..5,
8 are Done, KAN-3 Discarded.

## 1. Update the live checkout (needs write access to `/home/dsh/dsh-deploy`)

**The root install is not enough** (see KAN-4-handoff.md §1 — the profile tree
is what dsh loads):

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin <branch-or-main>   # -> the pin commit above
grep -n 'dsh-kanban' package.json .dsh/profiles/web/package.json
# both lines must read dsh-kanban-v0.5.0

pnpm install                                  # root tree
cd .dsh/profiles/web && pnpm install && cd -  # the tree dsh actually loads from
pnpm run check                                # check-no-links: ok

# PRE-RESTART ASSERTION - do not restart until this reads 0.5.0:
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json
```

## 2. Production restart — Chris, planned window only

A restart ends every session running in the service, including any agent
session on this box. Do not run it from a session, and pick a window with no
kanban workflow turn in flight (the engine's restart recovery will park
mid-turn tickets with a red card — expected, not data loss).

```sh
sudo systemctl restart dsh
```

## 3. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i kanban | head
```

Then in the GUI (Kanban panel):

- The board shows exactly three grey columns: **Backlog | Working | Done /
  Discarded**; no KPI row, no In-flight chip row.
- **KAN-6/7/9 sit in Backlog with red glowing cards** ("Needs your decision" —
  their restart-recovery reasons carried over by migration V4).
- **KAN-10 sits in Working** (red until retried or dragged back).
- Open a parked card: the detail hero shows the red accent and the Needs
  attention panel; **Retry clears the red without moving the card**.
- The sidebar Kanban icon's badges count active/attention cards, not columns.

If the journal shows the boot line `applied: db=... routes=/api/kanban/...`
the plugin mounted; a boot that logs
`kanban database schema 4 is newer than this plugin` means the profile tree is
still on 0.4.4 while the DB already migrated — re-run the profile install
(section 1) before anything else.

## Lab evidence (before release)

- `scripts/lab.sh` with the plugin linked: v4 applied to a copy of the
  production DB — KAN-10 `now`→`working`, KAN-6/7/9 `needs_attention`→`backlog`
  with reasons, `schema_migrations` = 4, all children intact.
- Browser: three grey columns; a plan-now ticket pulsed blue in Backlog, landed
  at Build still in Backlog; dragging it to Working started the build; Retry
  lifted the red park in place; a failed turn re-parked in Working.
- `scripts/lab.sh smoke --only ui` PASS (console clean, no `slot entry
  crashed`); `--only kanban-recovery` 8/8 PASS (engine kicks 3x, ticket stays
  Working/active, parks in place); full `scripts/lab.sh smoke` results in
  KAN-10-smoke-results.md.
- `npm run check` in dsh-plugins on a bare clone: verify 0 errors, hooks gate
  clean, all tests pass (incl. the new schema V4 migration test).
