#!/usr/bin/env bash
#
# scan_sessions.sh — Scan DSH sessions and emit one pipe-delimited row per session.
#
# DESIGN: this script gathers RAW FACTS ONLY. It deliberately does NOT decide what
# is "test cruft" or "real work". Path-based exclusions baked from one machine's
# session set are brittle and silently drop real work. The caller — a model running
# the dsh-inflight-audit skill — makes that judgment from the columns emitted here,
# especially: event_count, cwd, last_type, last_seq, title, first_user_msg.
#
# Usage:
#   ./scan_sessions.sh [--days N] [--since DATE] [--top-level-only]
#   AUDIT_DAYS=14 ./scan_sessions.sh
#   AUDIT_SINCE="2026-09-01" ./scan_sessions.sh
#
# Time period (most specific wins):
#   --since DATE    absolute start date, any `date -d`-parseable string. Overrides all.
#   --days N        number of days to look back. Overrides $AUDIT_DAYS.
#   $AUDIT_SINCE    environment override for --since.
#   $AUDIT_DAYS     environment override for --days (default: 7).
#
# The window is ACTIVITY-based: a session is included if its LAST ACTIVITY falls
# inside the window, regardless of when it was created. Sessions created long ago
# but touched recently still appear (the created column shows the age).
#
# Filters:
#   --top-level-only   structural filter: drop rows with a parentSession or origin=subagent.
#                      (This is a definition, not a judgment, so it stays in the script.)
#
# Output columns (pipe-delimited; pipe chars inside fields are replaced with /):
#   SESSION|<rel_path>|<created_UTC>|<last_activity_UTC>|<lock>|<parent>|<origin>|<preset>|<cwd>|<last_type>|<last_seq>|<event_count>|<title>|<first_user_msg>
#
# Exit codes:
#   0  success
#   1  bad arguments
#   2  zstdcat not available or session root missing

set -euo pipefail

# --- Guard: prerequisites ---
if ! command -v zstdcat >/dev/null 2>&1; then
  echo "ERROR: zstdcat not found in PATH. Install zstd." >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found (needed for title/first-message extraction)." >&2
  exit 2
fi

SESS_ROOT="${DSH_SESSIONS_ROOT:-$HOME/.dsh/sessions}"
if [ ! -d "$SESS_ROOT" ]; then
  echo "ERROR: session directory not found at $SESS_ROOT" >&2
  exit 2
fi

# Self-exclusion: an audit must not report its own session as "incomplete" — while it
# runs, its own log's final event is whatever tool call is executing right now.
# $DSH_SESSION_ID is injected into tool shells. Override with --self <id> or keep the
# self row with --include-self.
SELF_ID="${DSH_SESSION_ID:-}"

# --- Time period resolution (precedence: --since > --days > $AUDIT_SINCE > $AUDIT_DAYS > 7) ---
DAYS="${AUDIT_DAYS:-7}"
SINCE="${AUDIT_SINCE:-}"
TOP_LEVEL_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --days)
      [ $# -ge 2 ] || { echo "ERROR: --days requires a value" >&2; exit 1; }
      DAYS="$2"; shift 2 ;;
    --since)
      [ $# -ge 2 ] || { echo "ERROR: --since requires a value" >&2; exit 1; }
      SINCE="$2"; shift 2 ;;
    --top-level-only) TOP_LEVEL_ONLY=1; shift ;;
    --self)
      [ $# -ge 2 ] || { echo "ERROR: --self requires a value" >&2; exit 1; }
      SELF_ID="$2"; shift 2 ;;
    --include-self) SELF_ID=""; shift ;;
    -h|--help)
      sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "ERROR: unknown argument: $1 (did you mean --top-level-only?)" >&2
      echo "Try: $0 --help" >&2
      exit 1 ;;
  esac
done

if [ -n "$SINCE" ]; then
  CUTOFF_S=$(date -d "$SINCE" +%s 2>/dev/null) \
    || { echo "ERROR: cannot parse --since value: '$SINCE'" >&2; exit 1; }
  echo "# window: since $SINCE ($(date -u -d "@$CUTOFF_S" +'%Y-%m-%d %H:%M UTC'))" >&2
