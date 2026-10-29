# KAN-10 lab smoke results

Lab `default` on :3097, dsh-kanban **linked** to the 0.5.0 feature checkout
(`~/dsh-lab/plugins/dsh-plugins-kanban10`). Three runs back the evidence below.

## 1. `smoke --only ui` — 6 PASS, 0 FAIL

```
PASS ui / the app loads and the sidebar renders - sidebar entries present
PASS ui / Plugins page lists every installed bundle - 15 installed
PASS ui / Context Insights page renders - rendered
PASS ui / Automation tasks page renders - rendered
PASS ui / right-sidebar tools open without errors - Files: ok; Context: ok; Changes: ok; Tasks: ok; Worktree branch: ok; Loop evals: ok
PASS ui / no `slot entry crashed` or React errors in the console - console clean
```

## 2. Full `smoke` (started 2026-10-29T16:48Z, after a clean lab restart) — 37 PASS, 5 FAIL

All boot, ui, completion, web-search, image-search, webp, continue-kicker and
model-switch checks PASS, and **kanban-recovery 7/8**:

```
PASS kanban-recovery / lab route with a 48-token output budget is mounted under the implementer
PASS kanban-recovery / capabilities reports the kick service - continueKicker=true worktree=true
PASS kanban-recovery / a halted implement turn is kicked by the engine and the ticket stays In flight - 3 auto_recovered events over 399 active samples, parked in Working as 'turn failed in implement: max-tokens'
PASS kanban-recovery / the session carries exactly maxConsecutiveKicks kicks and no duplicates - 3 kicks, 4 turn ends (4 halts)
PASS kanban-recovery / the ticket parks with the original halt once the guard declines - parked: turn failed in implement: max-tokens
PASS kanban-recovery / degraded: with continue-kicker unmounted the ticket parks directly
PASS kanban-recovery / degraded: capabilities says the service is absent - continueKicker=false
FAIL kanban-recovery / degraded: one halt, no kicks, straight to Needs attention - ticket KAN-19 never parked (last: working/plan)
```

The one kanban FAIL is model contention, not the change: the scenario-B plan
turn (big-moe on the APU, shared with this session and the suite's own turns)
did not finish inside the module's 600 s deadline; three seconds after the
timeout the module's own restart parked the ticket correctly in place
(`working` + restart-recovery reason, event chain verified in the lab DB).
The same module ran **8/8 PASS** standalone twice.

The four other FAILs are non-kanban modules. **The full suite was never
simultaneously green**, and each remaining FAIL is environmental:

- `sessions / reopen 4 of them` — the identical pre-existing 404 on the same
  copied session in the KAN-4 baseline (`KAN-4-smoke-results.md`), unrelated
  to kanban.
- `scheduled-queue / the item fires into session A` — click timeout under load;
  PASS on the immediate rerun.
- `loop-watchdog / Loop evals panel renders` — click timeout; failed on both
  the full run and the rerun (the observe-only watchdog skipped every step in
  both). The module exercises dsh-loop-watchdog and never touches kanban code.
- `worktree / composer Worktree switch` — click timeout under load; the module
  exercises dsh-better-git-worktree and never touches kanban code.

Attribution correction: an earlier version of this file claimed these were
"reproduced with the same lab on the pinned 0.4.4". That was wrong —
`scripts/lab.sh unlink kanban` fails on this lab (the lab clone's HEAD has no
dsh-kanban pin; the pin lives on the deploy branch), so the follow-up
4-module rerun still executed against the linked 0.5.0 checkout. No 0.4.4
comparison was actually run; the attribution above rests on module isolation
(these modules exercise other plugins), the documented KAN-4-baseline
`sessions` failure, and the pass-on-rerun behaviour of the timing-sensitive
click checks.

## 3. Standalone `smoke --only kanban-recovery` — 8 PASS, 0 FAIL

```
PASS kanban-recovery / lab route with a 48-token output budget is mounted under the implementer
PASS kanban-recovery / capabilities reports the kick service
PASS kanban-recovery / a halted implement turn is kicked by the engine and the ticket stays In flight - 3 auto_recovered events over 380 active samples, parked in Working
PASS kanban-recovery / the session carries exactly maxConsecutiveKicks kicks and no duplicates - 3 kicks, 4 turn ends (4 halts)
PASS kanban-recovery / the ticket parks with the original halt once the guard declines
PASS kanban-recovery / degraded: with continue-kicker unmounted the ticket parks directly
PASS kanban-recovery / degraded: capabilities says the service is absent
PASS kanban-recovery / degraded: one halt, no kicks, straight to Needs attention - parked: turn failed in implement: max-tokens, zero auto_recovered events
```

## Browser verification (playwright against the lab GUI)

- Three grey columns `Backlog | Working | Done / Discarded`; no KPI row, no
  In-flight chip row; no `kb-col-*` accent classes; every card carries a status
  dot + phase chip; console clean (no `slot entry crashed`).
- KAN-6/7/9 (parked by restart recovery) render red in **Backlog** after the v4
  migration of a production DB copy; KAN-10 renders red in **Working**.
- Create form offers Backlog | Working only, default Backlog.
- Live flow: a plan-now ticket pulsed blue in Backlog, its plan landed and the
  card stayed in Backlog at Build (idle grey); dragging it to Working started
  the build (blue pulse, real implement turn); Retry on a parked Working card
  lifted the red park in place and relaunched the build (event chain:
  `attention_cleared` → `run_started` → turn → re-park in `working`).
- Schema V4 on the production copy: `now`→`working`, `needs_attention`→`backlog`
  (reasons kept), `schema_migrations` = 4, 355 events / 1075 spans / 106
  artifacts intact.

## 4. dsh-kanban 0.5.1 (Discarded badge) — review follow-up

Gates run on the fix branch (PR chrisjohnson/dsh-plugins#51, CI green on the PR
and on the tagged merge commit 7377c17):

- `node scripts/check-plugin-hooks.mjs` → 0 violations, 0 warnings.
- `node --test packages/kanban/test/*.test.mjs` → 89 tests, 89 pass, 0 fail.
- `node scripts/verify.mjs` → 0 errors across 11 packages.
- Badge-stage derivation exercised directly against the shipped client source
  (the helpers are pure): discard-from-plan → `Discarded`/grey,
  approval-discard (phase closed) → `Discarded`, done → `Done`,
  working/implement → `Build`, backlog/plan → `Plan`.

Not run this round: a live lab click-through of the 0.5.1 client. The session
sandbox denied writes outside the workspace (the lab checkout lives in
~/dsh-lab) and blocked `lab.sh` startup (it reads other users' /proc entries);
no escalation was available. The deploy pin moved to v0.5.1 and the
production restart will load it; the handoff note lists the one-minute lab
click-through for the next session with write access.
