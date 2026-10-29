# KAN-4 — continue-kicker ↔ kanban recovery: deploy + restart handoff

Shipped in `dsh-plugins` (both PRs merged, both tags cut on their merge commits):

| package | tag | merge commit | what it adds |
| --- | --- | --- | --- |
| dsh-continue-kicker | `dsh-continue-kicker-v0.3.0` | `44c713c` | a provided `continueKicker` service: `kick(sessionId, { bypassCooldown })` runs the plugin's own `decide()` and sends the kick, so another plugin can ask for recovery under the same policy instead of duplicating it. `decide()` also gained `knownKicks`, which stops the event-log lag from buying an extra kick when requests come back to back. |
| dsh-kanban | `dsh-kanban-v0.4.4` | `9c5a79c` (pin) | when a plan/implement/review turn halts, the engine asks that service for one kick, waits for the turn it starts (`driver.waitTurn`), and keeps the ticket In flight; it parks with the original failure only when the halt is not kickable, the runaway guard declines, the waited turn stalls, or the session is disposed. |

Pinned in dsh-deploy `main`: `3c8623d` (0.3.0 + 0.4.0), `6b0549b` (re-pin to
0.4.3), then `9c5a79c` moved kanban to **v0.4.4** (a concurrent session's
archived-session fix, which contains all of the KAN-4 code).

**Do not pin dsh-kanban 0.4.0, 0.4.1 or 0.4.2.** Those tags are permanent and all
three carry the stale-settle defect: a recovery waiter could be settled by the
*previous* turn's `turn/end` (the session log lags the halt), so the engine
kicked again, a real turn was in flight when the guard declined, and the busy
guard refused to park - every tick relaunched the phase (9 kicks where the cap is
3, parked as `attempt budget exhausted (3)`). 0.4.3 fixed it by pinning each
waiter to the turn the engine actually watched end, and by waiting one beat after
the halt before asking for a kick, because a follow-up admitted while the agent
is still inside its turn has its wake dropped and never starts a turn. No new
config keys in either plugin: the budget is the existing `maxConsecutiveKicks: 3`
on this deployment's row.

## What changes for Chris

A kanban session that halts on max-tokens / an error / a crash no longer sits
asleep in Needs attention until you open it in the browser and continue-kicker
wakes it by accident. The engine wakes it itself, up to 3 times, and only parks
when continue-kicker's runaway guard says the kicks are not helping. The park
reason is unchanged (`turn failed in implement: max-tokens`), and each recovered
turn shows on the ticket timeline as an `auto_recovered` event plus a
`<phase>-continuation` span with its own token usage.

Interactive sessions are untouched: the watcher and the `agent/created` door are
the same code paths they were in 0.2.0.

## 1. Update the live checkout (needs write access to `/home/dsh/dsh-deploy`)

**The root install is not enough.** dsh resolves a profile's plugin row from the
*profile* installation, and `.dsh/profiles/web` is its own pnpm project with its
own lockfile. This was demonstrated on the live box: the root tree was updated to
0.3.0 / 0.4.4 at 03:01:57 and the service was restarted at 03:20:52, yet the
journal still logged the 0.2.0 boot line, because
`.dsh/profiles/web/node_modules` still held 0.2.0 / 0.3.7 (its lockfile still
resolved `1bd5409` = v0.2.0 and `e8b673b` = v0.3.7). Installing the profile
directory fixes both the lockfile and the tree - verified in a throwaway copy of
the live profile manifests, which resolved to 0.3.0 / 0.4.4.

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin main  # -> 9c5a79c or later
grep -n 'dsh-kanban\|dsh-continue-kicker' package.json .dsh/profiles/web/package.json
# all four lines must read dsh-continue-kicker-v0.3.0 and the pinned dsh-kanban

pnpm install                    # root tree
cd .dsh/profiles/web && pnpm install && cd -   # the tree dsh actually loads from

pnpm run check                                    # check-no-links: ok

# PRE-RESTART ASSERTION - do not restart until this reads the new versions:
grep -m1 '"version"' \
  .dsh/profiles/web/node_modules/dsh-continue-kicker/package.json \
  .dsh/profiles/web/node_modules/dsh-kanban/package.json
# expect: dsh-continue-kicker 0.3.0, dsh-kanban 0.4.4
# If either still reads 0.2.0 / 0.3.x, the profile install did not take: re-run
# `pnpm install` inside .dsh/profiles/web (it is a standalone pnpm project) and
# check that .dsh/profiles/web/pnpm-lock.yaml resolves the new tags.
```

## 2. Production restart — Chris, planned window only

A restart ends every session running in the service, including any agent session
on this box. Do not run it from a session.

```sh
sudo systemctl restart dsh
```

## 3. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i "continue-kicker"
journalctl -u dsh --since "-3 min" --no-pager | grep -i "auto-recovery"
```

Expected lines:

```
INFO continue-kicker continue-kicker active (logToStderr=true, ..., maxConsecutiveKicks=3, ...); kick service v1 provided
INFO dsh-kanban auto-recovery available: dsh-continue-kicker kick service v1
```