else
  [[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "ERROR: --days must be a positive integer, got '$DAYS'" >&2; exit 1; }
  CUTOFF_S=$(date -d "$DAYS days ago" +%s)
  echo "# window: past $DAYS day(s) (since $(date -u -d "@$CUTOFF_S" +'%Y-%m-%d %H:%M UTC'))" >&2
fi
CUTOFF_MS=$((CUTOFF_S * 1000))

# Never write into session directories — use a temp dir.
AUDIT_TMP=$(mktemp -d "/tmp/dsh-inflight-audit-scan.XXXXXX")
trap "rm -rf '$AUDIT_TMP'" EXIT

# Extract the session title and first real user message (skipping system
# boilerplate) from the decompressed log, and print them tab-separated with
# pipe chars and newlines neutralized so they survive the pipe-delimited output.
extract_text() {
  python3 - "$1" <<'PY'
import sys, json
title = ""
first_msg = ""
boiler = ("system-reminder", "runtime context", "workspace instructions", "available_skills",
          "approval policy changed")
try:
    with open(sys.argv[1]) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type", "")
            if t == "session/title" and not title:
                title = str(d.get("data", {}).get("title", ""))
            elif t == "user/message" and not first_msg:
                for c in d.get("data", {}).get("content", []):
                    if c.get("type") == "text":
                        txt = c["text"]
                        if any(b in txt for b in boiler):
                            continue
                        first_msg = txt
                        break
            if title and first_msg:
                break
except Exception:
    pass
def clean(s):
    return " ".join(s.replace("|", "/").split())[:120]
print(clean(title) + "\t" + clean(first_msg))
PY
}

find "$SESS_ROOT" -name "session.v3.jsonl.zstd" -type f 2>/dev/null | sort | while read -r jsonl; do
    dir=$(dirname "$jsonl")
    lock="$dir/session.lock"

    # Cheap activity pre-filter: the .zstd file's mtime tracks its last event time
    # exactly (verified on real data), so a file whose mtime predates the window
    # cannot have had any activity in the window — skip it WITHOUT decompressing.
    # (A session created inside the window always has mtime >= cutoff, so this never
    # drops a session that would otherwise qualify.)
    mt_s=$(stat -c%Y "$jsonl" 2>/dev/null || echo "")
    [ -z "$mt_s" ] && continue
    [ "$((mt_s * 1000))" -lt "$CUTOFF_MS" ] && continue

    zstdcat "$jsonl" 2>/dev/null > "$AUDIT_TMP/session.jsonl"
    [ -s "$AUDIT_TMP/session.jsonl" ] || continue

    first=$(head -1 "$AUDIT_TMP/session.jsonl")
    last=$(tail -1 "$AUDIT_TMP/session.jsonl")

    created=$(echo "$first" | { grep -o '"createdAt":[0-9]*' || true; } | cut -d: -f2)
    [ -z "$created" ] && continue

    # Window filter is ACTIVITY-based, not creation-based: a session is in-scope if it
    # did anything inside the window, regardless of when it started. last_activity_ms
    # comes from the final event's time field (authoritative), with the file mtime as a
    # fallback. This surfaces old-but-recently-live sessions that creation-filtering
    # would hide.
    last_activity_ms=$(echo "$last" | { grep -o '"time":[0-9]*' || true; } | head -1 | cut -d: -f2)
    [ -z "$last_activity_ms" ] && last_activity_ms=$((mt_s * 1000))
    [ "$last_activity_ms" -lt "$CUTOFF_MS" ] && continue

    # `|| true` on every optional extraction — grep exits 1 on no match (a top-level
    # session has no parentSession field), which under `set -euo pipefail` would kill
    # the whole scan on the first top-level session.
    parent=$(echo "$first" | { grep -o '"parentSession":"[^"]*"' || true; } | cut -d'"' -f4)
    origin=$(echo "$first" | { grep -o '"origin":"[^"]*"' || true; } | cut -d'"' -f4)
    preset=$(echo "$first" | { grep -o '"agentPreset":"[^"]*"' || true; } | cut -d'"' -f4)
    cwd=$(echo "$first" | { grep -o '"cwd":"[^"]*"' || true; } | cut -d'"' -f4)

    if [ -s "$lock" ]; then
        lock_status="IN-FLIGHT"
    else
        lock_status="closed"
    fi

    last_type=$(echo "$last" | { grep -o '"type":"[^"]*"' || true; } | cut -d'"' -f4)
    last_seq=$(echo "$last" | { grep -o '"seq":[0-9]*' || true; } | cut -d: -f2)
    event_count=$(wc -l < "$AUDIT_TMP/session.jsonl")

    # --- Filter: exclude the audit's own session (default via $DSH_SESSION_ID) ---
    # The session running this scan is live; its final log event is the tool call in
    # flight, which would otherwise be misreported as an incomplete/abandoned session.
    if [ -n "$SELF_ID" ]; then
        case "$dir" in
            *"$SELF_ID"*) continue ;;
        esac
    fi

    # --- Only remaining filter: structural (not a judgment) ---
    if [ "$TOP_LEVEL_ONLY" = "1" ]; then
        [ -n "$parent" ] && continue
        [ "$origin" = "subagent" ] && continue
    fi

    rel_path=$(echo "$jsonl" | sed "s|$SESS_ROOT/||" | sed 's|/session.v3.jsonl.zstd||')
    human_date=$(date -u -d "@$((created / 1000))" +"%Y-%m-%d %H:%M:%S")
    human_activity=$(date -u -d "@$((last_activity_ms / 1000))" +"%Y-%m-%d %H:%M:%S")

    IFS=$'\t' read -r title first_msg < <(extract_text "$AUDIT_TMP/session.jsonl")

    echo "SESSION|$rel_path|$human_date|$human_activity|$lock_status|$parent|$origin|$preset|$cwd|$last_type|$last_seq|$event_count|$title|$first_msg"
done
