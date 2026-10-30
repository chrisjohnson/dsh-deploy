# KAN-11 — approval moves into the build session: deploy + restart handoff

Shipped in `dsh-plugins` (PR merged, lightweight tag cut on the merge commit):

| package | tag | merge commit | what it changes |
| --- | --- | --- | --- |
| dsh-kanban | `dsh-kanban-v0.7.0` | `bbdadb5` ([PR #55](https://github.com/chrisjohnson/dsh-plugins/pull/55)) | **Approval is a phase of the build session, not a session of its own.** A passing review no longer closes the build session and waits for a human to press *Launch approval session*: the same session is flipped to the `approver` phase, moved onto the configured `approver` route, sent one slim hand-over prompt as a normal role turn, and the ticket then parks **Awaiting human approval** inside that conversation. |

Pinned in this worktree (branch `dsh/rapid-juniper`, commit `6eabc00` "pin
dsh-kanban 0.7.0"): both `package.json` and `.dsh/profiles/web/package.json`
move from `dsh-kanban-v0.6.0` to `dsh-kanban-v0.7.0`, root `pnpm-lock.yaml`
updated, and **both installed trees verified at 0.7.0** (root
`node_modules/dsh-kanban` and the profile tree dsh actually serves the browser
half from).

> The plan for this ticket was written when the deployment was pinned to 0.5.1,
> so it described the bump as 0.5.1 → 0.7.0 (bringing 0.6.0 with it). `main`
> pinned 0.6.0 in `30a57fe` while this ticket was in flight, so the committed
> change here is **0.6.0 → 0.7.0** and 0.6.0's standard-tools behaviour is
> already live on the box.

## What changes on the board

- **A ticket waiting for you is now one conversation, not two.** After a complete
  review the build session stays open and the agent summarizes what it built and
  asks what you want to do. Answer it there, or use the card's buttons.
- **The approval card's buttons are unchanged**: **Approve and close** and
  **Discard** still work from the board without touching a session. The third
  button now reads **Open build session** (it used to read *Open approval session*
  and, when none existed, *Launch approval session*). The launch button is gone —
  there is nothing to launch; the session is already there.
- **`kanban_approve` / `kanban_discard` / `kanban_submit_plan` are live in the
  build session while its ticket is in `verify`.** They were already *registered*
  there since 0.6.0; what was missing was the phase flip that makes the approver
  half of their gate reachable. In any other phase they still refuse with
  `… is not available in the … phase`.
- **A failed approval turn parks the ticket** as
  `turn failed in approval: …` like any other phase, and auto-recovery (the
  continue-kicker kick) applies to it too. If the agent closes or re-plans the
  ticket from inside that turn, the engine notices and does not park over it.
  One exception: a turn that fails because the session is *still busy* does not
  park at all — see "Known gap not fixed in 0.7.0" at the end of this document.
- **With no `approver` route configured** the engine skips the approval turn and
  parks the ticket exactly the way 0.6.0 did — so a deployment that never set one
  loses the hand-over prompt and nothing else. This deployment *does* set one
  (`local-ai-machine (apu)` / `big-moe`), and that route is now consumed by the
  approval turn inside the build session instead of by a session of its own.
- **No `cordis.patch.yml` change is needed.** The `kanban` row sets no
  `allowTools` (a deprecated no-op since 0.6.0) and its `roles.approver` entry
  stays as it is.
- **Rollback** is pinning `dsh-kanban-v0.6.0` in both manifests, reinstalling both
  trees, and restarting in a planned window. No database migration ships with
  0.7.0 (schema stays at 4), so a rollback needs no data step; the only
  incompatibility is that tickets parked **Awaiting human approval** by 0.7.0 have
  their approval in the *build* session, which 0.6.0 would show as a plain build
  session with no approval session to launch.

Expected state of the live board right after the restart: **no ticket is in
`verify`**, so nothing is mid-approval. KAN-11 (this ticket) sits in **Working**
with a red restart-recovery park; KAN-12 sits in Backlog at Build; KAN-13..20 sit
in Backlog at Plan; KAN-7 keeps its parked plan reason in Backlog. The one open
workflow session is KAN-11's build session, which the restart closes and parks.

## 1. Update the live checkout (needs write access to `/home/dsh/dsh-deploy`)

**Both trees must be installed** — a root-only install updates the host side and
silently leaves the browser half on 0.6.0 (see this repo's `AGENTS.md`, hit for
real on the model-capacity 0.3.0 pin):

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin dsh/rapid-juniper   # -> the pin commit above (or merge it to main first)
grep -n 'dsh-kanban' package.json .dsh/profiles/web/package.json
# both lines must read dsh-kanban-v0.7.0

pnpm install                                  # root tree
cd .dsh/profiles/web && pnpm install && cd -  # the tree dsh actually loads from
pnpm run check                                # check-no-links: ok

# PRE-RESTART ASSERTIONS - do not restart until all three hold:
grep -m1 '"version"' node_modules/dsh-kanban/package.json           # 0.7.0
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json  # 0.7.0
grep -c 'Open build session' .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs  # 1
grep -c 'Launch approval session' .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs  # 0
ls .dsh/profiles/web/node_modules/dsh-kanban/prompts/approval.md    # the new prompt ships
```

## 2. Production restart — Chris, planned window only

A restart ends every session running in the service, including any agent session
on this box. Do not run it from a session, and pick a window with no kanban
workflow turn in flight (the engine's restart recovery parks mid-turn tickets with
a red card — expected, not data loss).

```sh
sudo systemctl restart dsh
```

## 3. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i kanban | head
```

Then in the GUI (Kanban panel):

- Drag a ticket through plan → build → review and watch what happens on a
  **passing** review: the card goes blue (in flight) rather than red, and the
  build session gets a new turn asking the human what to do. When that turn ends,
  the card turns red with **Awaiting human approval**.
- Open that ticket's approval card: the panel says approval happens in the build
  session and offers **Approve and close**, **Discard**, **Open build session** —
  and no *Launch approval session*.
- Clicking **Open build session** lands in the session that wrote the code, in the
  approver phase; `kanban_approve` there closes the ticket.
- The ticket timeline shows an **Approval** block (the `approval` span, role
  `approver`, on the approver route) after Build and Review, in the same attempt.
- If a ticket is already in `verify` when the restart happens, its build session
  reattaches as the approver: reopening it must accept `kanban_approve` and refuse
  `kanban_submit_implementation` with `not available in the approver phase`.

## Lab evidence (before release)

Lab `default` (`:3097`), `dsh-kanban` **linked** to the 0.7.0 checkout
(`~/dsh-lab/plugins/dsh-plugins-kan11/packages/kanban`), production fingerprint
saved before and compared after.

- `lab.sh up`: boot log clean, no admission rejects, `--dump-config` composed 17
  bundles / 55 layer annotations.
- `smoke --only boot,ui,sessions`: **13 PASS, 1 FAIL**. The FAIL is the known
  pre-existing 404 on one copied production session (`Adjust big-moe context to
  512k`), documented identically in `KAN-4-smoke-results.md` and
  `KAN-10-smoke-results.md`; it exercises session-format conversion, not kanban.
  `ui` is clean: no `slot entry crashed`, every right-sidebar tool opens, the
  Kanban page renders with the new client half.
- `smoke --only kanban-recovery` (the engine's auto-recovery regression, which
  parks at **implement** and is untouched by this change): recorded in
  `KAN-11-smoke-results.md`.
- `npm run check` in dsh-plugins on a bare clone: verify 0 errors / 0 warnings
  across 11 packages, hooks gate 0 violations, 614 tests 0 failures.
- `node --test packages/kanban/test/*.test.mjs` with the dsh peers present:
  **109/109 pass**, including the new approval-in-build-session engine tests, the
  reattach-as-approver dispatch tests, and the host-contract guards that fail if
  the deleted approval-session code or endpoint ever comes back.
- `node scripts/compose-smoke.mjs kanban`: installs into a throwaway profile,
  imports, layer + row land.
- `npm pack --dry-run`: 29 files, `prompts/approval.md` included, no test or
  local files.
- CI on PR #55: contract pass, tests pass on Node 20.9 / 22 / 24, compose pass.

## Known gap not fixed in 0.7.0

A hardening was written after the tag was cut, so it is **not** in
`dsh-kanban-v0.7.0` (a released tag is permanent). It closes a narrow race with a
silent stall at the end of it. **Recommendation: ship it as 0.7.1 and re-pin** —
see "Decisions needed" below.

`enterApproval` waits up to 3 s (`awaitQuiet`) for the ticket's sessions to go
quiet before sending the approval turn, because a manual review submission
concludes the human's own turn and asks for approval in the same beat. If they
never go quiet, 0.7.0 does **not** park the ticket. The chain, against the shipped
code:

1. `roleTurn` → `driver.sendTurn` rejects with `session … already has a turn in
   flight` (the driver's busy guard).
2. `roleTurn` catches it and returns `{ kind: 'failed' }`.
3. `autoRecover` asks continue-kicker for a kick; the kick is declined, because
   the session is genuinely *running*, not halted — so there is nothing to recover.
4. `failedTurn` → `needsAttention`, whose own busy guard (`engine.mjs:921-924`)
   logs `failure ignored: another session is still active` and returns
   `{ kind: 'busy' }` **without setting a reason**.
5. The ticket is left in `verify`, un-parked, with no approval turn. `advance()`
   has no `verify` branch, so no later tick re-drives it either.

Measured, not inferred — driving the tagged `enterApproval` with a session that is
still busy when approval starts:

| engine | result |
| --- | --- |
| shipped `dsh-kanban-v0.7.0` | `phase: verify`, `needsAttentionReason: null`, approval turn attempted and lost |
| with the four-line fix below | `phase: verify`, `needsAttentionReason: 'Awaiting human approval'`, no approval turn sent |

What that looks like on the board: a Working card sitting at the Approval stage
with **no red attention card and no approval panel** — the panel renders only
when a park exists. Nothing is lost and it is recoverable by hand (the session's
phase role is already `approver`, so opening it from the Sessions tab and using
`kanban_approve` / `kanban_discard` / `kanban_submit_plan` works normally), but
the board gives no signal that this happened.

How narrow: it needs a session of the ticket busy for a continuous 3 s at the
moment review passes. The engine-driven path cannot hit it (the engine awaited
its own review turn, so the session is idle). The manual path normally clears
within a beat of `concludeTurn`. So this is a race, not a routine failure — but
its consequence is a stall rather than the retryable park previously claimed here.

The fix, four lines in `enterApproval` immediately before
`const runId = this.ensureRun(current)`:

```diff
-    await this.awaitQuiet(current);
+    if (!(await this.awaitQuiet(current))) {
+      this.log.warn('ticket %s still has a turn in flight at approval; parking without an approval turn', current.key);
+      this.store.setNeedsAttention(current.id, 'Awaiting human approval');
+      return { kind: 'wait' };
+    }
```

With it, the lost race degrades to exactly the pre-0.7.0 behaviour: the ticket
parks **Awaiting human approval**, the approval panel appears, and the human
approves or discards from the card (the second row of the table above is this
patch, applied and measured). It needs one test alongside it — a driver that
reports busy throughout must end with `phase === 'verify'`,
`needsAttentionReason === 'Awaiting human approval'` and no approval turn sent.
The patch and that test were written and passing before the tag was cut; the tag
was already permanent by then, so they live here instead.

## Decisions needed (from the implementer's questions)

1. **Merge the dsh-deploy pin (`dsh/rapid-juniper`, `6eabc00`) to `main` now, or
   hold it for the restart window?** Recommend: **hold**. The pin only takes
   effect after `pnpm install` in both trees plus a restart, so merging early
   buys nothing, and keeping it on a branch means an unplanned `git pull` on the
   box cannot half-activate 0.7.0 between now and the window. Merge it as part of
   step 1 below, in the same window as the restart.
2. **Ship the 0.7.1 hardening above?** Recommend: **yes**, before or alongside
   the restart. It is four lines plus one test, it only changes a path that today
   ends in a silent stall, and folding it in before the restart avoids a second
   planned window for the same plugin. If it is taken, the pin moves to
   `dsh-kanban-v0.7.1` in both manifests and everything in sections 1–3 above
   applies unchanged (re-run the two `grep -c` client-half proofs, which are
   version-independent). This ticket's plan and its `deploy-pinned` condition
   both name 0.7.0 explicitly, so the bump is deliberately left as a human call
   rather than taken unilaterally.