Two ways this can come back wrong, and what each one actually means:

- **The `continue-kicker active` line has no `; kick service v1 provided`
  suffix.** Production is still executing 0.2.0. That is a stale *profile*
  install, not a missing bundle row: `.dsh/profiles/web/node_modules` was not
  refreshed (see section 1). This is exactly what the live box showed after the
  03:20:52 restart.
- **`dsh-kanban ... dsh-continue-kicker not mounted; halted turns park to
  needs-attention without auto-recovery`.** kanban is new enough to look for the
  service and did not find it, so the usual cause is the same one - a stale
  continue-kicker in the profile tree - with a missing bundle entry in
  `.dsh/profiles/web/package.json` as the second possibility. Check the
  pre-restart assertion in section 1 before anything else.

Note that kanban logs nothing at that level unless its own logger is reaching
the journal; if you see no `dsh-kanban` lines at all, judge the integration from
the capabilities endpoint below rather than from the absence of a boot line.

The HTTP surface needs the same auth as the rest of the GUI, so a bare `curl`
gets 401. Exchange the access URL's token for a cookie first (verified working
against the lab):

```sh
TOKEN=<the ?token= value you use to open the GUI>
JAR=$(mktemp)
curl -s -c "$JAR" -o /dev/null "http://127.0.0.1:3081/?token=$TOKEN"
curl -s -b "$JAR" -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:3081/api/kanban/capabilities
# expect {"ok":true,"value":{"worktree":true,"continueKicker":true}}
```

Or skip curl and run it from the GUI's devtools console:

```js
fetch('/api/kanban/capabilities', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.json()).then(console.log)
```

Then the behavioural check: an interactive session that crashes mid-turn must
still get exactly one kick (that is what `lab.sh smoke --only continue-kicker`
proves in the lab), and a kanban ticket whose implement turn halts should show
`auto_recovered` events while it stays In flight.

## 4. Rollback

Pin the previous tags in **both** manifests, reinstall, restart in a planned window:

```sh
cd /home/dsh/dsh-deploy
for f in package.json .dsh/profiles/web/package.json; do
  node -e "
    const fs=require('fs'), p=process.argv[1], j=JSON.parse(fs.readFileSync(p,'utf8'));
    j.dependencies['dsh-continue-kicker']='git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-continue-kicker-v0.2.0&path:/packages/continue-kicker';
    j.dependencies['dsh-kanban']='git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-kanban-v0.3.7&path:/packages/kanban';
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  " "$f"
done
pnpm install
(cd .dsh/profiles/web && pnpm install)     # the tree dsh loads from - same gap as section 1
pnpm run check
# same pre-restart assertion as section 1, now expecting 0.2.0 / 0.3.7
grep -m1 '"version"' \
  .dsh/profiles/web/node_modules/dsh-continue-kicker/package.json \
  .dsh/profiles/web/node_modules/dsh-kanban/package.json
git add package.json .dsh/profiles/web/package.json pnpm-lock.yaml .dsh/profiles/web/pnpm-lock.yaml
git commit -m "Roll back KAN-4: pin continue-kicker 0.2.0 / kanban 0.3.7"
git push origin main            # fast-forward
sudo systemctl restart dsh      # planned window
```

A safe intermediate state exists: kanban 0.4.0 on top of continue-kicker 0.2.0
simply finds no service and behaves exactly as 0.3.7 (feature off by absence).

## 5. Evidence already captured

- `npm run check` in dsh-plugins: verify 0 errors, hooks gate 0 violations,
  571 tests pass (10 new kanban recovery tests, 2 new continue-kicker tests,
  4 dispatch activity/waiter tests).
- `node scripts/compose-smoke.mjs continue-kicker kanban`: 2/2 composed.
- Both tag specs install for real (`pnpm add` from the tag in a scratch project).
- The profile-install gap in section 1 was reproduced and its fix verified: a
  throwaway copy of the live `.dsh/profiles/web` manifests resolved
  `dsh-continue-kicker 0.3.0` and `dsh-kanban 0.4.4` after `pnpm install` in that
  directory, where the untouched live profile tree still resolves 0.2.0 / 0.3.7.
- Lab `kan4` (`/tmp/dsh-lab-kan4/kan4`, port 3099), new module
  `scripts/lab-smoke/modules/kanban-recovery.mjs`, run against the merged main
  (kanban 0.4.4 + continue-kicker 0.3.0): 8/8 PASS with a lab-only 48-token route
  under the implementer — 3 `auto_recovered` events while the ticket stayed In
  flight, exactly 3 kick messages in the session log (no watcher duplicates),
  parked as `turn failed in implement: max-tokens`; the degraded run with the
  bundle removed parked directly with zero `auto_recovered` events and
  `continueKicker:false` from the capabilities endpoint.
- The first recovery run exposed the log-lag defect (4 kicks where the cap was
  3); `knownKicks` fixed it and the re-run came back at exactly 3.

### Known lab-only failures (not regressions from this ticket)

`sessions / reopen 4 of them` fails on one copied production session:

