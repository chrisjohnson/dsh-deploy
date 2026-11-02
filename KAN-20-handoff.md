# KAN-20 — model activity subagents: dsh-model-capacity 0.4.0 released and pinned; the production pull + restart remain

**Status: released, pinned and installed in this ticket's worktree.** The plugin
change is merged and tagged in `dsh-plugins`, both manifests here pin the new
tag, both install trees carry it, and every pre-restart assertion in section 2
passed. **Nothing in production has been touched**: `/home/dsh/dsh-deploy` is
still on the old pin on disk and still *runs* 0.3.0 in memory. Section 3 is the
deploy, and its last step — the service restart — is a human one in a planned
window.

| thing | where | state |
| --- | --- | --- |
| plugin change | [PR #73](https://github.com/chrisjohnson/dsh-plugins/pull/73) — `7920289` (change) + `54afa62` (release bump) | **merged**, merge commit `e7f762d4da11daaf6cc8be6fd535a2bdd66ce880` |
| release tag | `dsh-model-capacity-v0.4.0` → `e7f762d4da11daaf6cc8be6fd535a2bdd66ce880` | **pushed** (`git ls-remote` prints that one sha; it is `origin/main` HEAD) |
| this repo's pin | `package.json` + `.dsh/profiles/web/package.json` | both read `#dsh-model-capacity-v0.4.0`; root `pnpm-lock.yaml` regenerated |
| deployment config | `.dsh/profiles/web/cordis.patch.yml` | `model-capacity` row trimmed (section 2, A5) |
| **this worktree** | `.dsh-worktrees/warm-birch` | both trees installed at 0.4.0, `pnpm run check` ok, assertions in section 2 |
| **production checkout** | `/home/dsh/dsh-deploy` | **not pulled** — still 0.3.0 on disk (deliberate: outside this session's sandbox, and it belongs to the planned window) |
| **production service** | `dsh` unit | **not restarted** — still running 0.3.0 in memory |

## What the change is

`dsh-model-capacity` had two admission paths for one resource. The `llm/stream`
gate queued every model call per provider FIFO, and a separate **preflight**
intercepted `subagent`, `subagent_fork` and `spawn_teammate` before the tool
ran: it guessed the child's route, took a reservation that occupied a slot,
**denied the dispatch with a model-visible capacity error** when the bucket was
full, and handed the reservation to the child's first main call so it could skip
the queue it had just been told not to join.

The preflight is gone; the gate is the whole mechanism.

- `src/guard.mjs` deleted, with the `tools.guard` registration and its disposer.
- The reservation lifecycle is out of `src/semaphore.mjs`: `reserve`, `bindChild`,
  `consumeReservation`, `cancelReservation`, `cancelReservationByCallId`,
  `expireReservations`, `releaseForSession`, the per-bucket reservation set,
  `reservationTtlMs`. `used()` and `freeSlots()` are active-only; `snapshot()`
  carries no reservations.
- `src/gate.mjs` always acquires and releases; the auxiliary-call branch that
  kept a title or compaction call from consuming a reservation is gone.
- `src/host.mjs` lost the `session/created`, `session/disposed` and
  `session/event(tool/result)` listeners and the 5 s expiry timer — all of it
  existed to clean up reservations whose child never arrived — plus
  `dismissReservation` (method, endpoint, snapshot decoration) and
  `reservationTtlMs` in the config watcher.
- `src/config.mjs`: `reservationTtlMs` and `subagentTools` removed from
  `DEFAULT_CONFIG` and from validation.
- `src/client.mjs`: the Reservations KPI, the reservation cards and their
  Dismiss action are gone (KPI grid 3 → 2 columns). No hook was added or
  removed in any component, so no slot entry's hook order moved.

**Why.** A dispatch is not an inference call. What the plugin protects is the
hardware behind a provider route, and every request that reaches it already
passes through this gate — a subagent child's included. The preflight was a
second admission path that could jump the queue the gate exists to enforce, and
its "honest capacity statement" was a guess about a route the child might not
use.

## Documented behavior change

- **Dispatching a subagent can no longer fail with a capacity error.** A child
  whose provider is busy waits in the per-provider FIFO (no queue timeout,
  bounded by `queueLimitPerProvider: 1000`), and the parent sees the subagent
  tool as *running* for the child's whole wait + run time.
- Nothing holds a slot unless a stream is live on it, so a child that never
  materialises costs nothing and needs no TTL cleanup.
- A deployment that still sets `reservationTtlMs` or `subagentTools` boots with
  one `unknown config key "…" (ignored)` warning per key instead of refusing the
  config. Production's row is trimmed in this commit, so it will log nothing.

## Verification already done

Repo checks on the release branch (`npm run check` = verify + hooks gate + all
suites, run from a path with no ancestor `node_modules`, which is how CI sees it):

```text
verify:             0 error(s), 0 warning(s) across 11 package(s)
check-plugin-hooks: checked 12 client file(s): 0 violation(s), 0 warning(s)
tests:              792 tests, 698 pass, 0 fail, 94 skipped
                    (the skips are the dsh-peer-gated suites, identical on main)
compose-smoke:      ok dsh-model-capacity (imports, not skipped, layer + 1 row(s), profile wiring)
npm pack --dry-run: dsh-model-capacity-0.4.0.tgz, 11 files, no guard.mjs, no tests
```

All five CI jobs on PR #73 (compose, contract, tests on node 20.9.0 / 22 / 24)
were green before the merge.

Released source, checked on the tag itself:

```text
$ grep -r -i -c 'reservation\|subagentTools\|guard' packages/model-capacity/src/
  gate.mjs:0  host.mjs:0  client.mjs:0  semaphore.mjs:0  config.mjs:0
$ ls packages/model-capacity/src/guard.mjs
  No such file or directory
```

### Lab smoke (`warm-birch` lab, plugin linked to the release branch)

Full smoke, final run: **40 PASS, 8 FAIL, 0 SKIP** in
`.lab/default/.lab/smoke/RESULTS.md` (the plan's literal check,
`grep -c '^FAIL' RESULTS.md`, is 0 — the file is a markdown table, so failures
start with `| `). Every module that exercises the gate passed: `boot`, `ui`
(including "no `slot entry crashed` or React errors in the console"),
`completion`, `webp`, `model-switch`, `scheduled-queue`, `continue-kicker`,
`kanban-recovery` and `image-search`'s model turn. **Every one of those model
turns went through the new gate** — it is on `llm/stream` globally and cannot be
bypassed — so the FIFO path is proven against real traffic, not just unit tests.

The 8 FAIL rows, each with its cause:

| check | cause |
| --- | --- |
| boot / lab process is isolated from production | `/proc/<lab pid>/environ: EACCES`. The box has `kernel.yama.ptrace_scope = 1`, so a process can read the environ of only its own descendants; the lab server is reparented to init. **Unfixable from a session, and it hits every worktree lab today** — the same line is in `calm-clover`'s (18:00) and `kan30`'s (20:32) results. |
| web-search / SearXNG answers a JSON query | same `/proc` read (the check pulls `SEARXNG_BASE_URL` off the lab process). SearXNG itself answers fine: `curl 127.0.0.1:8091/search?format=json` → 200 in 0.4 s. |
| image-search / SearXNG answers an image query | same `/proc` read. |
| sessions / reopen 4 of them | `session-009cb19e…` logs a 404 on one resource. **Identical row, same session id, in the sibling `kan30` lab** (a different plugin), so it is a property of the copied production state, not of this change. |
| web-search / the reply lists no URL | model-behaviour flake: a standalone `smoke --only web-search` run passed it ("tool call visible, reply lists URLs"). |
| loop-watchdog / evals panel renders a copied session | Playwright `locator.click` timeout at 15 s under load (box load average ~4 with three labs and a sibling smoke running). |
| loop-watchdog / a row carries the real tool-result text | consequence of the row above: the lab runs the watchdog observe-only and every step was skipped. |
| worktree / `worktree_convert` moves a session | "check timed out after 180 s" — the heaviest model-turn check on a loaded box; it passed in the earlier run of the same suite. |

None of the failures names `model-capacity`, and none is in a path this change
touches.

### Activity panel, checked in a real browser against the lab

The client half is the riskiest surface (live React, no build step), so the panel
was opened directly in the lab with the linked 0.4.0 code:

```text
title:            Activity
kpiLabels:        ["Active leases", "Queued calls"]        # Reservations KPI gone
kpiValues:        ["0", "0"]
sectionHeads:     Active/Queue per provider, 3 provider cards, no Reservations section
providerCards:    3
slotErrors:       0
mentionsReservations: false
console problems: []
```

## 1. Already done — release and pin

### 1a. Merged and tagged

[PR #73](https://github.com/chrisjohnson/dsh-plugins/pull/73) merged into
`dsh-plugins` `main` as `e7f762d4da11daaf6cc8be6fd535a2bdd66ce880`; the
lightweight tag was cut on that merge commit per `docs/releasing.md`:

```text
refs/tags/dsh-model-capacity-v0.4.0 -> e7f762d4da11daaf6cc8be6fd535a2bdd66ce880
```

### 1b. Pin bumped in both manifests, both trees installed here

`package.json` and `.dsh/profiles/web/package.json` both moved
`dsh-model-capacity-v0.3.0` → **`v0.4.0`**, `pnpm install --no-frozen-lockfile`
regenerated the root `pnpm-lock.yaml` (6 lines), and both trees were installed
in this worktree — root and `.dsh/profiles/web` — because a root-only install
silently leaves the browser half on the old tag.

### 1c. Config row trimmed

`.dsh/profiles/web/cordis.patch.yml`'s `model-capacity` row no longer carries
`reservationTtlMs: 300000` or the `subagentTools` list; `enabled`,
`defaultMaxConcurrent`, `limits` and `queueLimitPerProvider: 1000` stay. The
comment block above the row now says a subagent child's calls wait in the same
FIFO. `plugins/` was added to `.gitignore` (the dev-time `dsh-plugins` clone
this ticket worked from is not content of this repo).

## 2. Pre-restart assertions — DONE in this worktree

```text
A1 both trees carry 0.4.0:
   node_modules/dsh-model-capacity/package.json:            "version": "0.4.0",
   .dsh/profiles/web/node_modules/dsh-model-capacity/…:     "version": "0.4.0",

A2 profile client half is the new code:
   grep -c 'dismissReservation' .dsh/profiles/web/node_modules/dsh-model-capacity/src/client.mjs  → 0
   grep -c 'repeat(2,minmax(0,1fr))' (0.4.0-only KPI grid)                                        → 1
   grep -r -i -c 'reservation|subagentTools|guard' …/src/  → 0 in every file

A3 manifests:
   grep -n 'dsh-model-capacity' package.json .dsh/profiles/web/package.json → v0.4.0 in both

A4 pnpm run check:
   check-no-links: ok (4 files checked)   (exit 0)

A5 config row:
   sed -n '/- id: model-capacity/,/^[^ ]/p' .dsh/profiles/web/cordis.patch.yml
     reservationTtlMs: absent   subagentTools: absent
     enabled: true   defaultMaxConcurrent: 1   limits: 3 entries   queueLimitPerProvider: 1000
```

## 3. Production deploy — Chris, planned window

A session running on the production service cannot restart it: a restart ends
every session in it, including the one doing the restart. Everything below is
one window; the pull and the installs are safe to run while sessions are live,
the restart is not.

```sh
cd /home/dsh/dsh-deploy
git pull --ff-only origin main     # the pin + config + handoff commit
pnpm install                       # root tree (host half)
cd .dsh/profiles/web && pnpm install   # the tree dsh serves the client half from
cd /home/dsh/dsh-deploy && pnpm run check

# re-run section 2's assertions here and expect the same output:
grep -m1 '"version"' node_modules/dsh-model-capacity/package.json \
                       .dsh/profiles/web/node_modules/dsh-model-capacity/package.json
grep -c 'dismissReservation' .dsh/profiles/web/node_modules/dsh-model-capacity/src/client.mjs
sed -n '/- id: model-capacity/,/^[^ ]/p' .dsh/profiles/web/cordis.patch.yml

# then, when the board is quiet (a blue, glowing card is a turn running):
sudo systemctl restart dsh
```

## 4. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i 'model-capacity\|capacity'
# expect: dsh-model-capacity: applied: limits={"local-ai-machine (apu)":3,…} default=1
# and NO `unknown config key` warning (the row no longer carries the removed keys)
```

Then in the GUI (:3081) — **hard-reload the tab first**; the client half is
snapshotted at boot:

- **Activity panel**: two KPI cards (Active leases, Queued calls), no
  Reservations card, no reservation sections, provider cards with Active/Queue
  only. Console clean: no `slot entry crashed in '…'`, no `Minified React error`.
- **A queued subagent**: start a session while the APU is at 3 concurrent calls
  and dispatch a subagent on it. The dispatch must **not** return a capacity
  error; the child's session starts and its first call appears in the Activity
  queue for that provider, behind whatever is already waiting. The parent sees
  the subagent tool as running the whole time.
- **The composer dock** still shows the waiting session's position with **Cancel
  turn**, and the turn-tail wait card still records the wait.

## Rollback

Pin the previous tag, reinstall both trees, restart in a planned window:

```sh
cd /home/dsh/dsh-deploy
git revert <pin commit>   # or edit both manifests back to dsh-model-capacity-v0.3.0
pnpm install
cd .dsh/profiles/web && pnpm install
pnpm run check
# then: sudo systemctl restart dsh   (Chris, planned window)
```

The 0.3.0 config keys it would restore (`reservationTtlMs`, `subagentTools`) are
still in git history next to this commit if a rollback wants the old row
verbatim. Rolling back returns the preflight: subagent dispatch can fail with a
capacity error again, and the Reservations surface reappears.

## Two box notes for Chris

1. **`kernel.yama.ptrace_scope = 1` breaks three lab-smoke checks.** Anything
   that reads `/proc/<pid>/environ` of a process it did not spawn fails with
   EACCES: `scripts/lab.sh`'s own production-launch read (worked around here
   with `LAB_FORCE_UNIT_FALLBACK=1`, which the script supports) and the smoke's
   boot-isolation and SearXNG checks. Every worktree lab today shows these
   FAILs, so a green `lab.sh smoke` is currently unreachable without either
   relaxing yama or teaching those checks a fallback.
2. **`~/.npm/_cacache` contains root-owned files**, so `npm pack` (used by
   `lab.sh link`'s pack check and by `npm pack --dry-run`) fails with EACCES.
   `npm_config_cache=/tmp/npm-cache-dsh` sidesteps it; the permanent fix npm
   itself suggests is `sudo chown -R 1002:990 /home/dsh/.npm`.
