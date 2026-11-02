# KAN-17 — awaiting approval triggers needs attention: released, pinned, pre-staged; only the restart remains

**Status: released, pinned on `main`, and pre-staged on the box.** The live
checkout on disk now holds 0.13.1 and every pre-restart assertion passed there.
**The one remaining step is the service restart in section 3 — a human step in a
planned window.** Until it happens, production is *running* 0.13.0 in memory
while 0.13.1 sits on disk.

| thing | where | state |
| --- | --- | --- |
| dsh-kanban change | [PR #68](https://github.com/chrisjohnson/dsh-plugins/pull/68), commit `989e2d1`, merge commit `1bc2192` | **merged into `main`** |
| release tag | `dsh-kanban-v0.13.1` → `1bc21922725feaff9e56f1b9df40bd76492a566a` | **pushed** (tag ref API confirms sha == main sha; `package.json` at the tag reads 0.13.1) |
| this repo's pin | `package.json` + `.dsh/profiles/web/package.json` | **both read `dsh-kanban-v0.13.1`** (commit `f7e33e5`), root `pnpm-lock.yaml` resolves the tag to `1bc2192` |
| **production checkout** | `/home/dsh/dsh-deploy` | **pre-staged at `f7e33e5`**: pulled, both trees installed, all six assertions passed (section 2) |
| **production service** | `dsh`, pid `3766047`, started `05:48:17 UTC` (the KAN-16 restart) | **not restarted** — still running 0.13.0 in memory. Section 3 is the only step left. |

## What the change is

A card used to pulse blue **"Running"** while its session sat on an unanswered
approval prompt. KAN-6's production build-session log is the proof: one
`approval/asked` waited ~11.7 minutes for a human while the board said the
ticket was working. The turn *is* in flight — the harness pauses **inside** it —
so the card status, computed from `turn/start`/`turn/end` alone, could not tell
"working" from "blocked on a person".

Now the board reads the pause from the durable session log, which already
carried it:

- The driver folds `approval/asked` … `approval/decided` (paired by `id`) and
  an `ask_user_question` `tool/call` answered by the `tool/result` citing the
  same `callId` into a per-session `humanWaits` map, on the `session/event`
  stream it already consumes — engine-driven and human-driven turns alike, in
  every phase.
- `cardStatus` lets a pending wait take **attention** precedence over `active`.
  The card badge reads **Awaiting approval** (approval ask) or **Waiting on
  you** (question) instead of "Running".
- The ticket detail hero grows an **Open session** button while a wait is
  pending, landing on the prompt itself; `approvalSessionId` points at the
  session holding the ask (the verify-phase fallback stays).
- Restart recovery: a session reopened mid-turn is seeded by scanning back to
  the open turn (last `turn/start` with no matching `turn/end` — the same
  boundary `dsh-user-approval` requires for its audit pair) for an unanswered
  ask, so the red card survives a restart.
- Every entry is cleared by its own `decided`/`result` event, and defensively
  by `turn/end`, `turn/start` and `closeSession` — a decision that was never
  published cannot haunt a session into permanent red.

**No config key, no schema change, no tool change.** The events were always in
the log; the board just starts reading them. The plan-phase-only
`isAwaitingUser` waiter scan is superseded by the generalized
`isAwaitingQuestion` (host `awaitingQuestion` now means "a session of this
ticket is waiting on your answer", any phase).

Rationale in the package's `DECISIONS.md` (2026-11-02 section) and
`CHANGELOG.md` 0.13.1.

## Verification already done

Repo checks on the branch (`npm run check` = verify + hooks gate + all suites,
bare clone as CI runs it):

```text
verify:             0 error(s), 0 warning(s) across 11 package(s)
check-plugin-hooks: checked 12 client file(s): 0 violation(s), 0 warning(s)
tests:              768 tests, 683 pass, 0 fail, 85 skipped
                    (the 85 skips are the peer-package-gated suites, identical on main)
npm pack --dry-run: dsh-kanban-0.13.1.tgz, 33 files, every src file present
```

With the dsh peer packages resolvable, the kanban suites run for real:
**263/263 pass, 0 skip** — including the new `dispatch-human-wait.test.mjs`
(15 cases: asked→attention while the turn is in flight; each outcome
(allowed-once/rejected/cancelled/unavailable) clears; id pairing; stray ask
cleared at turn end; question call/result pairing by callId; non-ticket
sessions ignored; close clears; reattach seeding incl. answered / closed-turn /
earlier-turn cases), the lifecycle precedence cases, and the host-contract
wiring assertions. All five CI checks on PR #68 (compose, contract, tests on
node 20.9.0 / 22 / 24) passed before the merge.

Lab (`kan17`, plugin linked): `smoke --only ui,kanban-recovery` **14 PASS, 0
FAIL, 0 SKIP**, including "no `slot entry crashed` or React errors in the
console" and the full recovery scenario (kick, park, degraded) unaffected.
Evidence in `/home/dsh/dsh-lab/kan17-evidence/` (scripts, logs, screenshots,
`smoke-RESULTS.md`); the lab is now unlinked and stopped.

Live browser end-to-end against the lab board with real model turns
(`kan17-e2e.mjs`, `kan17-e2e-question3.mjs`):

```text
question path (mid-turn ask_user_question in a build session)
  card turns attention with awaitingQuestion while the turn is in flight   PASS
  card badge reads "Waiting on you"                                        PASS
  detail hero shows the chip and an Open session button                    PASS
  Open session lands on the prompt; answering flips the card back to blue  PASS

approval path (real sandbox-escalation ask in a build session)
  card turns attention with awaitingApproval mid-turn                      PASS
  card badge reads "Awaiting approval"                                     PASS
  "Allow once" in the session flips the card back to active                PASS

console clean                                                              PASS
```

One note: a rejection also clears the red wait (the `decided` event arrives
either way); what happens next is the engine's own outcome for the turn, not
this change.

## 1. Already done — release and pin (2026-11-02, KAN-17 session)

### 1a. Merged and tagged

[PR #68](https://github.com/chrisjohnson/dsh-plugins/pull/68) merged into
`dsh-plugins` `main` as merge commit
`1bc21922725feaff9e56f1b9df40bd76492a566a`, and the lightweight tag was cut on
that merge commit per `docs/releasing.md`:

```text
refs/tags/dsh-kanban-v0.13.1 -> 1bc21922725feaff9e56f1b9df40bd76492a566a
```

### 1b. Pin bumped in both manifests, lockfile resolved

`package.json` and `.dsh/profiles/web/package.json` both moved
`dsh-kanban-v0.13.0` → **`dsh-kanban-v0.13.1`** (a two-line, value-only diff),
and `pnpm install --lockfile-only` rewrote the root `pnpm-lock.yaml`, which now
resolves the tag to the merge commit:

```text
dsh-kanban@https://codeload.github.com/chrisjohnson/dsh-plugins/tar.gz/1bc21922725feaff9e56f1b9df40bd76492a566a#path:/packages/kanban
```

### 1c. Both trees installed and asserted — in the KAN-17 worktree first

To prove the pin actually installs and that the assertions below are correct,
**both** trees were installed in this worktree (`.dsh-worktrees/ivory-summit`)
before the push: root 0.13.1, profile 0.13.1, `pnpm run check` ok. That dry run
is what makes the section-2 numbers expected rather than guessed.

### 1d. Committed and pushed to `main`

The pin (`f7e33e5`) and this handoff are committed and pushed to `main` in this
repo (direct fast-forward pushes are authorized here by `AGENTS.md`).

## 2. Production pre-stage — DONE (2026-11-02 ~14:08 UTC, KAN-17 session)

Carried out in the live checkout `/home/dsh/dsh-deploy`. **Both** trees were
installed, because a root-only install updates the host side and silently leaves
the browser half on the old tag — the miss `AGENTS.md` records:

```sh
cd /home/dsh/dsh-deploy
git pull --ff-only origin main   # 6684d33 -> f7e33e5, the pin commit
pnpm install                                 # root tree
cd .dsh/profiles/web && pnpm install         # the tree dsh serves the client half from
pnpm run check
```

Recorded output:

```text
HEAD now: f7e33e5
package.json + .dsh/profiles/web/package.json both read #dsh-kanban-v0.13.1
root install:    Done in 2.6s using pnpm v11.22.0
profile install: Done in 2.5s using pnpm v12.9.0
pnpm run check:  check-no-links: ok (4 files checked)

PRE-RESTART ASSERTIONS — all six held:
1 root version:          "version":"0.13.1"
2 profile version:       "version":"0.13.1"
3 client "Awaiting approval" label: 1
4 client awaitingApproval wiring:   4
5 host awaitingApproval flag:       5
6 dispatch approval/asked fold:     4
```

The service was **not** touched by this step, and that was checked rather than
assumed: `MainPID` is still `3766047` and `ActiveEnterTimestamp` is still
`Mon 2026-11-02 05:48:17 UTC`, both identical to the fingerprint taken before
the pull. So production is *running* 0.13.0 while 0.13.1 sits on disk —
**section 3 is all that is left.**

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

- **The red card appears while a session waits.** Start (or wait for) a ticket
  whose session hits an approval prompt or asks a question mid-turn: the card
  goes static red and its badge reads **Awaiting approval** (or **Waiting on
  you**), not "Running". The badge shows in every phase, not only approval.
- **The detail reaches the prompt.** Open the ticket: the hero chip says
  "awaiting approval" / "waiting on your answer" and an **Open session** button
  lands on the pending prompt.
- **Answering flips it back.** Allow once (or answer the question) in the
  session: the card returns to blue "Running" while the turn continues. A
  rejection clears the red wait too; the engine's own outcome for the turn
  decides what the card says next (a park keeps its usual reason).
- **Restart recovery.** If a session is reopened mid-turn with an unanswered
  ask, the card shows the attention badge immediately — no wait for a new event.
- **Console is clean.** No `slot entry crashed in '…'`, no `Minified React
  error`. The client change adds no React hook — the badge, chip and button are
  conditional elements in components whose hooks are unchanged — so no slot
  entry's hook order moved.
- **Nothing else changed.** Model routing, Analytics, timeline, the `kanban_*`
  tools, Start planning, and every other board gesture are untouched.

## Rollback

Pin the previous tag, reinstall both trees, restart in a planned window:

```sh
cd /home/dsh/dsh-deploy
git revert f7e33e5   # or edit both manifests back to dsh-kanban-v0.13.0
pnpm install
cd .dsh/profiles/web && pnpm install
pnpm run check
# then: sudo systemctl restart dsh   (Chris, planned window)
```

No migration and no new config key, so a rollback is a pin change, two installs
and a restart, and nothing else. After a rollback the board simply stops
showing the mid-turn attention badge, exactly as before 0.13.1.
