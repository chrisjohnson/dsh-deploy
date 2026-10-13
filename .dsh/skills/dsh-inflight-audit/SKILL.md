---
name: dsh-inflight-audit
description: Audit recent DSH sessions to find in-flight work that didn't conclude properly. Identifies top-level sessions with abandoned, incomplete, or taken-over work and summarizes original goal, current focus, and blocker.
whenToUse: Use when you need to review recent session activity for incomplete work, abandoned tasks, or work that was picked up by another session. Especially useful after a period of active development to catch loose ends.
---

# DSH In-Flight Session Audit

Audit recent DSH sessions (default: past 7 days) to find top-level sessions (not subagents) that had real in-flight work which didn't conclude properly. The helper script gathers raw facts; **you** decide which sessions are real work versus test scaffolding, from what the sessions actually contain.

## Time period

The audit window defaults to **7 days** and can be overridden by the caller:

| Variable | Meaning | Default |
|----------|---------|---------|
| `AUDIT_DAYS` | Number of days to look back | `7` |
| `AUDIT_SINCE` | Any `date -d`-parseable absolute timestamp (`"2026-09-25"`, `"2026-09-25 00:00 UTC"`) — takes precedence over `AUDIT_DAYS` | (unset) |

The window is **activity-based**: a session is in scope if its *last activity* falls
inside the window, not merely its creation date. A session created three weeks ago that
you worked in yesterday is exactly the kind of live-but-old work an in-flight audit
must surface — and it appears, with its true age visible in the `created` column.

Examples:

```bash
AUDIT_DAYS=14 bash ...    # past two weeks
AUDIT_DAYS=1 bash ...     # just today/yesterday
AUDIT_SINCE="2026-09-01" bash ...   # explicit start date
```

## Prerequisites

Before proceeding, verify the environment can support this audit:

1. **`zstd`/`zstdcat` must be available** — session logs are compressed with Zstandard.
2. **Session data must be readable** — `~/.dsh/sessions/` is symlinked to `<workspace>/.dsh/sessions/`, which is inside the workspace root, so workspace-write access is sufficient.

Run this check first:

```bash
if ! command -v zstdcat >/dev/null 2>&1; then
  echo "ERROR: zstdcat not found — cannot decompress session logs"
  exit 1
fi
if [ ! -d "$HOME/.dsh/sessions" ]; then
  echo "ERROR: session directory not found at $HOME/.dsh/sessions"
  exit 1
fi
```

If either check fails, stop and report the missing prerequisite. Do not attempt to proceed.

## Step 0: Use a temp directory for all intermediate files

**Never write uncompressed session data into a session's own directory.**
DSH session directories (`$HOME/.dsh/sessions/<parent>/<session-id>/`) must contain only
`session.lock` and `session.v3.jsonl.zstd`. Writing an uncompressed `session.v3.jsonl`
file into that directory corrupts the session state and prevents DSH from rebooting the
session.

Instead, use a dedicated temp directory for ALL intermediate/decompressed files:

```bash
AUDIT_TMP=$(mktemp -d "/tmp/dsh-inflight-audit.XXXXXX")
trap "rm -rf '$AUDIT_TMP'" EXIT
```

Use `$AUDIT_TMP` as the destination for every decompressed session log, and never
reference a session directory path as an output location. Clean up with `rm -rf` when
done (the `trap` above handles this automatically).

**Each bash tool call runs in a fresh shell** — `AUDIT_TMP` does NOT persist between
calls. Set it at the top of any single command that needs it. The helper scripts create
and clean up their own temp dirs internally, so you only need `AUDIT_TMP` for ad-hoc
decompression commands.

## Step 1: Scan sessions (raw facts, configurable window)

Use the `scan_sessions.sh` helper script shipped alongside this SKILL.md. It gathers
**raw facts only** — decompression (into a temp dir, never into session dirs), the time
window, and one structural filter (`--top-level-only`). It deliberately makes **no
"cruft" judgments**; see Step 2 for why that's your job, not the script's.

