#!/usr/bin/env bash
# lab.sh - a private, disposable dsh instance for verifying changes before they
# are released: plugin edits (dsh-plugins) and changes to this repo.
#
# Runs on the box as the `dsh` user, needs no sudo and no tunnel. The lab is a
# clone of this repo with its own node_modules, its own DSH_HOME, its own HOME
# and its own port. It copies (read-only) a snapshot of production's session
# data so the checks run against real history, and it never writes to
# production's checkout, DSH_HOME or service.
#
#   scripts/lab.sh help            full usage
#
# Safe by default and idempotent: `up` on a running lab is a no-op, `down` on a
# stopped lab is a no-op, every subcommand accepts --dry-run.
set -euo pipefail
# Everything the lab writes (logs, the access URL, copied sessions) is private.
umask 077

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Configuration (environment, overridable by flags)
# ---------------------------------------------------------------------------
LAB_ROOT="${LAB_ROOT:-$HOME/dsh-lab}"
LAB_NAME="${LAB_NAME:-default}"
LAB_PORT="${LAB_PORT:-3099}"
LAB_SOURCE="${LAB_SOURCE:-https://github.com/chrisjohnson/dsh-deploy.git}"
LAB_REF="${LAB_REF:-main}"
LAB_PLUGINS_DIR="${LAB_PLUGINS_DIR:-$LAB_ROOT/plugins}"
LAB_PLUGINS_SOURCE="${LAB_PLUGINS_SOURCE:-https://github.com/chrisjohnson/dsh-plugins.git}"
LAB_BOOT_TIMEOUT="${LAB_BOOT_TIMEOUT:-120}"
PROD_UNIT="${PROD_UNIT:-dsh}"
PROD_DIR="${PROD_DIR:-/home/dsh/dsh-deploy}"
PROD_PORT="${PROD_PORT:-3081}"