```
FAIL sessions / reopen 4 of them (old-format ones convert on disk) -
'Adjust big-moe context to 512k' (session-009cb19e-bf9e-4f99-8d2e-390b6dc3894d)
logged: error: Failed to load resource: the server responded with a status of
404 (Not Found)
```

That session's workspace is `/home/dsh/dsh-deploy` — the production checkout,
which the lab copies by reference and cannot serve resources from. The repo's own
`AGENTS.md` already flags production-workspace sessions as a hazard for this
module. It fails **identically on the released pins** (continue-kicker 0.2.0 /
kanban 0.3.6, nothing linked), so it predates KAN-4 and is not caused by it.

Making the module skip production-workspace sessions was tried and rejected: the
old-format sessions this gate exists to exercise live in that checkout, so the
skip took the candidate list from 26 to 1 and turned a red check into a hollow
green one. Left red and named instead.

`continue-kicker` needs a free GPU backend: a concurrent `llm_decode_bench` run
makes the model fail to start streaming within 180 s and the module reports a
timeout. Two stale assumptions in that module were fixed here (commit `6122e36`
and this round): the sidebar row shows the model-generated title rather than the
prompt's first words, and the model now solves "write the integers 1..4000" with
a single tool call and finishes before the kill lands, so the prompt says to type
them in the reply and use no tool. The reopen check now reads the killed
session's own event log instead of scraping the page's inner text, and the module
prunes its own leftovers from earlier runs while the server is down for the kill.



### Final smoke table (copied out of `<lab>/.lab/smoke/RESULTS.md` so it survives the lab)

Source: lab `kan4` on :3099, started 2026-10-29T04:22:41.427Z
Run: `scripts/lab.sh smoke --only sessions,continue-kicker,kanban-recovery`, the last smoke action of the round,
against the merged main (dsh-kanban 0.4.4 + dsh-continue-kicker 0.3.0 linked from origin/main).

**12 PASS, 1 FAIL, 0 SKIP**
| module | check | status | seconds | detail |
| --- | --- | --- | --- | --- |
| sessions | find cleanly-ended copied sessions | PASS | 7.1 | 26 candidates (24 still in the old format) |
| sessions | reopen 4 of them (old-format ones convert on disk) | FAIL | 10.7 | 'Adjust big-moe context to 512k' (session-009cb19e-bf9e-4f99-8d2e-390b6dc3894d) logged: error: Failed to load resource: the server responded with a status of 404 (Not Found) [screenshot: /tmp/dsh-lab-kan4/kan4/.lab/smoke/shots/FAIL-sessions-reopen_4_of_them_old_format_ones_convert.png] |
| continue-kicker | start a long turn and kill the server in the middle of it | PASS | 3.7 | SIGKILL mid-stream; kept session-a1e081e3, pruned 1 leftover session(s) from earlier runs |
| continue-kicker | start the lab again | PASS | 2.3 | running again, boot verification clean |
| continue-kicker | reopening the session sends exactly one kick, and no more | PASS | 75.2 | exactly 1 kick in session-a1e081e3… (turn ends: interrupted), none in the next 75 s |
| kanban-recovery | lab route with a 48-token output budget is mounted under the implementer | PASS | 2.9 | continue-kicker 0.3.0 mounted with its kick service; lab restarted on the 48-token route |
| kanban-recovery | capabilities reports the kick service | PASS | 0.0 | continueKicker=true worktree=true |
| kanban-recovery | a halted implement turn is kicked by the engine and the ticket stays In flight | PASS | 58.7 | 3 auto_recovered events (max-tokens, max-tokens, max-tokens) over 58 In-flight samples, parked as 'turn failed in implement: max-tokens' |
| kanban-recovery | the session carries exactly maxConsecutiveKicks kicks and no duplicates | PASS | 0.0 | 3 kicks, 4 turn ends (4 halts) in session session-4ddb013c-906c-43f7-8902-0da4e015c27e |
| kanban-recovery | the ticket parks with the original halt once the guard declines | PASS | 0.0 | parked: turn failed in implement: max-tokens |
| kanban-recovery | degraded: with continue-kicker unmounted the ticket parks directly | PASS | 2.9 | lab restarted with the continue-kicker bundle removed |
| kanban-recovery | degraded: capabilities says the service is absent | PASS | 0.0 | continueKicker=false |
| kanban-recovery | degraded: one halt, no kicks, straight to Needs attention | PASS | 90.1 | parked: turn failed in implement: max-tokens, zero auto_recovered events |

## 6. Lab cleanup

The lab is disposable and lives outside production:

```sh
cd /home/dsh/dsh-deploy/.dsh-worktrees/fleet-cinder
LAB_FORCE_UNIT_FALLBACK=1 LAB_ROOT=/tmp/dsh-lab-kan4 LAB_NAME=kan4 scripts/lab.sh down
rm -rf /tmp/dsh-lab-kan4 /tmp/dpl
```

`lab.sh status` shows `dsh-continue-kicker` and `dsh-kanban` LINKED to
`/tmp/dpl`; that checkout is gone after the cleanup, so nothing else can pick it up.