```bash
# Locate this skill's directory. Do NOT use ${BASH_SOURCE[0]} here: these snippets
# are copied into ad-hoc `bash -c` invocations where BASH_SOURCE is EMPTY, so that
# idiom silently resolves SKILL_DIR to the cwd and the script path comes out wrong.
SKILL_DIR=""
for d in \
  "$PWD/.dsh/skills/dsh-inflight-audit" \
  "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/.dsh/skills/dsh-inflight-audit" \
  "$HOME/.dsh/skills/dsh-inflight-audit" \
  "$HOME/.agents/skills/dsh-inflight-audit"; do
  if [ -x "$d/scan_sessions.sh" ]; then SKILL_DIR="$d"; break; fi
done
[ -n "$SKILL_DIR" ] || { echo "ERROR: could not locate dsh-inflight-audit skill dir (where scan_sessions.sh lives)"; exit 1; }
echo "SKILL_DIR=$SKILL_DIR"

# Default window (7 days):
"$SKILL_DIR/scan_sessions.sh"

# Override the window — any of these:
"$SKILL_DIR/scan_sessions.sh" --days 14
"$SKILL_DIR/scan_sessions.sh" --since "2026-09-01"
AUDIT_DAYS=3 "$SKILL_DIR/scan_sessions.sh"
AUDIT_SINCE="2026-09-25 00:00 UTC" "$SKILL_DIR/scan_sessions.sh"

# Structural-only filter (definitional, not a judgment): drop subagents/children
"$SKILL_DIR/scan_sessions.sh" --top-level-only
```

Precedence: `--since` > `--days` > `$AUDIT_SINCE` > `$AUDIT_DAYS` > 7.
The active window is echoed as a `# window: ...` comment on stderr.

Each output line has these pipe-delimited columns (pipe chars inside text fields are
replaced with `/`):

```
SESSION|<rel_path>|<created_UTC>|<last_activity_UTC>|<lock>|<parent>|<origin>|<preset>|<cwd>|<last_type>|<last_seq>|<event_count>|<title>|<first_user_msg>
```

- `rel_path` — `<workspace-slug>/<session-dir>`; the session directory is
  `$HOME/.dsh/sessions/<rel_path>` (needed for `dump_narrative.sh` in Step 4).
- `created_UTC` vs `last_activity_UTC` — a large gap means a long-running or resumed
  session; both are inside the window for the activity criterion, but the age of
  `created` is context for judging it.
- `lock` — `IN-FLIGHT` (non-empty `session.lock`) or `closed`. **Caveat:** on some
  deployments (including this one) live sessions hold an advisory, zero-byte lock, so
  this column is `closed` even while running. Do not use it to detect "current" or
  "live" sessions; use recency (`last_activity_UTC`) instead.
- **Self-exclusion is automatic:** the script drops the session running the scan (via
  `$DSH_SESSION_ID`) so your own in-flight log is never misreported as abandoned. Use
  `--include-self` to see it, `--self <id>` to override. You may still appear in the
  lineage of a *previous* audit — if you recognize your own current task, note it and
  move on; never write up your own live session as "incomplete."
- `parent`/`origin` — empty for top-level sessions; `--top-level-only` drops anything
  with a `parentSession` or `origin=subagent`.
- `last_type`/`last_seq` — the final event type and its sequence number.
- `event_count` — number of lines in the decompressed log. A session with only a
  handful of events did almost nothing; one with hundreds did real work regardless of
  what its final event was. **This is your most useful cruft/incompleteness signal.**
- `title` and `first_user_msg` — what the session was actually *about*. These are the
  fields that let you tell real work from test scaffolding; a path tells you almost
  nothing, but the first user message is nearly always a dead giveaway.

## Step 2: Decide what is cruft (the model's judgment — not the script's)

