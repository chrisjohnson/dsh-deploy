# KAN-4 — continue-kicker ↔ kanban recovery: deploy + restart handoff

Shipped in `dsh-plugins` (both PRs merged, both tags cut on their merge commits):

| package | tag | merge commit | what it adds |
| --- | --- | --- | --- |
| dsh-continue-kicker | `dsh-continue-kicker-v0.3.0` | `44c713c` | a provided `continueKicker` service: `kick(sessionId, { bypassCooldown })` runs the plugin's own `decide()` and sends the kick, so another plugin can ask for recovery under the same policy instead of duplicating it. `decide()` also gained `knownKicks`, which stops the event-log lag from buying an extra kick when requests come back to back. |
| dsh-kanban | `dsh-kanban-v0.4.3` | `78f2794` | when a plan/implement/review turn halts, the engine asks that service for one kick, waits for the turn it starts (`driver.waitTurn`), and keeps the ticket In flight; it parks with the original failure only when the halt is not kickable, the runaway guard declines, the waited turn stalls, or the session is disposed. |

Pinned in dsh-deploy `main` as `6b0549b` (both manifests + lockfile).

0.4.1/0.4.2/0.4.3 are follow-on fixes the lab smoke caught after 0.4.0 merged on
top of the concurrent 0.3.7: a recovery waiter could be settled by the *previous*
turn's end (the session log lags the halt), which made the engine kick again,
left a real turn in flight when the guard declined, and the busy guard then
refused to park - so every tick relaunched the phase (9 kicks where the cap is 3,
parked as `attempt budget exhausted (3)`). 0.4.3 also waits one beat after the
halt before asking for a kick, because a follow-up admitted while the agent is
still inside its turn has its wake dropped and never starts a turn. No new config keys in either plugin: the budget is the
existing `maxConsecutiveKicks: 3` on this deployment's row.

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

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin main  # -> 3c8623d
grep -n 'dsh-kanban\|dsh-continue-kicker' package.json .dsh/profiles/web/package.json
# all four lines must read v0.4.0 / v0.3.0
pnpm install
pnpm run check                  # scripts/check-no-links.mjs, must be ok
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

If instead you see `dsh-kanban ... dsh-continue-kicker not mounted; halted turns
park to needs-attention without auto-recovery`, the service did not reach kanban
(check that both plugins are in `.dsh/profiles/web/package.json` bundles).

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
pnpm install && pnpm run check
git add package.json .dsh/profiles/web/package.json pnpm-lock.yaml
git commit -m "Roll back KAN-4: pin continue-kicker 0.2.0 / kanban 0.3.7"
git push origin main            # fast-forward
sudo systemctl restart dsh      # planned window
```

A safe intermediate state exists: kanban 0.4.0 on top of continue-kicker 0.2.0
simply finds no service and behaves exactly as 0.3.7 (feature off by absence).

## 5. Evidence already captured

- `npm run check` in dsh-plugins: verify 0 errors, hooks gate 0 violations,
  566 tests pass (10 new kanban recovery tests, 2 new continue-kicker tests).
- `node scripts/compose-smoke.mjs continue-kicker kanban`: 2/2 composed.
- Both tag specs install for real (`pnpm add` from the tag in a scratch project).
- Lab `kan4` (`/tmp/dsh-lab-kan4/kan4`, port 3099), new module
  `scripts/lab-smoke/modules/kanban-recovery.mjs`, 8/8 PASS with a lab-only
  48-token route under the implementer: 3 `auto_recovered` events over 158
  In-flight samples, exactly 3 kick messages in the session log (no watcher
  duplicates), parked as `turn failed in implement: max-tokens`; degraded run
  with the bundle removed parked directly with zero `auto_recovered` events and
  `continueKicker:false` from the capabilities endpoint.
- The first recovery run exposed the log-lag defect (4 kicks where the cap was
  3); `knownKicks` fixed it and the re-run came back at exactly 3.
- Pre-existing lab failures, reproduced identically on the released pins
  (continue-kicker 0.2.0 / kanban 0.3.6) so they are not regressions:
  `sessions / reopen 4 of them` 404s on a copied production session whose
  workspace is the production checkout, and `continue-kicker` needs a free GPU
  backend (a `llm_decode_bench` run makes the model fail to start streaming in
  180 s). The module's stale sidebar selector (generated title vs prompt text)
  is fixed in `3c8623d`.

## 6. Lab cleanup

The lab is disposable and lives outside production:

```sh
cd /home/dsh/dsh-deploy/.dsh-worktrees/fleet-cinder
LAB_FORCE_UNIT_FALLBACK=1 LAB_ROOT=/tmp/dsh-lab-kan4 LAB_NAME=kan4 scripts/lab.sh down
rm -rf /tmp/dsh-lab-kan4 /tmp/dpl
```

`lab.sh status` shows `dsh-continue-kicker` and `dsh-kanban` LINKED to
`/tmp/dpl`; that checkout is gone after the cleanup, so nothing else can pick it up.
