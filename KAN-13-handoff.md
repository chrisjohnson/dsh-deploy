# KAN-13 — kanban flow and style: deploy + restart handoff

Shipped in `dsh-plugins`:

| package | tag | merge commit | what it changes |
| --- | --- | --- | --- |
| dsh-kanban | `dsh-kanban-v0.9.0` | `b677375` ([PR #58](https://github.com/chrisjohnson/dsh-plugins/pull/58)) | The attention card stops pulsing; nothing opens a session on its own; a phase-change banner appears at the turn tail; the review/rework/approval prompts stop repasting the plan; `kanban_plan` is a read-only tool in every session; a `done_when` id the plan never declared is rejected at the tool boundary. |
| dsh-kanban | `dsh-kanban-v0.9.1` | `59f2c6f` ([PR #59](https://github.com/chrisjohnson/dsh-plugins/pull/59)) | A banner describes its own turn. Found in review of 0.9.0: the review banner read the ticket's *current* phase, so a session with one rework round printed **Review passed** on the turn whose review had failed. The call's own verdict now decides which transition to look for, a pass is only claimed when the ticket's latest review is that call's, each rejected round quotes its own instruction instead of the newest one, and the banner cache is bounded. |
| dsh-kanban | `dsh-kanban-v0.9.2` | `d678ac7` ([PR #60](https://github.com/chrisjohnson/dsh-plugins/pull/60)) | **A pass that landed is never called "not finished".** 0.9.1 left one instance of the same class: a ticket returns to `implement` by a second route — asking for a follow-up plan during approval — so a clean pass followed by a later round read **Review status: not finished**, quoting an older round's feedback. The host now returns `reviewRejected`, derived from artifact ordering (the engine writes the `review` row before the `review_feedback` that rejects it, and ids are AUTOINCREMENT), and only an explicit rejection may call a pass unfinished. |
| dsh-kanban | **`dsh-kanban-v0.9.3`** | `541090d` ([PR #61](https://github.com/chrisjohnson/dsh-plugins/pull/61)) | **A review call whose arguments never parsed claims no outcome.** One branch still read the phase alone: an unparseable `argsRaw` (an interrupted turn, or a block still streaming) rendered **Review passed** or **Review status: not finished** quoting another round's feedback. A schema-valid review always carries a verdict, so there was nothing to infer; the branch now renders nothing. **This is the version to deploy.** |

Pinned in this worktree (branch `dsh/quiet-finch`): both `package.json` and
`.dsh/profiles/web/package.json` move from `dsh-kanban-v0.8.1` to
**`dsh-kanban-v0.9.3`**, root `pnpm-lock.yaml` updated (it resolves the tag to
`541090d`), and **both installed trees verified at 0.9.3** — the root
`node_modules/dsh-kanban` and the profile tree dsh actually serves the browser
half from. The branch was first fast-forwarded onto `main` (`6d97b7e`, the KAN-12
0.8.1 pin) so this pin builds on the current released state rather than the 0.5.1
state the worktree was cut from.


## What changes on the board

- **A parked (needs-attention) card is static red.** Border, tint, left accent
  bar and red status dot stay; the `kb-glow-red` pulse and the dot's ring are
  gone. A card with a turn in flight is still blue and still glows — so motion
  now means exactly one thing: something is running. Nothing to configure.
- **Clicking a card never opens a session.** The ticket detail used to navigate
  into a plan session as soon as one appeared, and the board poll used to follow
  a newly created plan session across the screen. Both are deleted. A card click
  opens the ticket detail, and the board stays put while you watch it. The
  explicit buttons are untouched: **Open build session** on the approval panel,
  **Open** in the ticket's sessions table, **Recover tools** on an orphaned
  session.
- **A phase-change banner appears in the session's chat.** Any turn that ends on
  a `kanban_*` tool call gets one line at the turn tail — below the "Completed
  in …" disclosure, not folded into it — naming what that turn did to the
  ticket:
  - *Plan submitted — {summary} · Done when: {ids}. Now proceeding to build.*
  - *Implementation submitted — here's the plan: {summary} · done when: {ids}.
    Now proceeding to self-review.*
  - *Review status: not finished — {the reviewer's feedback}. Back to
    implementation.*
  - *Review passed — all conditions met. Now proceeding to approval.*
  - *Ticket approved and closed.* / *Ticket discarded.*

  The line is **not** taken from the tool call alone, and not from the ticket's
  current phase alone. A call refused by its phase gate or rejected by validation
  looks identical in the transcript, so the client asks the Host
  (`/api/kanban/sessionInfo`) what the ticket's real phase is. But a session with
  a rework round holds a failed review and a later passed one, so the phase alone
  would print **Review passed** on the turn that failed — the verdict and
  feedback the call itself carried decide *which* transition to look for, and a
  pass is only claimed when the ticket's latest review is the one that call
  submitted. When the two disagree, nothing renders. Long values are truncated to
  one line and the full text is in the hover tooltip. Nothing appears in a
  non-kanban session.
- **The review, rework and approval prompts are much smaller.** Those three
  phases run inside the build session that already holds the plan, the
  implementation and the diff, so they no longer paste them again. The review
  prompt keeps the adversarial instruction and instead enumerates every key of
  `kanban_submit_review` with what the engine checks, plus the plan's own
  condition ids as a compact list. Rework is one job statement plus, at most, a
  short reminder of the instruction. Approval is the one-line hand-over.
  `implement.md` and the two planning prompts are unchanged — they open fresh
  sessions and still carry the full contract.
- **`kanban_plan`, a read-only tool in every workflow session.** Returns the
  current plan (summary, steps, `done_when` with each condition's id, statement
  and verification), the live conditions and the latest review. No phase gate.
  This is also the recovery path for a session reopened after a restart, which
  is what lets the slim prompts honestly say "already in this conversation".
- **A `done_when` id the plan never declared is now a tool error, not a silent
  gap.** `kanban_submit_review` (on a pass) and `kanban_submit_implementation`
  compare the submitted ids against the board's and throw an error naming the
  expected set, so the model corrects itself inside the turn instead of
  producing a review the engine can only reject afterwards. A fail verdict may
  omit rows; it may not invent them.

**No `cordis.patch.yml` change is needed.** The existing `kanban` row keeps
working exactly as it is: no new required key, no renamed key, no `allowTools`
list, no prompt override. The schema stays at V4, so there is no migration and
no data step.

**Rollback** is pinning `dsh-kanban-v0.8.1` in both manifests, reinstalling both
trees, and restarting in a planned window. Nothing in 0.9.0–0.9.3 writes state that
0.8.1 cannot read: the banner and `sessionInfo` are read-only, the new tool is
additive, and the prompts are files the older package ships itself. Rolling back
to `dsh-kanban-v0.9.0` or `v0.9.1` instead would keep the whole feature set but
reintroduce a banner misattribution: 0.9.0 prints **Review passed** on the turn
whose review failed, and 0.9.1 prints **Review status: not finished** on a clean
pass that a later approval follow-up plan returned to implement.

## 1. Update the live checkout (needs write access to `/home/dsh/dsh-deploy`)

**Both trees must be installed** — a root-only install updates the host side and
silently leaves the browser half on 0.8.1 (this repo's `AGENTS.md`; hit for real
on the model-capacity 0.3.0 pin):

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin dsh/quiet-finch   # the pin commit (or merge it to main first)
grep -n 'dsh-kanban' package.json .dsh/profiles/web/package.json
# both lines must read dsh-kanban-v0.9.3

pnpm install                                  # root tree
cd .dsh/profiles/web && pnpm install && cd -  # the tree dsh actually loads from
pnpm run check                                # check-no-links: ok

# PRE-RESTART ASSERTIONS - do not restart until all nine hold:
grep -m1 '"version"' node_modules/dsh-kanban/package.json                     # 0.9.3
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json   # 0.9.3
grep -c 'kanban-phase-banner' .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 1
grep -c 'kb-glow-red'          .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 0
grep -c 'sessionInfo'          .dsh/profiles/web/node_modules/dsh-kanban/src/host.mjs     # >= 2
grep -c 'kanban_plan'          .dsh/profiles/web/node_modules/dsh-kanban/src/actions.mjs  # >= 2
grep -c 'sameReview'           .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 2 (0.9.1: the turn-local review check)
grep -c 'reviewRejected'       .dsh/profiles/web/node_modules/dsh-kanban/src/host.mjs     # 1 (0.9.2: the pass/return discriminator)
grep -c 'verdict === ""'       .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs   # 0 (0.9.3: no phase-only fallback)
```

## 2. Production restart — Chris, planned window only

A restart ends every session running in the service, including any agent session
on this box. Do not run it from a session, and pick a window with no kanban
workflow turn in flight (check the board first: a blue, glowing card is a turn
running; a static red one is parked and safe).

```sh
sudo systemctl restart dsh
```

## 3. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i kanban | head
# expect: applied: db=… routes=/api/kanban/{board,…,events,sessionInfo}
```

Then in the GUI (:3081, Kanban panel):

- **The board is calm.** Open a parked ticket's session and come back: the
  attention card is solid red with no pulse, and the status dot has no ring. A
  card with a turn running still glows blue.
- **Nothing navigates on its own.** Click several cards, including one that is
  planning, and watch the board for a poll cycle or two: the view never jumps
  into a session. Then use **Open build session** / **Open** and confirm those
  still do.
- **The banner appears.** Open a kanban session's chat (a plan session from
  before the restart works): the turn that submitted the plan shows
  *Plan submitted — … Now proceeding to build.* below the "Completed in …"
  disclosure, one line, with the full text on hover. Drive a new ticket through
  a round and confirm the implementation / review banners appear the same way.
- **A reworked ticket does not lie.** Open the chat of any session that went
  review-fail → rework → review-pass: the failed round must not read **Review
  passed**, and a passed round that a later follow-up plan returned to implement
  must not read **Review status: not finished**. If either happens, the browser is
  still running an old client half — `grep -c sameReview
  .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs` must be 2 and
  `grep -c reviewRejected
  .dsh/profiles/web/node_modules/dsh-kanban/src/host.mjs` must be 1 — and the tab
  needs a hard reload after the restart.
- **The prompts are slim.** On the next review turn, the ticket's timeline →
  events should show a `reviewer_prompt_review` artifact of a couple of KB, not
  the old plan-plus-diff dump.
- **`kanban_plan` is live.** In any kanban session, ask the agent to call
  `kanban_plan`; it answers with the plan, its condition ids and the latest
  review.
- **Console is clean.** No `slot entry crashed in 'conversation.chat.turnTail'`
  and no `Minified React error` in the browser console on a session view.

## Lab evidence (before release)

Lab `kan13` (`:3099`, under `/tmp/kan13-lab`, cloned from `main` at `6d97b7e`,
full copy of production session data), `dsh-kanban` **linked** to the 0.9.0
checkout, then the lab stopped.

- `lab.sh up` / `restart`: boot log clean, no admission rejects, `--dump-config`
  exit 0 with 56 layer annotations.
- `npm run check` in dsh-plugins on a bare clone: verify gate clean, hooks gate
  **0 violations / 0 warnings**, `node --test` **664 tests, 0 failures** (64
  skipped: the tiers that need a configured host). With the harness peers
  installed the kanban suite alone runs **159 tests, 0 failures** — including the
  new `actions.test.mjs` (the id gate and `kanban_plan`), `prompts.test.mjs`
  (the real prompt files rendered by the real engine) and `banner.test.mjs`
  (the banner decision, evaluated out of the shipped browser half).
- `node scripts/compose-smoke.mjs kanban`: composes, imports, layer lands.
  `npm pack --dry-run`: 30 files, every prompt and source included.
- CI on PR #58 and PR #59: `contract`, `tests` on Node 20.9 / 22 / 24, and
  `compose` — all pass. Tags `dsh-kanban-v0.9.0` (`b677375`) and
  `dsh-kanban-v0.9.1` (`59f2c6f`), `dsh-kanban-v0.9.2` (`d678ac7`) and
  `dsh-kanban-v0.9.3` (`541090d`) cut on their merge commits.
- **0.9.2, re-checked live with no regression.** Relinked to the 0.9.2 checkout
  and restarted, the same lab sessions render the same correct banners: the
  planner session its **Plan submitted** line, the build session exactly **one**
  **Review status: not finished** line quoting the engine's own code-verification
  gaps (that round really was bounced, so `reviewRejected` is true and the banner
  is right). `smoke --only ui` on the linked 0.9.2 lab: 6 PASS / 0 FAIL, console
  clean. The follow-up-plan case the fix targets is pinned by unit tests against
  the shipped source rather than driven end to end, because reaching it needs a
  full plan→implement→review→approval→follow-up sequence on real models.
- **0.9.1, proven live on the same data the defect came from.** The lab's KAN-2
  session holds three review rounds that each claimed a complete pass and were
  each sent back by the code check. On 0.9.0 that session rendered three
  `Review status: not finished` banners with identical text — every earlier round
  displaying the newest round's feedback. Relinked to the 0.9.1 checkout and
  restarted, the same session renders **one** banner, attributed to the round that
  actually produced the ticket's current state; the two superseded rounds render
  nothing rather than borrowing it (`N-091-rework-rounds.png`). The reviewer's
  exact repro — a failed-review turn on a ticket now in `verify` — returns null
  against the released 0.9.1 code, and `banner.test.mjs` pins it (11 tests).
- `smoke --only ui` against the linked lab: **6 PASS, 0 FAIL, 0 SKIP** — no
  `slot entry crashed`, no React console errors, every right-sidebar tool opens.
- `smoke --only kanban-recovery`: **8 PASS, 0 FAIL, 0 SKIP** — real role turns on
  the routed lab model, 3 engine kicks, parked on the original halt, and the
  degraded (no continue-kicker) path parking directly.
- Full `smoke`: **38 PASS, 10 FAIL, 0 SKIP**, and every failure is the harness
  session's environment rather than this change. `ui` and `kanban-recovery` are
  clean; `completion`, `webp`, `continue-kicker`, `model-switch` and the rest of
  `worktree` pass. The ten:
  - `boot / lab process is isolated from production`, `web-search` (both checks)
    and `image-search / SearXNG answers an image query` — all four fail on
    `EACCES: permission denied, open '/proc/<pid>/environ'`. The agent session
    that ran the suite is under a file sandbox that cannot read another process's
    environment; the same reason `lab.sh` needed `LAB_FORCE_UNIT_FALLBACK=1`
    throughout. They read production's `/proc` to find the lab-isolation proof and
    the SearXNG URL. From a normal shell they pass.
  - `boot / linked packages … pack cleanly` — `npm pack --dry-run` failed on
    root-owned files under `~/.npm/_cacache`. Re-running with
    `npm_config_cache=/tmp/npmcache` turned it green:
    `dsh-kanban -> /tmp/kan13/dsh-plugins/packages/kanban`.
  - `sessions / reopen 4 of them` — one copied production session logged a
    resource-load error on reopen. The same class is recorded as pre-existing in
    `KAN-11-smoke-results.md`; it exercises dsh's session-format conversion, not
    kanban.
  - `scheduled-queue / the item fires into session A`, `loop-watchdog` (two
    checks) and `worktree / worktree_convert …` — browser click timeouts and a
    180 s check timeout while the box was running five kanban workflow turns plus
    the agent session itself on the same two GPUs.

- **Real ticket runs on the lab's routed models** (planner/implementer/reviewer on
  `medium-dense`, approver on `big-moe`), driven through the GUI:
  - *plan → implement → review pass → approval* on a probe ticket produced all
    three expected banners, each at the turn tail below the "Completed in …"
    disclosure: `Plan submitted — … · Done when: file-exists, content-exact,
    no-other-files. Now proceeding to build.` in the plan session, and
    `Implementation submitted — here's the plan: … · done when: … Now proceeding
    to self-review.` plus `Review passed — all conditions met. Now proceeding to
    approval.` in the build session;
  - a probe whose acceptance the implementer could not satisfy produced
    `Review status: not finished — Review cannot be code-verified: …` once per
    rejected review round, each truncated to one line with the full text in the
    `title`;
  - asking the approval sessions to close their tickets produced
    `Ticket approved and closed.` and `Ticket discarded.`;
  - a parked ticket (planning that stopped to ask the human) renders
    `class="kb-card attention"` with computed `animationName: none`,
    `boxShadow: none`, a red border and tint, and a red status dot with no ring,
    while a card with a turn in flight still computes `animationName:
    kb-glow-blue`;
  - clicking four cards in turn (returning to the board between each) opened the
    ticket detail every time and a session view never once; the main frame
    recorded no navigation beyond the initial page load, and two further board
    poll cycles opened nothing either.

- **`kanban_plan` live**: a real planner session called it and the span recorded
  `planner | kanban_plan | ok`; a reviewer session called it and reported the
  plan's condition ids back.
- **The id gate live**: in a reviewer-phase session, `kanban_submit_review` with
  one row whose id was `bogus-id` returned, verbatim —

  > `kanban_submit_review rejected — missing e-txt-exists, e-txt-exact-content,
  > nothing-else-created; not plan conditions: bogus-id. The plan's condition ids
  > are exactly: e-txt-exists, e-txt-exact-content, nothing-else-created.
  > Resubmit with one done_when row per id, using these ids unchanged.`

  and no banner appeared for that turn, because the call never moved the ticket.
- Screenshots (in the lab's `shots/` and the session's `/tmp/kan13/shots/`):
  `E-parked-attention-card.png` (static red card beside a glowing blue one),
  `D-session-0-banners.png` / `D-session-1-banners.png` (plan, implementation and
  review-passed banners), `G-review-not-finished.png`, `H-approved.png`,
  `I-discarded.png`, `L-idgate-live.png` (the tool error in the transcript),
  `A`–`C` (board, detail, sessions table).


## Decisions needed

1. **Merge the dsh-deploy pin (`dsh/quiet-finch`) to `main` now, or hold it for
   the restart window?** Recommend: **hold**, same call as KAN-11 and KAN-12. The
   pin only takes effect after `pnpm install` in both trees plus a restart, so
   merging early buys nothing, and keeping it on a branch means an unplanned
   `git pull` on the box cannot half-activate 0.9.0 between now and the window.
   Merge it as part of section 1, in the same window as the restart.
2. **Does the banner wording need a tweak before it becomes the permanent
   surface?** The five lines are the ones the ticket asked for, including
   "Now proceeding to self-review" for the implementation banner — the review is
   a separate role session that happens to share the build session, so "self"
   reads oddly to someone who has not seen the design. Say the word and it is a
   one-line change in `client.mjs` for the next release; nothing else depends on
   the text.
3. **Should the review prompt's "already in this conversation" claim be tightened
   further?** It is now backed by two things: `kanban_plan` as the recovery path,
   and an explicit instruction to call it when the session starts empty (a
   reopened session after a restart has no prior transcript). If you would rather
   the review prompt always carried the plan text, that is a revert of one render
   var in `engine.review()` — but it is the token cost this ticket set out to
   remove.