The script does **not** exclude "cruft". Any path-based exclusion (`.dsh-demo/`, a
particular worktree, `scratch`) is reverse-engineered from whatever test sessions
existed on one machine on one day; it silently drops real work that happens to live
under a matching path, and misses new test patterns entirely. **You make the call by
reading the scan output**, using `first_user_msg`, `title`, `event_count`, and `cwd`
together.

Signals that a session is test scaffolding / not real in-flight work (weigh them, don't
pattern-match on paths):

- **Synthetic prompts** in `first_user_msg` — e.g. "Reply with exactly: ok",
  "Run exactly this bash command and nothing else: touch foo.md", "Use the bash tool to
  run exactly: ...", "Call the <tool> twice with args ...". Real tasks aren't phrased as
  harness scripts.
- **Fixture-shaped titles** — repeated templated titles across many sessions created
  within the same few minutes (a test harness iterating), or names like
  "<State> · checkout" / "<State> · worktree".
- **Dead-on-arrival forks** — `event_count` ≤ ~6 and `last_type` is a bootstrap event
  (`session/title`, `subagent/model-selection-policy`, `approval/policy`, `sandbox/mode`,
  `session/end-seed`). These spawned and died with no real turn.

Counter-signal — **do not** treat these as cruft or as "clean":

- A real, high-`event_count` session whose `last_type` happens to be `session/end-seed`
  or `session/title` is a real session that ended on that event — it may still be
  genuinely incomplete. Judge incompleteness in Step 3 from the narrative, not the path.

**When in doubt, keep the session** and inspect it with `dump_narrative.sh` before
discarding it. In your final report (Step 6), briefly list what you set aside as cruft
and why, so the exclusion is auditable rather than silent.

## Step 3: Identify genuinely incomplete sessions

For each remaining top-level session, determine if the work concluded properly:

| `last_type` / condition | Interpretation | Incomplete? |
|-------------------------|-----------------|-------------|
| `turn/end` with `reason.kind = "completed"` | Finished cleanly | NO |
| `tool/call` as final event | Ended mid-tool-call | YES |
| `step/start` as final event | Started a step, did no work | YES |
| `llm/retry` as final event | LLM timeout, retry pending | YES |
| `approval/asked` as final event | Waiting for sandbox approval | YES |
| `turn/end` with `reason.kind = "aborted"` and `reason.reason.kind = "user"` | User aborted | YES |
| `turn/end` with `reason.kind = "aborted"` and `reason.reason.kind = "parent"` | Parent aborted subagent | YES |
| `step/end` with no following turn/end | Mid-step termination | YES |

## Step 4: Investigate each incomplete session

For each incomplete session identified in Step 3, pull the full narrative using the
helper script shipped with this skill. The helper script handles decompression into a
temp dir (never into the session dir) and renders the narrative with proper quoting.

```bash
# Reuse the SKILL_DIR resolved in Step 1 (do NOT re-derive it via BASH_SOURCE).
# Run the narrative dump for one session; <rel_path> is from Step 1's rel_path column.
"$SKILL_DIR/dump_narrative.sh" "$HOME/.dsh/sessions/<rel_path>"
```

The script prints:
1. **ORIGINAL GOAL** — the first user messages and session title (from the first 8 events)
2. **CURRENT STATE** — the last 8 events, showing what the session was doing when it ended

Key events to look for in the CURRENT STATE section:
- `[RETRY] failure=Request timed out.` → LLM request timed out, retry pending (incomplete)
- `[APPROVAL] waiting for sandbox escalation` → Waiting for user to approve sandbox access (stuck)
- `[END] reason={"kind": "aborted", ...}` → Session was aborted (by user or parent)
- `[END] reason={"kind": "completed"}` → Session finished cleanly (not incomplete)
- `[STEP] turn=N step=M` with no following `[END]` → Session ended mid-step (incomplete)
- `[SPLICED] ...` → User injected a new message mid-conversation (session redirected)

