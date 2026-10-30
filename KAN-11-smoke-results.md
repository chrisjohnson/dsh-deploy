# KAN-11 — lab smoke results (dsh-kanban 0.7.0, approval in the build session)

Lab `default` on `:3097`, `dsh-kanban` **linked** to
`~/dsh-lab/plugins/dsh-plugins-kan11/packages/kanban` (the 0.7.0 release
checkout, tag `dsh-kanban-v0.7.0` = merge commit `bbdadb5`). Production was
fingerprinted before (`lab.sh prod-check save`) and compared after; the only
difference is this worktree's own HEAD, which is the pin commit. The production
unit was not touched (`MainPID 219454`, started 04:02:53 UTC, unchanged).

## `smoke --only boot,ui,sessions` — 13 PASS, 1 FAIL

```
PASS boot / lab process is isolated from production - pid 481374, port 3097, DSH_HOME and HOME inside the lab
PASS boot / server answers over HTTP - HTTP 200, 41967 bytes
PASS boot / boot log has no skip/admission/error/stack lines - 2 other line(s), none suspicious
PASS boot / no plugin was rejected at admission - no compatibility.json written
PASS boot / --dump-config composed a layer for every bundle - 17 bundles, 55 layer annotations
PASS boot / linked packages resolve to their checkout and pack cleanly
PASS ui / the app loads and the sidebar renders - sidebar entries present
PASS ui / Plugins page lists every installed bundle - 15 installed
PASS ui / Context Insights page renders - rendered
PASS ui / Automation tasks page renders - rendered
PASS ui / right-sidebar tools open without errors - Files: ok; Context: ok; Changes: ok; Tasks: ok; Worktree branch: ok; Loop evals: ok
PASS ui / no `slot entry crashed` or React errors in the console - console clean
PASS sessions / find cleanly-ended copied sessions - 26 candidates (24 still in the old format)
FAIL sessions / reopen 4 of them (old-format ones convert on disk) - 'Adjust big-moe context to 512k'
     (session-009cb19e-…) logged: error: Failed to load resource: 404 (Not Found)
```

**The one FAIL is pre-existing and unrelated.** It is the identical 404 on the
identical copied session recorded in `KAN-4-smoke-results.md` and
`KAN-10-smoke-results.md`; the check exercises dsh's session-format conversion on
a copied production session, not kanban. `ui` is the check that matters for this
change (the client half is live browser React): the console is clean, no
`slot entry crashed`, and the Kanban page renders with the 0.7.0 client.

## `smoke --only kanban-recovery` — 8 PASS, 0 FAIL

The engine's auto-recovery regression, untouched by this change (it parks at
**implement**). Run standalone after the first pass below.

```
PASS kanban-recovery / lab route with a 48-token output budget is mounted under the implementer
       - continue-kicker 0.3.0 mounted with its kick service; lab restarted on the 48-token route
PASS kanban-recovery / capabilities reports the kick service - continueKicker=true worktree=true
PASS kanban-recovery / a halted implement turn is kicked by the engine and the ticket stays In flight
       - 3 auto_recovered events (max-tokens x3) over 25 active samples, parked in Working
         as 'turn failed in implement: max-tokens'
PASS kanban-recovery / the session carries exactly maxConsecutiveKicks kicks and no duplicates
       - 3 kicks, 4 turn ends (4 halts) in session session-4b69c2ed-…
PASS kanban-recovery / the ticket parks with the original halt once the guard declines
       - parked: turn failed in implement: max-tokens
PASS kanban-recovery / degraded: with continue-kicker unmounted the ticket parks directly
PASS kanban-recovery / degraded: capabilities says the service is absent - continueKicker=false
PASS kanban-recovery / degraded: one halt, no kicks, straight to Needs attention
       - parked: turn failed in implement: max-tokens, zero auto_recovered events
```

The **first** invocation of this module (run together with `boot,ui,sessions`)
failed 3 of its 8 checks: its probe ticket's *planner* agent spent the module's
whole 600 s budget reading the kanban package's own source instead of calling
`kanban_submit_plan`, so the ticket never reached the implement phase the module
instruments (`ticket KAN-20 never parked (last: working/plan)`; the plan span ends
`abandoned / host restarted mid-span`). That is model behaviour on the lab's
planner route, not this change — the same module is 8/8 standalone, and
`KAN-10-smoke-results.md` already documents this module as timing-sensitive and
flaky under load. Scenario B (the degraded path, which does not depend on the
kick loop) passed in both runs.

## Plugin-side checks

- `npm run check` in `dsh-plugins` on a bare clone (what CI runs): verify 0 errors
  / 0 warnings across 11 packages, Rules-of-Hooks gate 0 violations over 12 client
  files, 614 tests / 0 failures / 54 skipped (the host tests that need the dsh
  peers, which the `tests` job does not install).
- `node --test packages/kanban/test/*.test.mjs` with the dsh peers present:
  **109/109 pass** — the dispatch and action-tool tests only run when
  `@deepseek-ai/dsh-llm` / `-tools` / `-sandbox-policy` resolve.
- `node scripts/compose-smoke.mjs kanban`: `ok dsh-kanban (imports, not skipped,
  layer + 1 row(s), profile wiring)`.
- `npm pack --dry-run` in `packages/kanban`: 29 files, `prompts/approval.md`
  included, no test or local files.
- CI on [PR #55](https://github.com/chrisjohnson/dsh-plugins/pull/55): contract
  pass, tests pass on Node 20.9.0 / 22 / 24, compose pass; merged as `bbdadb5`,
  tagged `dsh-kanban-v0.7.0`.

## Lab teardown

`lab.sh unlink kanban` **fails on this lab** (the lab clone's HEAD `6944436` has
no `dsh-kanban` pin at all — the pin lives on the deploy branch), the same
limitation noted in `KAN-10-smoke-results.md`. The pin was therefore restored by
hand per the `AGENTS.md` lab recipe: both lab manifests set back to the
`dsh-kanban-v0.7.0` git-tag spec, `pnpm install` in the lab root and in
`.dsh/profiles/web`, both trees verified at 0.7.0, then `lab.sh down`. The lab is
left stopped and unlinked.