DRY=0
EMPTY_DATA=0
WITH_WORKTREES=0
SESSIONS_LIMIT=""
QUIET_MINUTES="${LAB_QUIET_MINUTES:-10}"
FORCE=0
SMOKE_ARGS=()
POSITIONAL=()

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
say() { printf '%s\n' "$*"; }
info() { printf 'lab: %s\n' "$*"; }
warn() { printf 'lab: WARNING: %s\n' "$*" >&2; }
die() {
  printf 'lab: ERROR: %s\n' "$*" >&2
  exit 1
}
# Run a mutating command, or only describe it under --dry-run.
act() {
  if ((DRY)); then
    printf 'lab: [dry-run] would run: %s\n' "$*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Paths and safety checks
# ---------------------------------------------------------------------------
resolve_paths() {
  [[ "$LAB_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "LAB_NAME '$LAB_NAME' must be letters, digits, '.', '_' or '-'"
  [[ "$LAB_PORT" =~ ^[0-9]+$ ]] || die "port '$LAB_PORT' is not a number"
  LAB_DIR="$LAB_ROOT/$LAB_NAME"
  LAB_META="$LAB_DIR/.lab"
  LAB_HOME="$LAB_META/home"
  LAB_DSH_HOME="$LAB_DIR/.dsh"
  LAB_LOG="$LAB_META/lab.log"
  LAB_PID_FILE="$LAB_META/pid"
  LAB_URL_FILE="$LAB_META/url"
  LAB_DATA_FILE="$LAB_META/data-mode"
}

# Resolve a path even if it does not exist yet (nearest existing ancestor).
real_path() {
  local p="$1" tail=""
  while [[ ! -e "$p" && "$p" != "/" ]]; do
    tail="/$(basename "$p")$tail"
    p="$(dirname "$p")"
  done
  printf '%s%s\n' "$(cd "$p" && pwd -P)" "$tail"
}

under_or_equal() { [[ "$1" == "$2" || "$1" == "$2"/* ]]; }

# The lab must never be, or live inside, production; production's DSH_HOME is
# separately protected because it can be moved out of the checkout.
assert_lab_dir_safe() {
  local real prod_real
  real="$(real_path "$LAB_DIR")"
  prod_real="$(real_path "$PROD_DIR")"
  under_or_equal "$real" "$prod_real" && die "lab dir $real is inside the production checkout $prod_real"
  under_or_equal "$prod_real" "$real" && die "lab dir $real contains the production checkout $prod_real"
  if [[ -n "${PROD_DSH_HOME:-}" ]]; then
    local prod_home_real
    prod_home_real="$(real_path "$PROD_DSH_HOME")"
    under_or_equal "$real" "$prod_home_real" && die "lab dir $real is inside production's DSH_HOME"
  fi
  [[ "$real" != "/" && "$real" != "$HOME" ]] || die "refusing lab dir $real"
}

assert_port_ok() {
  ((LAB_PORT != PROD_PORT)) || die "port $LAB_PORT is production's port; pick another (default 3099)"
  ((LAB_PORT >= 1024 && LAB_PORT <= 65535)) || die "port $LAB_PORT is outside 1024-65535"
}

port_listener() { ss -ltnH "sport = :$1" 2>/dev/null | head -1; }

# ---------------------------------------------------------------------------
# Production launch description (read-only)
# ---------------------------------------------------------------------------
# Fills PROD_ARGV (node, flags, script, app args) and PROD_ENV (KEY=VALUE),
# preferring the running service's /proc entries, which is exactly what the
# unit launched with. Falls back to systemd's own description of the unit.
# Neither is ever printed: PROD_ENV carries the model API key.
PROD_ARGV=()
PROD_ENV=()
PROD_SOURCE=""
PROD_DSH_HOME=""

load_prod_launch() {
  [[ ${#PROD_ARGV[@]} -gt 0 ]] && return 0
  local pid=""
  pid="$(systemctl show "$PROD_UNIT" -p MainPID --value 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ && "$pid" != "0" && -r "/proc/$pid/cmdline" && -r "/proc/$pid/environ" && -z "${LAB_FORCE_UNIT_FALLBACK:-}" ]]; then
    PROD_SOURCE="/proc/$pid"
    while IFS= read -r -d '' arg; do PROD_ARGV+=("$arg"); done <"/proc/$pid/cmdline"
    while IFS= read -r -d '' kv; do PROD_ENV+=("$kv"); done <"/proc/$pid/environ"
  else
    PROD_SOURCE="systemctl (fallback)"
    local tmp mode="argv" item
    tmp="$(mktemp)"
    unit_fallback >"$tmp" || {
      rm -f "$tmp"
      die "cannot read production's launch description from /proc or systemctl; is $PROD_UNIT installed?"
    }
    while IFS= read -r -d '' item; do
      if [[ "$item" == $'\x01ENV' ]]; then
        mode="env"
      elif [[ "$mode" == "argv" ]]; then
        PROD_ARGV+=("$item")
      else
        PROD_ENV+=("$item")
      fi
    done <"$tmp"
    rm -f "$tmp"
  fi
  [[ ${#PROD_ARGV[@]} -ge 3 ]] || die "production launch description is empty or unreadable (source: $PROD_SOURCE)"
  local kv
  for kv in "${PROD_ENV[@]}"; do
    [[ "$kv" == DSH_HOME=* ]] && PROD_DSH_HOME="${kv#DSH_HOME=}"
  done
  [[ -n "$PROD_DSH_HOME" ]] || PROD_DSH_HOME="$PROD_DIR/.dsh"
}

# Emits NUL-separated argv, a \x01ENV marker, then KEY=VALUE entries.
unit_fallback() {
  python3 - "$PROD_UNIT" <<'PY'
import re, shlex, subprocess, sys
unit = sys.argv[1]
def show(prop):
    return subprocess.run(["systemctl", "show", unit, "-p", prop, "--value"],
                          capture_output=True, text=True, check=True).stdout.strip()
exec_start = show("ExecStart")
m = re.search(r"argv\[\]=(.*?) ; ignore_errors", exec_start)
if not m:
    sys.exit(1)
argv = shlex.split(m.group(1))
env = []
for item in shlex.split(show("Environment")):
    env.append(item)
for path in show("EnvironmentFiles").split():
    path = path.split("(")[0].strip()
    if not path or path.startswith("-"):
        path = path.lstrip("-")
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.append(k + "=" + shlex.split(v)[0] if v else k + "=")
    except OSError:
        pass
out = "\0".join(argv) + "\0\x01ENV\0" + "\0".join(env) + "\0"
sys.stdout.write(out)
PY
}

# ---------------------------------------------------------------------------
# Manifests: links and pins
# ---------------------------------------------------------------------------
manifests() {
  printf '%s\n' "$LAB_DIR/package.json" "$LAB_DIR/.dsh/profiles/web/package.json"
}

# `pkg<TAB>spec` for every dependency whose spec is a local link/file.
linked_pkgs() {
  [[ -f "$LAB_DIR/package.json" ]] || return 0
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const [k, v] of Object.entries(j.dependencies || {})) if (/^(link|file|portal):/.test(v)) console.log(k + "\t" + v);
  ' "$LAB_DIR/package.json"
}

has_links() { [[ -n "$(linked_pkgs)" ]]; }

normalize_pkg() {
  local p="$1"
  [[ "$p" == dsh-* || "$p" == @* ]] || p="dsh-$p"
  printf '%s\n' "$p"
}

# Rewrite one dependency's spec in a manifest, keeping indentation and the
# trailing newline. Prints nothing; fails if the package is not a dependency.
set_dep() {
  PKG="$2" SPEC="$3" node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const text = fs.readFileSync(file, "utf8");
    const j = JSON.parse(text);
    if (!j.dependencies || !(process.env.PKG in j.dependencies)) {
      console.error(file + ": " + process.env.PKG + " is not a dependency");
      process.exit(3);
    }
    j.dependencies[process.env.PKG] = process.env.SPEC;
    const indent = /^\{\n( +)"/.exec(text);
    fs.writeFileSync(file, JSON.stringify(j, null, indent ? indent[1].length : 2) + (text.endsWith("\n") ? "\n" : ""));
  ' "$1"
}

dep_spec() { # file pkg -> prints spec or nothing
  PKG="$2" node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = (j.dependencies || {})[process.env.PKG];
    if (v !== undefined) console.log(v);
  ' "$1"
}

head_spec() { # pkg, rel path of manifest -> spec at the lab clone's HEAD
  local content
  content="$(git -C "$LAB_DIR" show "HEAD:$2" 2>/dev/null)" || return 0
  printf '%s' "$content" | PKG="$1" node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const v = (j.dependencies || {})[process.env.PKG];
    if (v !== undefined) console.log(v);
  '
}

pnpm_install() {
  local mode="$1" out rc=0
  out="$(cd "$LAB_DIR" && CI=true pnpm install "$mode" --config.confirmModulesPurge=false 2>&1)" || rc=$?
  printf '%s\n' "$out" | tail -n 6 | sed 's/^/  pnpm: /'
  return "$rc"
}

# ---------------------------------------------------------------------------
# Lab process management
# ---------------------------------------------------------------------------
lab_port() { cat "$LAB_META/port" 2>/dev/null || printf '%s\n' "$LAB_PORT"; }

lab_pid() { # prints the pid of the lab server if alive and verified, else nothing
  local pid
  [[ -f "$LAB_PID_FILE" ]] || return 0
  pid="$(cat "$LAB_PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  [[ -r "/proc/$pid/cmdline" ]] || return 0
  # The pid must still be OUR server: a recycled pid is never signalled.
  if tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q -F "$LAB_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"; then
    printf '%s\n' "$pid"
  fi
}

# Every process whose environment says it belongs to this lab (the server's own
# children: shells, headless Chromium, tool subprocesses). Matches on the
# DSH_HOME value, so it can never match production's processes.
lab_family_pids() {
  local f pid
  for f in /proc/[0-9]*/environ; do
    pid="${f#/proc/}"
    pid="${pid%%/*}"
    [[ "$pid" == "$$" ]] && continue
    [[ -r "$f" ]] || continue
    if tr '\0' '\n' <"$f" 2>/dev/null | grep -q -x -F "DSH_HOME=$LAB_DSH_HOME"; then
      printf '%s\n' "$pid"
    fi
  done
}

build_lab_launch() {
  load_prod_launch
  LAB_ARGV=()
  LAB_ENV_ARR=()
  local tok flag_inserted=0 expect_port=0
  local preserve=0
  has_links && preserve=1
  for tok in "${PROD_ARGV[@]}"; do
    if ((expect_port)); then
      LAB_ARGV+=("$LAB_PORT")
      expect_port=0
      continue
    fi
    if [[ "$tok" == "--port" ]]; then
      expect_port=1
      LAB_ARGV+=("$tok")
      continue
    fi
    LAB_ARGV+=("${tok//$PROD_DIR/$LAB_DIR}")
    if [[ "$tok" == "--expose-internals" && $preserve -eq 1 && $flag_inserted -eq 0 ]]; then
      # A linked package's real path is outside node_modules, so its peer
      # imports (@deepseek-ai/*) would resolve from there and fail.
      LAB_ARGV+=("--preserve-symlinks")
      flag_inserted=1
    fi
  done
  local has_expose=0
  for tok in "${LAB_ARGV[@]}"; do [[ "$tok" == "--expose-internals" ]] && has_expose=1; done
  ((has_expose)) || die "production's argv has no --expose-internals; the app-boot patch needs it (source: $PROD_SOURCE)"

  local kv key path_value
  for kv in "${PROD_ENV[@]}"; do
    key="${kv%%=*}"
    case "$key" in
      # systemd bookkeeping that is meaningless outside the unit
      INVOCATION_ID | JOURNAL_STREAM | MEMORY_PRESSURE_WATCH | MEMORY_PRESSURE_WRITE | IO_PRESSURE_WATCH | IO_PRESSURE_WRITE | SYSTEMD_EXEC_PID) continue ;;
      # the lab gets its own, below
      HOME | DSH_HOME | DSH_DEPLOY_DIR | OLDPWD | PWD) continue ;;
      # the lab never gets the GitHub App identity: it must not be able to
      # push or open PRs on behalf of the box
      GITHUB_APP_ID | GITHUB_APP_INSTALLATION_ID | GITHUB_APP_PRIVATE_KEY_PATH | GH_REAL_BIN) continue ;;
      PATH)
        # drop production's gh-wrapper directory
        path_value="$(printf '%s' "${kv#PATH=}" | tr ':' '\n' | grep -v -x -F "$PROD_DIR/.bin" | paste -sd: -)"
        LAB_ENV_ARR+=("PATH=$path_value")
        continue
        ;;
    esac
    LAB_ENV_ARR+=("$kv")
  done
  LAB_ENV_ARR+=("HOME=$LAB_HOME" "DSH_HOME=$LAB_DSH_HOME" "DSH_DEPLOY_DIR=$LAB_DIR")
}

start_server() {
  build_lab_launch
  mkdir -p "$LAB_META" "$LAB_HOME"
  chmod 700 "$LAB_META"
  : >"$LAB_LOG"
  chmod 600 "$LAB_LOG"
  rm -f "$LAB_URL_FILE"
  (
    umask 077
    cd "$LAB_DIR"
    exec env -i "${LAB_ENV_ARR[@]}" setsid "${LAB_ARGV[@]}" >>"$LAB_LOG" 2>&1 </dev/null 9>&-
  ) &
  local pid=$!
  printf '%s\n' "$pid" >"$LAB_PID_FILE"
  printf '%s\n' "$LAB_PORT" >"$LAB_META/port"
  disown "$pid" 2>/dev/null || true
  local waited=0
  while ((waited < LAB_BOOT_TIMEOUT)); do
    if [[ -z "$(lab_pid)" ]]; then
      tail -n 20 "$LAB_LOG" | redact >&2 || true
      die "lab server exited during boot (see $LAB_LOG)"
    fi
    if [[ -n "$(port_listener "$LAB_PORT")" ]] && grep -q -E 'dsh web: http' "$LAB_LOG"; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  [[ -n "$(port_listener "$LAB_PORT")" ]] || die "lab did not start listening on :$LAB_PORT within ${LAB_BOOT_TIMEOUT}s (see $LAB_LOG)"
  # The access token lives only in this mode-600 file, never on stdout.
  (
    umask 077
    grep -o -E 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$LAB_LOG" | tail -1 >"$LAB_URL_FILE"
  )
  [[ -s "$LAB_URL_FILE" ]] || warn "no access URL found in the boot log"
  info "lab '$LAB_NAME' listening on 127.0.0.1:$LAB_PORT (pid $(lab_pid))"
}

stop_server() { # TERM, wait, KILL; then sweep the lab's own children
  local pid fam
  pid="$(lab_pid)"
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
  fam="$(lab_family_pids | tr '\n' ' ')"
  if [[ -n "${fam// /}" ]]; then
    # shellcheck disable=SC2086
    kill -TERM $fam 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -KILL $fam 2>/dev/null || true
  fi
  rm -f "$LAB_PID_FILE"
}

redact() { sed -E 's/(token=)[A-Za-z0-9_-]+/\1REDACTED/g'; }

# ---------------------------------------------------------------------------
# Boot verification
# ---------------------------------------------------------------------------
BOOT_PROBLEMS=0
verify_boot() {
  BOOT_PROBLEMS=0
  local line_re='skip|admission|did not activate|failed to import|incompatib|unsupported|no-getter|error|exception|unhandled|rejection|cannot find|ERR_|^[[:space:]]+at '
  local lines count
  lines="$(grep -v -E '^dsh web: http' "$LAB_LOG" | grep -i -E "$line_re" | redact | head -n 20 || true)"
  count="$(printf '%s' "$lines" | grep -c . || true)"
  if ((count > 0)); then
    BOOT_PROBLEMS=$((BOOT_PROBLEMS + count))
    say "boot log: $count suspicious line(s):"
    printf '%s\n' "$lines" | sed 's/^/  | /'
  else
    say "boot log: clean (no skip/admission/error/stack lines)"
  fi
  local extra
  extra="$(grep -v -E '^dsh web: http' "$LAB_LOG" | grep -c . || true)"
  ((extra > count)) && say "boot log: $((extra - count)) other line(s) (informational, see: lab.sh logs)"
  local compat="$LAB_DSH_HOME/profiles/web/compatibility.json"
  if [[ -f "$compat" ]]; then
    say "admission record: $compat exists:"
    head -c 600 "$compat" | sed 's/^/  | /'
    echo
    BOOT_PROBLEMS=$((BOOT_PROBLEMS + 1))
  else
    say "admission record: none written (no plugin rejected)"
  fi
  # --dump-config composes the profile in a throwaway process with the lab's own
  # environment; a non-zero exit or an admission skip is a boot problem.
  local dump_out="$LAB_META/dump-config.txt" dump_err="$LAB_META/dump-config.err" rc=0
  local dump_argv=() tok skip_next=0
  for tok in "${LAB_ARGV[@]}"; do
    if ((skip_next)); then
      skip_next=0
      continue
    fi
    [[ "$tok" == "web" ]] && break
    dump_argv+=("$tok")
  done
  (cd "$LAB_DIR" && env -i "${LAB_ENV_ARR[@]}" "${dump_argv[@]}" --profile web --dump-config >"$dump_out" 2>"$dump_err") || rc=$?
  if ((rc != 0)); then
    say "dump-config: FAILED (exit $rc), stderr:"
    head -n 10 "$dump_err" | redact | sed 's/^/  | /'
    BOOT_PROBLEMS=$((BOOT_PROBLEMS + 1))
  elif grep -q -i -E 'skip|admission|incompatib' "$dump_err"; then
    say "dump-config: exit 0 but reported:"
    head -n 10 "$dump_err" | redact | sed 's/^/  | /'
    BOOT_PROBLEMS=$((BOOT_PROBLEMS + 1))
  else
    say "dump-config: exit 0, $(grep -c '^# == ' "$dump_out" || true) layer annotations, no admission skips"
  fi
  # Every bundle named by the profile must have contributed a layer.
  local missing
  missing="$(node -e '
    const fs = require("fs");
    const dump = fs.readFileSync(process.argv[2], "utf8");
    const bundles = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dsh.profile.bundles;
    for (const b of bundles) if (!dump.includes("# == " + b)) console.log(b);
  ' "$LAB_DSH_HOME/profiles/web/package.json" "$dump_out" 2>/dev/null || true)"
  if [[ -n "$missing" ]]; then
    say "dump-config: bundles with no layer in the composed profile:"
    printf '%s\n' "$missing" | sed 's/^/  | /'
    BOOT_PROBLEMS=$((BOOT_PROBLEMS + 1))
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Lab creation and data
# ---------------------------------------------------------------------------
write_lab_conf() {
  mkdir -p "$LAB_META"
  {
    printf 'name=%s\nport=%s\nsource=%s\nref=%s\ncreated=%s\n' "$LAB_NAME" "$LAB_PORT" "$LAB_SOURCE" "$LAB_REF" "$(date -u +%FT%TZ)"
  } >"$LAB_META/lab.conf"
}

is_lab() { [[ -f "$LAB_META/lab.conf" && -d "$LAB_DIR/.git" ]]; }

ensure_lab() {
  if is_lab; then
    local head
    head="$(git -C "$LAB_DIR" rev-parse --short HEAD)"
    info "lab '$LAB_NAME' exists at $LAB_DIR (HEAD $head)"
    return 0
  fi
  [[ ! -e "$LAB_DIR" ]] || [[ -z "$(ls -A "$LAB_DIR" 2>/dev/null)" ]] || die "$LAB_DIR exists and is not a lab; refusing to reuse it"
  info "creating lab '$LAB_NAME': clone $LAB_SOURCE @ $LAB_REF"
  if ((DRY)); then
    info "[dry-run] would run: git clone $LAB_SOURCE $LAB_DIR; git checkout $LAB_REF; pnpm install --frozen-lockfile"
    return 0
  fi
  mkdir -p "$LAB_ROOT"
  git clone -q "$LAB_SOURCE" "$LAB_DIR"
  (
    cd "$LAB_DIR"
    git config user.name "DSH Lab"
    git config user.email "dsh-lab@local-ai-machine"
    git checkout -q --detach "origin/$LAB_REF" 2>/dev/null || git checkout -q --detach "$LAB_REF" ||
      die "ref '$LAB_REF' not found in $LAB_SOURCE"
  )
  write_lab_conf
  info "installing dependencies (shared pnpm store)"
  pnpm_install --frozen-lockfile || die "pnpm install failed"
}

# Copy production's state into the lab. Production is only ever READ.
seed_data() {
  load_prod_launch
  [[ -d "$PROD_DSH_HOME" ]] || die "production DSH_HOME $PROD_DSH_HOME not found"
  local under_lab
  under_lab="$(real_path "$LAB_DSH_HOME")"
  under_or_equal "$under_lab" "$(real_path "$PROD_DSH_HOME")" && die "lab DSH_HOME resolves into production's DSH_HOME"
  if ((EMPTY_DATA)); then
    info "data: --empty-data, nothing copied from production"
    act bash -c "mkdir -p '$LAB_DSH_HOME'/{sessions,attachments,storages,plugins} && echo empty >'$LAB_DATA_FILE'"
    write_watchdog_mode
    return 0
  fi
  local mode="full"
  [[ -n "$SESSIONS_LIMIT" ]] && mode="sessions=$SESSIONS_LIMIT"
  ((WITH_WORKTREES)) && mode="$mode,with-worktrees"
  info "data: copying production state read-only from $PROD_DSH_HOME ($mode)"
  if ((DRY)); then
    info "[dry-run] would rsync sessions attachments storages plugins (excluding scheduled-queue/schedule state); never keys"
    return 0
  fi
  mkdir -p "$LAB_DSH_HOME"/{sessions,attachments,storages,plugins}
  local rs=(rsync -a --no-owner --no-group)
  # --- sessions ---
  if [[ -n "$SESSIONS_LIMIT" ]]; then
    local list="$LAB_META/sessions.list"
    # Newest N session directories that have been quiet for QUIET_MINUTES: a
    # session written a moment ago may be mid-turn in production, and its
    # snapshot would look like a crash-orphaned turn.
    (set +o pipefail; cd "$PROD_DSH_HOME/sessions" && find . -mindepth 2 -maxdepth 2 -type d -name 'session-*' -mmin "+$QUIET_MINUTES" -printf '%T@ %P\n' |
      sort -rn | head -n "$SESSIONS_LIMIT" | cut -d' ' -f2-) >"$list"
    "${rs[@]}" --files-from="$list" "$PROD_DSH_HOME/sessions/" "$LAB_DSH_HOME/sessions/"
  else
    "${rs[@]}" "$PROD_DSH_HOME/sessions/" "$LAB_DSH_HOME/sessions/"
  fi
  # --- attachments, storages ---
  "${rs[@]}" "$PROD_DSH_HOME/attachments/" "$LAB_DSH_HOME/attachments/"
  # The queue and any native schedule state are what would let the lab deliver
  # real queued items; they are never copied.
  "${rs[@]}" --exclude='scheduled-queue*' --exclude='*schedule*' "$PROD_DSH_HOME/storages/" "$LAB_DSH_HOME/storages/"
  # --- plugin state ---
  if ((WITH_WORKTREES)); then
    "${rs[@]}" "$PROD_DSH_HOME/plugins/" "$LAB_DSH_HOME/plugins/"
  else
    "${rs[@]}" --exclude='worktrees.json' "$PROD_DSH_HOME/plugins/" "$LAB_DSH_HOME/plugins/"
  fi
  chmod -R u+rwX "$LAB_DSH_HOME"/{sessions,attachments,storages,plugins}
  echo "$mode" >"$LAB_DATA_FILE"
  write_watchdog_mode
  local n
  n="$(find "$LAB_DSH_HOME/sessions" -mindepth 2 -maxdepth 2 -type d -name 'session-*' | wc -l)"
  info "data: copied $n session(s); $(du -sh "$LAB_DSH_HOME" | cut -f1) total"
  if ((WITH_WORKTREES)); then
    warn "--with-worktrees: the lab now KNOWS production's registered working copies. They are REAL directories shared with production. NEVER Remove, convert or archive a registered copy from the lab. Use it to look, not to touch."
  fi
}

# Observe-only: the lab must never steer a session.
write_watchdog_mode() {
  ((DRY)) && return 0
  mkdir -p "$LAB_DSH_HOME/profiles/web"
  printf '{"interventionEnabled": false}\n' >"$LAB_DSH_HOME/profiles/web/watchdog-mode.json"
}

wipe_data() {
  local d
  for d in sessions attachments storages plugins; do
    local target="$LAB_DSH_HOME/$d"
    [[ -n "$target" && "$(real_path "$target")" == "$(real_path "$LAB_DIR")"/.dsh/* ]] || die "refusing to wipe $target"
    act rm -rf -- "$target"
  done
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------
cmd_up() {
  assert_port_ok
  assert_lab_dir_safe
  load_prod_launch
  assert_lab_dir_safe
  info "launch description from $PROD_SOURCE"
  if is_lab && [[ -n "$(lab_pid)" ]]; then
    info "lab '$LAB_NAME' is already running (pid $(lab_pid), :$LAB_PORT); nothing to do"
    return 0
  fi
  local listener
  listener="$(port_listener "$LAB_PORT")"
  [[ -z "$listener" ]] || die "port $LAB_PORT is already in use by another process; choose --port"
  local fresh=0
  is_lab || fresh=1
  ensure_lab
  ((DRY)) && {
    ((fresh)) && seed_data
    build_lab_launch
    info "[dry-run] would start: ${LAB_ARGV[*]}"
    info "[dry-run] with HOME=$LAB_HOME DSH_HOME=$LAB_DSH_HOME DSH_DEPLOY_DIR=$LAB_DIR (production's other environment copied, GitHub App identity dropped)"
    info "[dry-run] then verify the boot log and --dump-config"
    return 0
  }
  if ((fresh)) || [[ ! -f "$LAB_DATA_FILE" ]]; then
    seed_data
  else
    info "data: keeping the lab's existing data ($(cat "$LAB_DATA_FILE")); 'lab.sh reset' rebuilds it from production"
  fi
  warn_if_links
  start_server
  verify_boot
  say "access URL: stored in $LAB_URL_FILE (mode 600, not printed)"
  if ((BOOT_PROBLEMS > 0)); then
    warn "boot verification found $BOOT_PROBLEMS problem(s); the lab is up but not clean"
    return 3
  fi
  info "boot verification: clean"
}

warn_if_links() {
  local l
  l="$(linked_pkgs)"
  if [[ -n "$l" ]]; then
    info "linked packages (node runs with --preserve-symlinks):"
    printf '%s\n' "$l" | sed 's/^/  /'
  fi
}

cmd_down() {
  assert_lab_dir_safe
  is_lab || {
    info "lab '$LAB_NAME' does not exist; nothing to stop"
    return 0
  }
  if [[ -z "$(lab_pid)" && -z "$(lab_family_pids)" ]]; then
    info "lab '$LAB_NAME' is not running"
    rm -f "$LAB_PID_FILE"
    return 0
  fi
  ((DRY)) && {
    info "[dry-run] would stop pid $(lab_pid) and its children (matched by DSH_HOME=$LAB_DSH_HOME)"
    return 0
  }
  stop_server
  info "lab '$LAB_NAME' stopped"
}

cmd_restart() {
  assert_port_ok
  assert_lab_dir_safe
  is_lab || die "lab '$LAB_NAME' does not exist; run: lab.sh up"
  ((DRY)) && {
    info "[dry-run] would stop and start lab '$LAB_NAME' on :$LAB_PORT"
    return 0
  }
  stop_server
  warn_if_links
  start_server
  verify_boot
  ((BOOT_PROBLEMS == 0)) || {
    warn "boot verification found $BOOT_PROBLEMS problem(s)"
    return 3
  }
  info "restart: boot verification clean"
}

cmd_kill() { # crash simulation for the continue-kicker check
  is_lab || die "lab '$LAB_NAME' does not exist"
  local pid
  pid="$(lab_pid)"
  [[ -n "$pid" ]] || die "lab '$LAB_NAME' is not running"
  ((DRY)) && {
    info "[dry-run] would SIGKILL pid $pid and its children"
    return 0
  }
  kill -KILL "$pid" 2>/dev/null || true
  local fam
  fam="$(lab_family_pids | tr '\n' ' ')"
  # shellcheck disable=SC2086
  [[ -z "${fam// /}" ]] || kill -KILL $fam 2>/dev/null || true
  rm -f "$LAB_PID_FILE"
  info "lab '$LAB_NAME' killed (SIGKILL)"
}

cmd_reset() {
  assert_lab_dir_safe
  is_lab || die "lab '$LAB_NAME' does not exist; run: lab.sh up"
  local was_running=0
  [[ -n "$(lab_pid)" ]] && was_running=1
  ((DRY)) && info "[dry-run] would stop the lab, wipe its sessions/attachments/storages/plugins and re-copy from production"
  ((DRY)) || stop_server
  wipe_data
  seed_data
  if ((was_running && !DRY)); then
    start_server
    verify_boot
  fi
}

cmd_destroy() {
  assert_lab_dir_safe
  is_lab || {
    info "lab '$LAB_NAME' does not exist"
    return 0
  }
  local real
  real="$(real_path "$LAB_DIR")"
  [[ "$real" == "$(real_path "$LAB_ROOT")"/* ]] || die "refusing to remove $real: not directly under $LAB_ROOT"
  ((DRY)) && {
    info "[dry-run] would stop the lab and delete $real (plugin checkouts outside it are never touched)"
    return 0
  }
  stop_server
  rm -rf -- "$real"
  info "lab '$LAB_NAME' removed"
}

cmd_status() {
  assert_lab_dir_safe
  if ! is_lab; then
    say "lab '$LAB_NAME': not created ($LAB_DIR); run: lab.sh up"
    return 0
  fi
  local pid state
  pid="$(lab_pid)"
  if [[ -n "$pid" ]]; then
    state="RUNNING pid $pid on 127.0.0.1:$(lab_port) (up $(ps -o etime= -p "$pid" | tr -d ' '))"
  else
    state="stopped"
  fi
  say "lab:      $LAB_NAME ($state)"
  say "dir:      $LAB_DIR"
  say "ref:      $(git -C "$LAB_DIR" rev-parse --short HEAD) ($(sed -n 's/^ref=//p' "$LAB_META/lab.conf"))"
  say "data:     $(cat "$LAB_DATA_FILE" 2>/dev/null || echo unseeded)"
  say "log:      $LAB_LOG"
  say "url file: $LAB_URL_FILE (token inside; never printed)"
  say ""
  say "plugin dependencies:"
  node -e '
    const fs = require("fs"), path = require("path");
    const lab = process.argv[1];
    const root = JSON.parse(fs.readFileSync(path.join(lab, "package.json"), "utf8"));
    const prof = JSON.parse(fs.readFileSync(path.join(lab, ".dsh/profiles/web/package.json"), "utf8"));
    const names = Object.keys(root.dependencies).filter((n) => /^(dsh-|@deepseek-ai\/dsh-experimental-schedule)/.test(n) || /^(link|file):/.test(root.dependencies[n]));
    for (const n of names) {
      const spec = root.dependencies[n], pspec = (prof.dependencies || {})[n];
      let nm = "";
      try { const st = fs.lstatSync(path.join(lab, "node_modules", n)); nm = st.isSymbolicLink() ? "  node_modules -> " + fs.readlinkSync(path.join(lab, "node_modules", n)) : ""; } catch {}
      if (/^(link|file):/.test(spec)) {
        console.log("  LINKED  " + n + " -> " + spec.replace(/^[a-z]+:/, "") + (pspec !== spec ? "   (profile manifest differs: " + pspec + ")" : "") + nm);
      } else {
        const tag = /#([^&]+)/.exec(spec);
        console.log("  pinned  " + n + "  " + (tag ? tag[1] : spec) + (pspec !== spec ? "   (profile manifest differs)" : ""));
      }
    }
  ' "$LAB_DIR"
  say ""
  say "tracked-file drift (information only; DSH rewrites e.g. cordis.patch.yml when settings change):"
  local diff
  diff="$(git -C "$LAB_DIR" diff --stat --no-color 2>/dev/null || true)"
  if [[ -n "$diff" ]]; then printf '%s\n' "$diff" | sed 's/^/  /'; else say "  none"; fi
  if [[ -n "$pid" ]]; then
    say ""
    say "listener: $(port_listener "$(lab_port)" | awk '{print $4}')"
  fi
}

cmd_logs() {
  is_lab || die "lab '$LAB_NAME' does not exist"
  tail -n "${LOG_LINES:-60}" "$LAB_LOG" | redact
}

# --- link / unlink ---------------------------------------------------------
default_pkg_dir() { # pkg -> packages/<dir> parsed from the pinned git spec
  local spec
  spec="$(dep_spec "$LAB_DIR/package.json" "$1")"
  [[ "$spec" =~ path:/packages/([^\"\&]+) ]] && printf '%s\n' "${BASH_REMATCH[1]}"
}

ensure_plugins_checkout() {
  local repo="$LAB_PLUGINS_DIR/dsh-plugins"
  if [[ -d "$repo/.git" ]]; then return 0; fi
  info "no dsh-plugins checkout at $repo"
  if ((DRY)); then
    info "[dry-run] would run: git clone $LAB_PLUGINS_SOURCE $repo"
    return 0
  fi
  mkdir -p "$LAB_PLUGINS_DIR"
  git clone -q "$LAB_PLUGINS_SOURCE" "$repo"
}

cmd_link() {
  assert_lab_dir_safe
  is_lab || die "lab '$LAB_NAME' does not exist; run: lab.sh up"
  [[ ${#POSITIONAL[@]} -ge 1 ]] || die "usage: lab.sh link <package> [path]"
  local pkg target
  pkg="$(normalize_pkg "${POSITIONAL[0]}")"
  local m
  for m in $(manifests); do
    [[ -n "$(dep_spec "$m" "$pkg")" ]] || die "$pkg is not a dependency in ${m#"$LAB_DIR"/}; both manifests must list it"
  done
  if [[ ${#POSITIONAL[@]} -ge 2 ]]; then
    target="$(real_path "${POSITIONAL[1]}")"
  else
    local dir
    dir="$(default_pkg_dir "$pkg")"
    [[ -n "$dir" ]] || die "$pkg is not pinned to a dsh-plugins tag, so there is no default checkout; pass its path"
    ensure_plugins_checkout
    target="$LAB_PLUGINS_DIR/dsh-plugins/packages/$dir"
  fi
  # A repo root is accepted for convenience: use packages/<dir> inside it.
  if [[ ! -f "$target/package.json" && -d "$target/packages" ]]; then
    local dir
    dir="$(default_pkg_dir "$pkg")"
    [[ -n "$dir" && -f "$target/packages/$dir/package.json" ]] && target="$target/packages/$dir"
  fi
  if ((DRY)) && [[ ! -f "$target/package.json" ]]; then
    info "[dry-run] $target does not exist yet; the real run would require it"
  else
    [[ -f "$target/package.json" ]] || die "no package.json at $target"
    local name
    name="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1] + "/package.json", "utf8")).name)' "$target")"
    [[ "$name" == "$pkg" ]] || die "$target is package '$name', not '$pkg'"
  fi
  local real_target
  real_target="$(real_path "$target")"
  under_or_equal "$real_target" "$(real_path "$PROD_DIR")" && die "refusing to link a path inside the production checkout ($real_target)"
  under_or_equal "$real_target" "$(real_path "$LAB_DIR")" && die "link a checkout outside the lab clone; $real_target is inside it"
  info "link $pkg -> $real_target"
  if ((DRY)); then
    info "[dry-run] would set \"$pkg\": \"link:$real_target\" in both manifests, run pnpm install, and confirm node_modules/$pkg is a symlink to it"
    return 0
  fi
  for m in $(manifests); do set_dep "$m" "$pkg" "link:$real_target"; done
  pnpm_install --no-frozen-lockfile || die "pnpm install failed after linking (restore with: lab.sh unlink $pkg)"
  local resolved
  resolved="$(cd "$LAB_DIR" && readlink -f "node_modules/$pkg")"
  [[ "$resolved" == "$real_target" ]] || die "node_modules/$pkg resolves to '$resolved', expected '$real_target'"
  info "linked: node_modules/$pkg -> $resolved"
  pack_check "$pkg" "$real_target"
  if [[ -n "$(lab_pid)" ]]; then
    info "the lab is running with the old code; run 'lab.sh restart' to load the linked checkout"
  fi
}

pack_check() { # warn if package.json references files the published tarball would lack
  (cd "$LAB_DIR" && node "$HARNESS_DIR/scripts/lab-smoke/pack-check.mjs" "$2" 2>&1) | sed 's/^/lab: pack-check: /' || true
}

cmd_unlink() {
  assert_lab_dir_safe
  is_lab || die "lab '$LAB_NAME' does not exist"
  local pkgs=()
  if [[ ${#POSITIONAL[@]} -ge 1 && "${POSITIONAL[0]}" != "--all" ]]; then
    pkgs=("$(normalize_pkg "${POSITIONAL[0]}")")
  else
    while IFS=$'\t' read -r p _; do [[ -n "$p" ]] && pkgs+=("$p"); done < <(linked_pkgs)
  fi
  if [[ ${#pkgs[@]} -eq 0 ]]; then
    info "nothing is linked"
    return 0
  fi
  local pkg m rel spec
  for pkg in "${pkgs[@]}"; do
    for m in $(manifests); do
      rel="${m#"$LAB_DIR"/}"
      spec="$(head_spec "$pkg" "$rel")"
      [[ -n "$spec" ]] || die "$pkg has no pinned spec at HEAD in $rel; fix the manifest by hand"
      if ((DRY)); then
        info "[dry-run] would restore $pkg in $rel to: $spec"
      else
        set_dep "$m" "$pkg" "$spec"
      fi
    done
  done
  ((DRY)) && return 0
  if has_links; then
    pnpm_install --no-frozen-lockfile || die "pnpm install failed"
    info "unlinked ${pkgs[*]}; other packages are still linked"
  else
    # With nothing linked the lockfile must equal the committed one; restoring
    # it and installing frozen guarantees no link residue.
    git -C "$LAB_DIR" checkout -q -- pnpm-lock.yaml
    pnpm_install --frozen-lockfile || die "pnpm install failed"
    info "unlinked ${pkgs[*]}"
    node "$HARNESS_DIR/scripts/check-no-links.mjs" "$LAB_DIR" || warn "link residue remains; inspect with: lab.sh status"
  fi
  [[ -z "$(lab_pid)" ]] || info "the lab is still running the linked code; run 'lab.sh restart'"
}

# Model checks send real requests to the local models. A speed benchmark in
# flight on the box is measuring those same models, so refuse to disturb it.
guard_benchmark() {
  ((FORCE)) && return 0
  local arg model_modules="completion web-search image-search webp model-switch scheduled-queue loop-watchdog continue-kicker worktree"
  local only="" skip_model=0 prev=""
  for arg in "${SMOKE_ARGS[@]+"${SMOKE_ARGS[@]}"}"; do
    [[ "$prev" == "--only" ]] && only="$arg"
    [[ "$arg" == "--skip-model" ]] && skip_model=1
    prev="$arg"
  done
  ((skip_model)) && return 0
  if [[ -n "$only" ]]; then
    local touches=0 m
    for m in ${only//,/ }; do [[ " $model_modules " == *" $m "* ]] && touches=1; done
    ((touches)) || return 0
  fi
  local running
  running="$(pgrep -f -a "${LAB_BENCH_PATTERN:-llm_decode_bench|llm-inference-bench}" 2>/dev/null | grep -v pgrep | head -1 || true)"
  if [[ -n "$running" ]]; then
    die "a benchmark appears to be running (${running:0:100}); model checks would disturb it. Wait for it, run with --skip-model, or pass --force"
  fi
}

cmd_smoke() {
  assert_lab_dir_safe
  is_lab || die "lab '$LAB_NAME' does not exist; run: lab.sh up"
  [[ -n "$(lab_pid)" ]] || die "lab '$LAB_NAME' is not running; run: lab.sh up"
  ((DRY)) && {
    info "[dry-run] would run: node scripts/lab-smoke/run.mjs ${SMOKE_ARGS[*]:-}"
    return 0
  }
  guard_benchmark
  load_prod_launch
  # The browser is the one the production service uses. The suite needs no other
  # production variable (and never the model API key).
  local chrome="" kv
  for kv in "${PROD_ENV[@]}"; do [[ "$kv" == PLAYWRIGHT_CHROME_PATH=* ]] && chrome="${kv#PLAYWRIGHT_CHROME_PATH=}"; done
  [[ -n "$chrome" || -n "${PLAYWRIGHT_CHROME_PATH:-}" ]] || die "no PLAYWRIGHT_CHROME_PATH in production's environment; export one for the smoke suite"
  LAB_DIR="$LAB_DIR" LAB_NAME="$LAB_NAME" LAB_PORT="$(lab_port)" LAB_ROOT="$LAB_ROOT" \
    LAB_SH="$HARNESS_DIR/scripts/lab.sh" LAB_PLUGINS_DIR="$LAB_PLUGINS_DIR" \
    PLAYWRIGHT_CHROME_PATH="${PLAYWRIGHT_CHROME_PATH:-$chrome}" \
    PROD_DSH_HOME="$PROD_DSH_HOME" \
    node "$HARNESS_DIR/scripts/lab-smoke/run.mjs" "${SMOKE_ARGS[@]+"${SMOKE_ARGS[@]}"}"
}

# Read-only fingerprint of the things the lab must never change: the production
# unit, its answer on its own port, its checkout, and the registered working
# copies. `prod-check save` before a lab session, `prod-check compare` after.
prod_fingerprint() {
  load_prod_launch
  printf 'unit_active_enter=%s\n' "$(systemctl show "$PROD_UNIT" -p ActiveEnterTimestamp --value)"
  printf 'unit_main_pid=%s\n' "$(systemctl show "$PROD_UNIT" -p MainPID --value)"
  printf 'prod_port_http=%s\n' "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$PROD_PORT/" || true)"
  printf 'prod_checkout_head=%s\n' "$(git -C "$PROD_DIR" rev-parse HEAD 2>/dev/null)"
  printf 'prod_checkout_status_sha=%s\n' "$(git -C "$PROD_DIR" status --porcelain 2>/dev/null | sha256sum | cut -c1-16)"
  local registry="$PROD_DSH_HOME/plugins/dsh-better-git-worktree/worktrees.json"
  if [[ -f "$registry" ]]; then
    printf 'worktrees_json_sha=%s\n' "$(sha256sum "$registry" | cut -c1-16)"
    node -e '
      const records = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const list = Array.isArray(records) ? records : Object.values(records.records ?? records.worktrees ?? records);
      for (const r of list) if (r && typeof r.managedRoot === "string") console.log(r.managedRoot);
    ' "$registry" | sort | while IFS= read -r copy; do
      printf 'copy_head[%s]=%s\n' "$copy" "$(git -C "$copy" rev-parse HEAD 2>/dev/null || echo missing)"
    done
  else
    printf 'worktrees_json_sha=absent\n'
  fi
}

cmd_prod_check() {
  local mode="${POSITIONAL[0]:-show}" file="$LAB_ROOT/.prod-fingerprint"
  case "$mode" in
    show) prod_fingerprint ;;
    save)
      mkdir -p "$LAB_ROOT"
      prod_fingerprint >"$file"
      info "saved production fingerprint to $file ($(wc -l <"$file") lines)"
      ;;
    compare)
      [[ -f "$file" ]] || die "no saved fingerprint; run: lab.sh prod-check save"
      local now
      now="$(mktemp)"
      prod_fingerprint >"$now"
      if diff -u "$file" "$now"; then
        info "production unchanged: unit start time, listener, checkout, registry and every registered copy's HEAD match the saved fingerprint"
      else
        rm -f "$now"
        die "production state differs from the saved fingerprint (diff above)"
      fi
      rm -f "$now"
      ;;
    *) die "usage: lab.sh prod-check [show|save|compare]" ;;
  esac
}

cmd_doctor() {
  load_prod_launch
  say "production launch source: $PROD_SOURCE"
  say "production DSH_HOME:      $PROD_DSH_HOME"
  say "node:                     ${PROD_ARGV[0]}"
  local key_state="ABSENT (models will not authenticate)" kv
  for kv in "${PROD_ENV[@]}"; do [[ "$kv" == LOCAL_AI_MACHINE_API_KEY=?* ]] && key_state="present (value never printed)"; done
  say "production environment:   ${#PROD_ENV[@]} variables; model API key $key_state"
  say "port $LAB_PORT:           $([[ -z "$(port_listener "$LAB_PORT")" ]] && echo free || echo BUSY)"
  say "lab dir:                  $LAB_DIR"
  for t in git pnpm node rsync ss python3 setsid; do
    command -v "$t" >/dev/null && say "tool $t: ok" || say "tool $t: MISSING"
  done
}

usage() {
  cat <<'EOF'
lab.sh - private dsh instance for verifying plugin / deploy changes before release

Usage: scripts/lab.sh <command> [options]

Commands
  up                    create the lab if needed (clone + install + copy data), start it,
                        verify the boot. Idempotent.
  down                  stop the lab (only its own processes). Idempotent.
  restart               down + start + verify (picks up edits to linked checkouts)
  status                running state, ref, data mode, linked vs pinned plugins, tracked drift
  link <pkg> [path]     pin <pkg> to a local checkout in the lab only (default path:
                        $LAB_ROOT/plugins/dsh-plugins/packages/<dir>, cloned if missing)
  unlink [pkg|--all]    restore the released pin from the lab clone's HEAD and reinstall
  smoke [opts]          run the browser smoke suite against the running lab
                          --only a,b     run just these modules
                          --skip a,b     skip these modules
                          --skip-model   skip checks that need a real model turn
                          --sessions N   how many copied sessions to reopen (default 4)
  reset                 rebuild the lab's data from production (restarts if it was running)
  kill                  SIGKILL the lab server (crash simulation)
  logs                  tail the lab's server log (token redacted)
  destroy               stop and delete the whole lab directory
  doctor                preflight: what the harness would use
  prod-check [save|compare]
                        read-only fingerprint of production (unit start time, :3081, checkout,
                        worktree registry, each registered copy's HEAD); save before, compare after
  help

Options
  --name NAME           lab name (default: default; env LAB_NAME) -> $LAB_ROOT/NAME
  --port N              port (default 3099; env LAB_PORT); 3081 and busy ports are refused
  --ref REF             dsh-deploy ref for a NEW lab (default main; env LAB_REF)
  --source URL|PATH     where to clone dsh-deploy from (env LAB_SOURCE)
  --empty-data          do not copy anything from production
  --sessions N          copy only the N most recent quiet sessions
  --with-worktrees      also copy the registered-worktree registry (copies are REAL and
                        shared with production; never Remove/convert them from the lab)
  --dry-run             print what would happen, change nothing
  --force               (reserved) skip confirmations where any exist

Environment: LAB_ROOT (default ~/dsh-lab), LAB_PLUGINS_DIR, LAB_BOOT_TIMEOUT.

Safety: production is never signalled, restarted or written. The lab refuses port 3081
and any directory inside the production checkout, copies production data read-only,
excludes the scheduled-queue and worktree registry by default, never copies keys, and
runs the loop watchdog observe-only. A link: pin exists only in the lab clone and must
never be committed (node scripts/check-no-links.mjs).
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
main() {
  local cmd="${1:-help}"
  shift || true
  while (($#)); do
    case "$1" in
      --dry-run) DRY=1 ;;
      --empty-data) EMPTY_DATA=1 ;;
      --with-worktrees) WITH_WORKTREES=1 ;;
      --force) FORCE=1 ;;
      --name) LAB_NAME="${2:?--name needs a value}"; shift ;;
      --port) LAB_PORT="${2:?--port needs a value}"; shift ;;
      --ref) LAB_REF="${2:?--ref needs a value}"; shift ;;
      --source) LAB_SOURCE="${2:?--source needs a value}"; shift ;;
      --sessions)
        if [[ "$cmd" == "smoke" ]]; then SMOKE_ARGS+=("--sessions" "${2:?}"); else SESSIONS_LIMIT="${2:?--sessions needs a value}"; fi
        shift
        ;;
      --only | --skip) SMOKE_ARGS+=("$1" "${2:?$1 needs a value}"); shift ;;
      --skip-model | --verbose) SMOKE_ARGS+=("$1") ;;
      -h | --help) cmd=help ;;
      *) POSITIONAL+=("$1") ;;
    esac
    shift
  done
  [[ -z "$SESSIONS_LIMIT" || "$SESSIONS_LIMIT" =~ ^[0-9]+$ ]] || die "--sessions needs a number"
  resolve_paths
  # One mutating command per lab at a time.
  case "$cmd" in
    up | down | restart | reset | link | unlink | destroy | kill)
      mkdir -p "$LAB_ROOT"
      exec 9>"$LAB_ROOT/.$LAB_NAME.lock"
      flock -n 9 || die "another lab.sh command is running for lab '$LAB_NAME'"
      ;;
  esac
  case "$cmd" in
    up) cmd_up ;;
    down) cmd_down ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    link) cmd_link ;;
    unlink) cmd_unlink ;;
    smoke) cmd_smoke ;;
    reset) cmd_reset ;;
    kill) cmd_kill ;;
    logs) cmd_logs ;;
    destroy) cmd_destroy ;;
    doctor) cmd_doctor ;;
    prod-check) cmd_prod_check ;;
    help) usage ;;
    *) usage >&2; die "unknown command '$cmd'" ;;
  esac
}

main "$@"
