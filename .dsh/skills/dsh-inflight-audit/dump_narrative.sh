#!/usr/bin/env bash
#
# dump_narrative.sh — Dump the narrative (original goal + current state) of a DSH session.
#
# Usage: ./dump_narrative.sh <session_dir>
#   <session_dir>  Path to the session directory (e.g. ~/.dsh/sessions/<parent>/<session-id>/)
#
# Decompresses the session log into a temp file (never into the session dir) and
# prints the original goal (first user messages / title) and current state (last 8 events).
#
# Exit codes:
#   0  Success
#   1  Missing argument or file not found
#   2  zstdcat not available

set -euo pipefail

# --- Guard: prerequisites ---
if ! command -v zstdcat >/dev/null 2>&1; then
  echo "ERROR: zstdcat not found in PATH. Install zstd or use 'zstd -d'." >&2
  exit 2
fi

if [ $# -lt 1 ]; then
  echo "Usage: $0 <session_dir>" >&2
  echo "  <session_dir>  Path to the session directory (contains session.v3.jsonl.zstd)" >&2
  exit 1
fi

SESSION_DIR="$1"
JSONL_ZSTD="$SESSION_DIR/session.v3.jsonl.zstd"

if [ ! -f "$JSONL_ZSTD" ]; then
  echo "ERROR: session log not found at $JSONL_ZSTD" >&2
  echo "  (make sure you passed the session directory, not the parent)" >&2
  exit 1
fi

# Never write into the session directory — use a temp dir.
AUDIT_TMP=$(mktemp -d "/tmp/dsh-inflight-audit.XXXXXX")
trap "rm -rf '$AUDIT_TMP'" EXIT

NARRATIVE="$AUDIT_TMP/narrative.jsonl"

# Decompress into temp dir (stdout redirect, NOT -o flag)
zstdcat "$JSONL_ZSTD" 2>/dev/null > "$NARRATIVE"

if [ ! -s "$NARRATIVE" ]; then
  echo "ERROR: failed to decompress $JSONL_ZSTD (empty output)" >&2
  exit 1
fi

# Print narrative using Python (reads from temp file, not stdin, to avoid
# quoting issues with nested double-quotes in a bash -c string)
python3 - "$NARRATIVE" <<'PYEOF'
import sys, json

narrative_file = sys.argv[1]
events = []
with open(narrative_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = d.get("type", "")
        # Include all event types that help tell the story
        if t in ("user/message", "assistant/message", "tool/call", "tool/result",
                 "turn/end", "step/start", "step/end", "session/title",
                 "llm/retry", "approval/asked", "agent/inbox/spliced",
                 "session/end-seed", "command/done", "compaction/end"):
            events.append((t, d))

print("=" * 70)
print(f"SESSION: {narrative_file}")
print("=" * 70)

# --- Original Goal: first user messages and title ---
print("\n=== ORIGINAL GOAL (first user messages / title) ===")
for t, d in events[:8]:
    data = d.get("data", {})
    if t == "user/message":
        for c in data.get("content", []):
            if c.get("type") == "text":
                txt = c["text"]
                # Skip system reminders and boilerplate
                if ("system-reminder" in txt or
                    "runtime context" in txt or
                    "workspace instructions" in txt or
                    "available_skills" in txt):
                    continue
                print(f"[USER] {txt[:300]}")
    elif t == "session/title":
        title = data.get("title", "(no title)")
        print(f"[TITLE] {title}")

# --- Current State: last 8 events ---
print("\n=== CURRENT STATE (last 8 events) ===")
for t, d in events[-8:]:
    data = d.get("data", {})
    if t == "assistant/message":
        for c in data.get("content", []):
            if c.get("type") == "text" and c["text"].strip():
                print(f"[ASST] {c['text'][:250]}")
    elif t == "tool/call":
        name = data.get("name", "")
        args = json.loads(data.get("arguments", "{}"))
        args_str = str(args)[:150]
        if len(args_str) < 150:
            print(f"[TOOL] {name} -> {args_str}")
        else:
            print(f"[TOOL] {name} -> {args_str}...")
    elif t == "tool/result":
        for c in data.get("content", []):
            if c.get("type") == "tool-result":
                for i in c.get("content", []):
                    if i.get("type") == "text":
                        txt = i["text"]
                        if len(txt) > 150:
                            txt = txt[:150] + "..."
                        print(f"[RESULT] {txt}")
    elif t == "llm/retry":
        fail = data.get("failure", {})
        print(f"[RETRY] retry={data.get('retry','')} "
              f"maxRetries={data.get('maxRetries','')} "
              f"failure={fail.get('message','')}")
    elif t == "approval/asked":
        print("[APPROVAL] waiting for sandbox escalation")
    elif t == "turn/end":
        reason = data.get("reason", {})
        print(f"[END] reason={json.dumps(reason)[:200]}")
    elif t == "step/start":
        print(f"[STEP] turn={data.get('turn','')} step={data.get('step','')}")
    elif t == "step/end":
        print(f"[STEP/end] turn={data.get('turn','')} step={data.get('step','')}")
    elif t == "session/title":
        title = data.get("title", "(no title)")
        print(f"[TITLE] {title}")
    elif t == "session/end-seed":
        seq = data.get("seq", "")
        print(f"[END-SEED] seq={seq}")
    elif t == "agent/inbox/spliced":
        for i in data.get("inserted", []):
            for c in i.get("content", []):
                if c.get("type") == "text":
                    print(f"[SPLICED] {c['text'][:250]}")
    elif t == "command/done":
        text = data.get("text", "")
        name = data.get("name", "")
        if text:
            print(f"[CMD/{name}] {text[:150]}")
    elif t == "compaction/end":
        err = data.get("error", "")
        print(f"[COMPACTION] error={err[:150] if err else 'none'}")

print("=" * 70)
PYEOF