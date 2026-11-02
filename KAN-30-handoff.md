# KAN-30 handoff — plan-time sandbox grants, and what still needs the human

## What shipped

`dsh-kanban` 0.16.0 → 0.16.1 (review round 1) → **0.16.2** (review round 2),
tag `dsh-kanban-v0.16.2` at dsh-plugins `df1a3e3` (merge of PR #76). Pinned in
both manifests (`package.json`, `.dsh/profiles/web/package.json`), installed in
both trees, live checkout at `bbfb7e0`.

The feature: a plan may declare `sandbox.grants` (absolute write paths outside
the workspace root, token-prefix bash commands) plus `sandbox.checks` (the
read-only `test -w` probes behind each path). A plan that declares grants parks
as *Plan ready* and the human's **Approve plan** click is the one-time grant; a
build-session listener then answers exactly those escalation asks with
`allowed-once` and records a `grant_applied` event. Everything else still asks.

Two review rounds were spent on the denylist, and the second is the one that
matters for anyone reading this file:

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
  declaring such a grant is rejected at submission.

**The residual limit, stated plainly because the denylist cannot close it:** it
is a text rule and cannot see inside an interpreter. A plan granting a bare
`node`, `python3`, `perl` or `bash script.sh` prefix hands the build whatever
that interpreter chooses to run, including a service restart reached through
code. Read an interpreter grant as a full-access grant when approving a plan.
The rule also over-strictly catches a denylisted word that is not a command
(`grep -r rm -n .`, `git commit -m "rm old path"`): those now prompt. That is
the intended direction to err in.

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

That boot picked up **0.16.1**, not 0.16.2. The 0.16.2 pin is installed on disk
in both trees and verified there (the word rule is present in
`node_modules/dsh-kanban/src/grants.mjs` and in the profile copy), but it takes
effect only after one more planned restart:

```sh
sudo systemctl restart dsh    # Chris, in a planned window — never grantable
```

Before it, `systemctl show dsh -p MainPID -p ActiveEnterTimestamp` should still
read 4142753 / 21:31:25; after it, a new PID and a new timestamp, and
`node -p "require('/home/dsh/dsh-deploy/node_modules/dsh-kanban/package.json').version"`
(0.16.2 on disk already) is what the new process will be running.

Rollback, if the word rule turns out to prompt too much in practice: pin
`dsh-kanban-v0.16.1` in both manifests, reinstall both trees, restart in a
planned window — and know that 0.16.1 carries the shell-syntax hole this fixes.

## Verification trail

- Clone `/home/dsh/dsh-deploy/.dsh-worktrees/kan30-plugins` at `df1a3e3`:
  `npm run check` → verify 0 errors, hook gate clean, **835/835 tests, 0 fail**;
  `node scripts/compose-smoke.mjs` → 11/11; `npm pack --dry-run` lists
  `src/grants.mjs` (34 files).
- Lab evidence (rounds 0.16.0/0.16.1, under
  `.dsh-worktrees/kan30-deploy/.lab/kan30-evidence/`): smoke `ui,completion`
  8 PASS / 0 FAIL; the grants e2e 8 PASS — a granted out-of-workspace write was
  answered `allowed-once` with a `grant_applied` event and no human, an
  ungranted one was not auto-approved and never wrote its file. Note the plan's
  literal "no `approval/asked` event" wording is unsatisfiable plugin-only:
  `dsh-user-approval` appends that event before the waterfall runs. Not re-run
  for 0.16.2: the change only narrows what the approver answers.
- Live checkout: `pnpm run check` → `check-no-links: ok`, exit 0.