If you need to inspect a session's full raw log (not just the summary), decompress to the
temp dir and read it directly:

```bash
zstdcat "<SESSION_PATH>/session.v3.jsonl.zstd" 2>/dev/null > "$AUDIT_TMP/raw.jsonl"
# Then inspect with:
tail -50 "$AUDIT_TMP/raw.jsonl"
```

## Step 5: Check for work pickup

For sessions that ended prematurely, verify whether the work was completed elsewhere:

1. **Check git history** — look for related commits in the relevant repo since the session ended:
   ```bash
   cd <repo_path>
   git log --since="<session_date>" --oneline -- <relevant_files> | head -20
   ```
2. **Check for `-S` (source) changes** — find commits that added/modified the relevant function:
   ```bash
   git log --all -S"<function_name>" --oneline | head -10
   ```
3. **Check current state** — verify the feature exists in the deployed artifact:
   ```bash
   grep -n "<function_name>" <deployed_artifact_path>
   ```

**Check chronology before claiming "superseded by" or "picked up by".** A pickup must
happen *after* the abandonment: compare the candidate's timestamps (scan `created` /
`last_activity` columns; `git log --format='%h %ad %s'` for commits) against the
original's last activity. A session that completed *earlier* than the session you're
explaining cannot be its successor — a common mix-up when the same task recurs many
times, so cite timestamps next to every lineage claim ("`X` superseded `Y` (completed
09-30 16:54, after Y's abort at 09-30 16:49)") or state plainly that the lineage is
unclear.

## Step 6: Produce the summary

**Deliver the summary in the conversation.** Save a report file only when the user
explicitly asks for one; if a previous run left one behind and the user re-runs the
audit, updating or replacing it is fine, but creating new files unprompted is not.

Format the output as a table:

| Session | Location | Date | Original Goal | Current Focus | Blocker | Status |
|---------|----------|------|---------------|---------------|---------|--------|

Then write a narrative for each session covering:
1. **Originally about** — what the user asked for (from first user messages)
2. **Currently focused on** — what the session was working on when it ended
3. **Blocker to getting over the line** — what prevented completion (LLM timeout, unanswered approval, user abort, etc.)
4. **Fate of the work** — abandoned, completed elsewhere, or still in progress

## Notes

- **Self-reference:** the audit session appears in its own scan (and any concurrent
  audit lineage too). Exclude `IN-FLIGHT` rows from findings, and never describe your
  own session as abandoned/superseded — you are the session reading that log.
- **Cleanup once:** remove the temp dir(s) once, at the very end of the audit. Repeating
  identical cleanup commands across calls trips the loop watchdog.
- **`zstdcat` vs `zstd -d`**: Use `zstdcat` (stdout) rather than `zstd -d -o` — the `-o` flag in some zstd versions copies rather than decompresses.
- **`zstd -d` with `-o` to same name**: `zstd -d file.zstd -o file` can fail with "already exists; overwrite (y/n)?" — use stdout redirection or `zstdcat`.
- **Session lock is unreliable**: locks may be advisory zero-byte flocks, so an empty
  `session.lock` does NOT prove a session is closed, and no signal proves it is open.
  A near-current `last_activity_UTC` means "live or just finished" — treat such rows as
  in-progress, not abandoned, and check them again on a later run.
- **`llm/retry`**: A retry event as the last event means the LLM call failed and the session ended during retry — the work is incomplete.
- **`approval/asked`**: The session is waiting for the user to approve a sandbox escalation. If this was never answered, the work is stuck.
- **`agent/inbox/spliced`**: The user injected a new message into an ongoing session (e.g., "scrub to halfway through the route"). This indicates the session was redirected mid-flow.
- **Creator mode**: This skill does NOT depend on creator mode. It only reads session logs from the filesystem, which is available under workspace-write. No creator-mode guard is needed.