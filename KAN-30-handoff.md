# KAN-30 handoff — plan-time sandbox grants, and what still needs the human

## What shipped

`dsh-kanban` 0.16.0 → 0.16.1 (review round 1) → 0.16.2 (round 2) → **0.16.3**
(round 3), tag `dsh-kanban-v0.16.3` at dsh-plugins `7bc810f` (merge of PR #77).
Pinned in both manifests (`package.json`, `.dsh/profiles/web/package.json`),
installed in both trees, live checkout at `c585e16`.

The feature: a plan may declare `sandbox.grants` (absolute write paths outside
the workspace root, token-prefix bash commands) plus `sandbox.checks` (the
read-only `test -w` probes behind each path). A plan that declares grants parks
as *Plan ready* and the human's **Approve plan** click is the one-time grant; a
build-session listener then answers exactly those escalation asks with
`allowed-once` and records a `grant_applied` event. Everything else still asks.

Three review rounds were spent on the denylist, each closing what the previous
one left open:

- 0.16.0 read only the line's **first token** — a `git push` grant covered
  `git push && systemctl restart dsh`.
- 0.16.1 read the first token of every `&&`/`;`/`|` **segment** — the same grant
  still covered `git push && (systemctl restart dsh)`,
  `git push && $(systemctl restart dsh)` and `git push && FOO=1 systemctl
  restart dsh`.
- 0.16.2 is **word-based**: the command is split on whitespace and on
  `( ) { } $` backtick `; | &` and newlines, and if ANY resulting word (basename,
  quotes stripped) is `systemctl`, `service`, `launchctl`, `sudo`, `kill`,
  `pkill`, `rm` or `dd`, the whole call is denied and the human is asked. A plan
  declaring such a grant is rejected at submission. It compared exact spellings,
  so `git push && \systemctl restart dsh` still got through.
- 0.16.3 strips **backslashes** with the quotes, so `\systemctl`, `sys\temctl`
  and `\rm` read as the commands they run.

**The residual, stated plainly because no text rule can close it.** The denylist
is a matcher, not a sandbox, and three routes stay open by construction: an
**interpreter** (a bare `node`, `python3`, `perl` or `bash script.sh` grant hands
the build whatever that interpreter runs), an **encoded payload**
(`echo <base64> | base64 -d | sh` hides its words from any matcher), and
**indirection** (a granted command reading a script or config the build wrote
inside the workspace). Closing them needs the sandbox itself to resolve the exec
— core work, outside this plugin — so the control is the human reading the plan:
read an interpreter grant as a full-access grant. The rule also over-strictly
catches a denylisted word that is not a command (`grep -r rm -n .`,
`git commit -m "rm old path"`): those now prompt. That is the intended direction
to err in.

## Service state — one restart is still owed

The build never touched the service. The fingerprint taken before the build
started was `MainPID=2975411`, `ActiveEnterTimestamp=Mon 2026-11-02 18:06:44
UTC`, `InvocationID=d7307f0871304010b5b6db3719ab389d`.

**Chris restarted production at 21:31:25 UTC** (12 s after the round-2 build
turn ended; `NRestarts=0`, and no `systemctl`/`sudo`/`restart` call exists in
any agent session log), so the service currently running is:

- `MainPID=4142753`
- `ActiveEnterTimestamp=Mon 2026-11-02 21:31:25 UTC`
- `InvocationID=64069b41a4a646f098693c2b04f77043`

That boot picked up **0.16.1**, not 0.16.3. The 0.16.3 pin is installed on disk
in both trees and verified there (`src/grants.mjs` in both is byte-identical to
the tag, and probing the installed module denies every shell-clothing and
backslash form while still granting `git push origin main`), but it takes effect
only after one more planned restart:

```sh
sudo systemctl restart dsh    # Chris, in a planned window — never grantable
```

Before it, `systemctl show dsh -p MainPID -p ActiveEnterTimestamp` should still
read 4142753 / 21:31:25; after it, a new PID and a new timestamp, and
`node -p "require('/home/dsh/dsh-deploy/node_modules/dsh-kanban/package.json').version"`
(0.16.3 on disk already) is what the new process will be running.

Rollback, if the word rule turns out to prompt too much in practice: pin
`dsh-kanban-v0.16.1` in both manifests, reinstall both trees, restart in a
planned window — and know that 0.16.1 and 0.16.2 each carry a denylist hole that
0.16.3 closes.

## Verification trail

- Clone `/home/dsh/dsh-deploy/.dsh-worktrees/kan30-plugins` at `7bc810f`:
  `npm run check` → verify 0 errors, hook gate clean, **836/836 tests, 0 fail**;
  `node scripts/compose-smoke.mjs` → 11/11; `npm pack --dry-run` lists
  `src/grants.mjs` (20.7 kB, 34 files) at 0.16.3.
- Lab evidence (rounds 0.16.0/0.16.1, under
  `.dsh-worktrees/kan30-deploy/.lab/kan30-evidence/`): smoke `ui,completion`
  8 PASS / 0 FAIL; the grants e2e 8 PASS — a granted out-of-workspace write was
  answered `allowed-once` with a `grant_applied` event and no human, an
  ungranted one was not auto-approved and never wrote its file. Note the plan's
  literal "no `approval/asked` event" wording is unsatisfiable plugin-only:
  `dsh-user-approval` appends that event before the waterfall runs. Not re-run
  for 0.16.2/0.16.3: each change only narrows what the approver answers, and the
  shipped module was probed directly instead.
- Live checkout: `pnpm run check` → `check-no-links: ok`, exit 0; both trees
  report 0.16.3 with `Approve plan`, `Sandbox grants`, `approvePlan` and
  `makeGrantApprover` present.
