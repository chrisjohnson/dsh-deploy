// worktree-engine.mjs — dependency-free git-worktree engine for the
// dsh-git-worktree plugin (host plane).
//
// Pure Node (fs/path/child_process only) so it can be unit-tested without a
// live harness (see dsh-deploy scripts/worktree-smoke.mjs) and reused by
// other profiles later. All git calls go through one execFile wrapper with
// hard timeouts and GIT_TERMINAL_PROMPT=0, so a stalled fetch or a stray
// credential prompt can never hang a dsh process — git failing is a
// WorktreeError the caller reports, never a wedge.
//
// Safety model (see .fleet/board/now/K-001):
// - dsh-owned worktrees carry a marker file (.dsh-worktree) written at
//   creation; removal/sweep refuse to touch worktrees without one.
// - A worktree is locked (git worktree lock) while dsh owns it so external
//   tooling (or a second sweep) cannot race it.
// - Removal is refused for dirty trees or unpushed work unless an explicit
//   force is passed; live-session refusal is enforced by the plugin (it
//   owns the session map), not here.
// - After removal, git worktree prune runs and the main .git/config is
//   verified to be free of stale worktreeConfig/repositoryformatversion
//   (Anthropic #45645 class of poisoning).

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export class WorktreeError extends Error {
  /** @param {string} code stable machine-readable reason */
  constructor(message, code = "error") {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
}

/**
 * Run one git command. Resolves { code, stdout, stderr }; never rejects for
 * non-zero exits (callers classify), rejects only for spawn-level failure.
 * @param {string[]} args git argv (no "git")
 * @param {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal }} opts
 */
export async function git(args, opts = {}) {
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? 30000;
  if (!cwd) throw new WorktreeError("git call without cwd", "internal");
  try {
    const r = await new Promise((res, rej) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" },
          maxBuffer: 16 * 1024 * 1024,
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (err, out, errOut) => {
          if (err && typeof err.code === "number") return res({ code: err.code, stdout: out ?? "", stderr: errOut ?? "" });
          if (err) return rej(err);
          res({ code: 0, stdout: out ?? "", stderr: errOut ?? "" });
        },
      );
    });
    return r;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/timeout/i.test(msg)) throw new WorktreeError("git " + args[0] + " timed out after " + timeoutMs + "ms", "timeout");
    throw new WorktreeError("git " + args[0] + " failed to start: " + msg, "spawn");
  }
}

/** Trim git stderr to its last three non-empty lines (model-readable). */
export function gitErrorDetail(out) {
  const lines = String(out).trim().split("\n").filter(Boolean);
  return lines.slice(-3).join(" | ") || "(no detail)";
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/;
export function validSlug(slug) {
  return SLUG_RE.test(slug ?? "");
}
export function validBranchName(branch) {
  if (typeof branch !== "string" || branch.length === 0 || branch.length > 100) return false;
  if (!/^\w[\w./-]*$/.test(branch)) return false;
  if (branch.includes("..") || branch.includes("@{")) return false;
  if (branch.endsWith("/") || branch.endsWith(".lock") || branch.endsWith(".")) return false;
  return true;
}

// MARKER
export const MARKER_NAME = ".dsh-worktree";
const MARKER_SCHEMA = "dsh-git-worktree/1";

/** Read the dsh marker from a worktree root; null when absent/invalid. */
export async function readMarker(wtPath) {
  try {
    const raw = await readFile(join(wtPath, MARKER_NAME), "utf8");
    const m = JSON.parse(raw);
    return m && m.schema === MARKER_SCHEMA ? m : null;
  } catch {
    return null;
  }
}

/** Write the dsh marker (adds schema + createdAt). */
export async function writeMarker(wtPath, marker) {
  const m = { schema: MARKER_SCHEMA, ...marker, createdAt: new Date().toISOString() };
  await writeFile(join(wtPath, MARKER_NAME), JSON.stringify(m, null, 2) + "\n", { mode: 0o644 });
  return m;
}

// Repo discovery
/**
 * Resolve the working-tree root of the repo containing cwd.
 * @returns {Promise<string>} absolute repo root, or null if not a git repo
 */
export async function gitRepoRoot(cwd) {
  const r = await git(["rev-parse", "--show-toplevel"], { cwd });
  if (r.code !== 0) return null;
  const out = r.stdout.trim();
  return out ? out : null;
}

/**
 * Main checkout root for a path (any worktree or the main tree itself):
 * parent of the repo's common .git dir. For a linked worktree the common
 * dir is still the MAIN checkout's .git, so dirname(common) is the main
 * root in both cases.
 * @returns {Promise<string|null>} absolute main checkout root
 */
export async function mainCheckoutRoot(path) {
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path });
  if (r.code !== 0) return null;
  const common = r.stdout.trim();
  if (!common) return null;
  const root = dirname(common);
  // sanity: the resolved root must actually be a worktree of this repo
  const back = await git(["rev-parse", "--show-toplevel"], { cwd: root });
  return back.code === 0 && back.stdout.trim() === root ? root : null;
}

/**
 * True when path is a LINKED worktree (not the main checkout): its own
 * git dir lives under <common>/.git/worktrees/<name>.
 */
export async function isLinkedWorktree(path) {
  const common = await (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path })).stdout.trim();
  if (!common) return false;
  const own = (await git(["rev-parse", "--absolute-git-dir"], { cwd: path })).stdout.trim();
  return own.startsWith(common + "/worktrees/");
}


// Creation
/**
 * Resolve the base ref for a worktree.
 *  - "head"   → HEAD of the main checkout (always works, no network)
 *  - "branch:<name>" → the tip of that branch
 *  - "fresh"  → fetch origin, then the remote's default branch
 *               (origin/HEAD); falls back to "head" with a note when the
 *               repo has no usable remote or the fetch fails, so
 *               worktree creation is never blocked by the network.
 * @returns {{ ref: string, note?: string }}
 */
async function resolveBase(repo, base) {
  if (!base || base === "head") return { ref: "HEAD" };
  if (base.startsWith("branch:")) {
    const name = base.slice("branch:".length);
    if (!name) throw new WorktreeError("base 'branch:' given no branch name", "bad-base");
    return { ref: name };
  }
  if (base === "fresh") {
    const f = await git(["fetch", "origin", "--prune", "--quiet"], { cwd: repo, timeoutMs: 60000 });
    if (f.code !== 0) {
      return { ref: "HEAD", note: "fetch failed (" + gitErrorDetail(f.stderr) + ") — branched from local HEAD instead" };
    }
    const sym = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repo });
    let def = sym.code === 0 ? sym.stdout.trim().replace(/^refs\/remotes\//, "") : "";
    if (!def) {
      for (const cand of ["origin/main", "origin/master"]) {
        const v = await git(["show-ref", "--verify", "--quiet", "refs/remotes/" + cand], { cwd: repo });
        if (v.code === 0) { def = cand; break; }
      }
    }
    if (!def) return { ref: "HEAD", note: "no origin/HEAD or origin/main|master found — branched from local HEAD instead" };
    return { ref: def };
  }
  throw new WorktreeError("unknown base: " + base + " (expected head, fresh, or branch:<name>)", "bad-base");
}

/**
 * Create a dsh-managed linked worktree.
 * @param {{ repo: string, slug: string, base?: string, branchPrefix?: string,
 *           worktreeDir?: string, sessionId?: string, signal?: AbortSignal }} a
 * @returns {Promise<{ path: string, branch: string, baseRef: string, note?: string }>}
 */
export async function worktreeCreate(a) {
  const repo = a.repo;
  const slug = a.slug;
  if (!validSlug(slug)) throw new WorktreeError("invalid slug: " + slug + " (use 1-60 chars of [a-z0-9._-], starting alphanumeric)", "bad-slug");
  const branchPrefix = a.branchPrefix ?? "wt/";
  const branch = branchPrefix + slug;
  if (!validBranchName(branch)) throw new WorktreeError("invalid branch name: " + branch, "bad-branch");
  const wtDir = (a.worktreeDir ?? ".wt").replace(/\/+$/, "");
  const wtPath = join(repo, wtDir, slug);

  // collision checks — fail loud, never retry-guess (one worktree per branch)
  let repoExists = true;
  try { await stat(repo); } catch { repoExists = false; }
  if (!repoExists) throw new WorktreeError(repo + " does not exist", "not-a-repo");
  const rootCheck = await git(["rev-parse", "--show-toplevel"], { cwd: repo });
  if (rootCheck.code !== 0 || rootCheck.stdout.trim() !== repo) {
    throw new WorktreeError(repo + " is not a git working-tree root (got: " + (rootCheck.stdout.trim() || "none") + ")", "not-a-repo");
  }
  let pathExists = false;
  try { await stat(wtPath); pathExists = true; } catch { /* absent — good */ }
  if (pathExists) throw new WorktreeError("path already exists: " + wtPath, "exists");
  const branchExists = await git(["show-ref", "--verify", "--quiet", "refs/heads/" + branch], { cwd: repo });
  if (branchExists.code === 0) throw new WorktreeError("branch already exists: " + branch + " (a branch may be checked out in only one worktree)", "branch-exists");

  const { ref, note } = await resolveBase(repo, a.base ?? "head");
  const r = await git(["worktree", "add", "-b", branch, wtPath, ref], { cwd: repo, signal: a.signal, timeoutMs: 120000 });
  if (r.code !== 0) throw new WorktreeError("git worktree add failed: " + gitErrorDetail(r.stderr), "add-failed");

  await writeMarker(wtPath, { sessionId: a.sessionId ?? null, base: a.base ?? "head", baseRef: ref, repo, branch, slug });
  // Make the marker invisible to git: "git worktree remove" refuses on ANY
  // untracked file, so without this the marker itself would make every dsh
  // worktree look dirty to git. Verified on git 2.39.5: only the COMMON
  // exclude (.git/info/exclude) is honored — the per-worktree gitdir's
  // info/exclude is read by nothing. Appended idempotently; the pattern is
  // harmless in the main checkout (no such file exists there).
  try {
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: wtPath })).stdout.trim();
    const excludeFile = join(common, "info", "exclude");
    await mkdir(dirname(excludeFile), { recursive: true });
    let existing = [""];
    try { existing = (await readFile(excludeFile, "utf8")).split("\n"); } catch { /* no exclude file yet */ }
    if (!existing.includes(MARKER_NAME)) {
      await writeFile(excludeFile, existing.join("\n").replace(/\n*$/, "\n") + MARKER_NAME + "\n");
    }
  } catch { /* exclude is best-effort: the dirty-line filter is the fallback */ }
  const lock = await git(["worktree", "lock", wtPath, "--reason", "dsh-git-worktree session " + (a.sessionId ?? "unattached")], { cwd: repo });
  if (lock.code !== 0) {
    // lock failure is non-fatal (metadata-only protection) but reported
    note = (note ? note + "; " : "") + "warning: could not lock worktree: " + gitErrorDetail(lock.stderr);
  }
  return { path: wtPath, branch, baseRef: ref, ...(note ? { note } : {}) };
}


// Listing / status
/**
 * Parse "git worktree list --porcelain" output into records.
 * Records are blank-line separated:
 *   worktree <abs-path>
 *   HEAD <sha>
 *   branch refs/heads/<name>      (absent when detached)
 *   detached                      (optional)
 *   locked [reason "..."]         (optional)
 */
export function parseWorktreeListPorcelain(out) {
  const records = [];
  let cur = null;
  for (const line of String(out).split("\n")) {
    if (line.trim() === "") {
      if (cur) { records.push(cur); cur = null; }
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? "" : line.slice(sp + 1);
    if (!cur) cur = { path: null, head: null, branch: null, detached: false, locked: false, lockReason: null };
    if (key === "worktree") cur.path = val;
    else if (key === "HEAD") cur.head = val;
    else if (key === "branch") cur.branch = val.replace(/^refs\/heads\//, "");
    else if (key === "detached") cur.detached = true;
    else if (key === "locked") {
      cur.locked = true;
      const m = val.match(/^reason "(.*)"( |$)/);
      cur.lockReason = m ? m[1] : (val || null);
    }
  }
  if (cur) records.push(cur);
  return records.filter((r) => r.path);
}

/**
 * List worktrees of the repo containing a path, annotated:
 *  - role: "main" | "dsh" (dsh-owned: marker present) | "dsh-unmarked"
 *    (under the wt dir but no marker) | "external"
 *  - marker: the dsh marker when present
 *  - dirGone: metadata present but the directory is gone (prune candidate)
 * @param {{ cwd: string, worktreeDir?: string }} a
 */
export async function worktreeList(a) {
  const repo = await gitRepoRoot(a.cwd);
  if (!repo) throw new WorktreeError(a.cwd + " is not inside a git repository", "not-a-repo");
  const wtDir = (a.worktreeDir ?? ".wt").replace(/\/+$/, "");
  const r = await git(["worktree", "list", "--porcelain"], { cwd: repo });
  if (r.code !== 0) throw new WorktreeError("git worktree list failed: " + gitErrorDetail(r.stderr), "list-failed");
  const entries = [];
  for (const rec of parseWorktreeListPorcelain(r.stdout)) {
    let dirGone = false;
    try { await stat(rec.path); } catch { dirGone = true; }
    const marker = dirGone ? null : await readMarker(rec.path);
    const role = rec.path === repo
      ? "main"
      : marker
        ? "dsh"
        : rec.path.startsWith(repo + "/" + wtDir + "/")
          ? "dsh-unmarked"
          : "external";
    entries.push({ ...rec, mainRepo: repo, dirGone, marker, role });
  }
  return { mainRepo: repo, entries };
}

/**
 * Dirty lines of a worktree: porcelain output minus the dsh marker file
 * (the marker is plugin metadata, not user work — it must never make the
 * tree look dirty).
 */
async function dirtyLines(wtPath) {
  const r = await git(["status", "--porcelain"], { cwd: wtPath, timeoutMs: 120000 });
  if (r.code !== 0) throw new WorktreeError("git status failed: " + gitErrorDetail(r.stderr), "status-failed");
  return r.stdout.trim().split("\n").filter((l) => l !== "" && l !== "?? " + MARKER_NAME);
}

/**
 * Status of one dsh worktree: branch, head, dirty (count + sample), and
 * unpushed commit count (null = no upstream / unknown — treated as "keep"
 * by cleanup).
 * @param {{ repo: string, slug: string, worktreeDir?: string }} a
 */
export async function worktreeStatus(a) {
  const wtDir = (a.worktreeDir ?? ".wt").replace(/\/+$/, "");
  const wtPath = join(a.repo, wtDir, a.slug);
  const st = await git(["rev-parse", "--show-toplevel"], { cwd: wtPath });
  if (st.code !== 0) throw new WorktreeError("no worktree at " + wtPath, "missing");
  const marker = await readMarker(wtPath);
  const lines = await dirtyLines(wtPath);
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: wtPath });
  let unpushed = null;
  if (upstream.code === 0) {
    const c = await git(["rev-list", "--count", "@{u}..HEAD"], { cwd: wtPath });
    unpushed = c.code === 0 ? Number(c.stdout.trim() || 0) : null;
  }
  return {
    path: wtPath,
    slug: a.slug,
    branch: marker?.branch ?? null,
    head: (await git(["rev-parse", "--short", "HEAD"], { cwd: wtPath })).stdout.trim(),
    dirty: lines.length > 0,
    dirtyCount: lines.length,
    dirtySample: lines.slice(0, 10),
    unpushed,
    marker,
  };
}


// Removal / prune / sweep
/**
 * Remove a dsh-managed worktree (unlock + remove + prune + config check).
 * Refuses: non-dsh worktrees (no marker), live-attached worktrees (the
 * caller passes liveSessions > 0), and dirty/unpushed worktrees unless
 * force. The branch is KEPT on every path (delivery/PR is a separate act).
 * @param {{ repo: string, slug: string, worktreeDir?: string, force?: boolean,
 *           liveSessions?: number }} a
 * @returns {Promise<{ removed: boolean, configWarning?: string }>}
 */
export async function worktreeRemove(a) {
  const wtDir = (a.worktreeDir ?? ".wt").replace(/\/+$/, "");
  const wtPath = join(a.repo, wtDir, a.slug);
  const st = await git(["rev-parse", "--show-toplevel"], { cwd: wtPath });
  if (st.code !== 0) throw new WorktreeError("no worktree at " + wtPath + " (already gone? run prune)", "missing");
  const marker = await readMarker(wtPath);
  if (!marker) throw new WorktreeError("refusing to remove " + wtPath + ": no dsh marker (not dsh-managed)", "not-dsh-owned");
  if ((a.liveSessions ?? 0) > 0) {
    throw new WorktreeError("refusing to remove " + wtPath + ": " + a.liveSessions + " live dsh session(s) are attached to it", "live-sessions");
  }
  if (!a.force) {
    const dirty = (await dirtyLines(wtPath)).length > 0;
    let unpushed = null;
    const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: wtPath });
    if (up.code === 0) {
      const c = await git(["rev-list", "--count", "@{u}..HEAD"], { cwd: wtPath });
      unpushed = c.code === 0 ? Number(c.stdout.trim() || 0) : null;
    }
    const problems = [];
    if (dirty) problems.push("uncommitted changes");
    if (unpushed === null) problems.push("unpushed work (no upstream — cannot verify)");
    else if (unpushed > 0) problems.push(unpushed + " unpushed commit(s)");
    if (problems.length > 0) {
      throw new WorktreeError("refusing to remove " + wtPath + ": " + problems.join(", ") + " — commit/push first, or pass force with explicit user approval", "not-clean");
    }
  }
  await git(["worktree", "unlock", wtPath], { cwd: a.repo });
  const rm = await git(a.force ? ["worktree", "remove", "--force", wtPath] : ["worktree", "remove", wtPath], { cwd: a.repo, timeoutMs: 60000 });
  if (rm.code !== 0) throw new WorktreeError("git worktree remove failed: " + gitErrorDetail(rm.stderr), "remove-failed");
  await git(["worktree", "prune"], { cwd: a.repo });
  // config poisoning check (Anthropic #45645 class): report, do not rewrite
  let configWarning;
  try {
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: a.repo })).stdout.trim();
    const cfg = await readFile(common + "/config", "utf8");
    if (/worktreeConfig|repositoryformatversion\s*=\s*[1-9]/.test(cfg)) {
      configWarning = "shared .git/config still references worktree extensions — inspect " + common + "/config manually";
    }
  } catch { /* config unreadable: nothing to warn about */ }
  return { removed: true, ...(configWarning ? { configWarning } : {}) };
}

/**
 * Drop stale worktree metadata (directories deleted out from under —
 * manual cleanup, container re-clone). Safe to run anytime.
 * @returns {Promise<{ pruned: string[] }>} paths whose metadata was pruned
 */
export async function worktreePrune(repo) {
  const before = (await worktreeList({ cwd: repo })).entries;
  // git worktree prune skips LOCKED entries; dsh locks its own worktrees,
  // so a manually-deleted dsh worktree would otherwise stay stale forever.
  // Unlock only the stale entries WE locked (lock reason prefix), then prune.
  for (const e of before.filter((x) => x.dirGone && x.locked && (x.lockReason ?? "").startsWith("dsh-git-worktree"))) {
    await git(["worktree", "unlock", e.path], { cwd: repo });
  }
  const r = await git(["worktree", "prune"], { cwd: repo });
  if (r.code !== 0) throw new WorktreeError("git worktree prune failed: " + gitErrorDetail(r.stderr), "prune-failed");
  const after = (await worktreeList({ cwd: repo })).entries;
  const afterPaths = new Set(after.map((e) => e.path));
  const pruned = before.filter((e) => e.dirGone && !afterPaths.has(e.path)).map((e) => e.path);
  return { pruned };
}

/**
 * Retention sweep over dsh-owned worktrees of one repo: remove those that
 * are clean, verified-pushed (unpushed === 0), unattached (isLive false),
 * and older than cleanupDays. Never touches external worktrees, unmarked
 * dirs, dirty/unpushed/attached ones. Returns what it removed + kept-why.
 * @param {{ repo: string, worktreeDir?: string, cleanupDays?: number,
 *           isLive?: (path: string) => boolean }} a
 */
export async function sweepWorktrees(a) {
  const wtDir = (a.worktreeDir ?? ".wt").replace(/\/+$/, "");
  const cleanupDays = a.cleanupDays ?? 7;
  const isLive = a.isLive ?? (() => false);
  const { mainRepo, entries } = await worktreeList({ cwd: a.repo, worktreeDir: wtDir });
  const removed = [];
  const kept = [];
  for (const e of entries) {
    if (e.role !== "dsh" || e.dirGone) continue;
    const ageDays = e.marker?.createdAt ? (Date.now() - Date.parse(e.marker.createdAt)) / 86400000 : Infinity;
    if (!isFinite(ageDays) || ageDays < cleanupDays) { kept.push({ path: e.path, why: "younger than " + cleanupDays + "d" }); continue; }
    if (isLive(e.path)) { kept.push({ path: e.path, why: "live session attached" }); continue; }
    try {
      const s = await worktreeStatus({ repo: mainRepo, slug: e.path.split("/").pop(), worktreeDir: wtDir });
      if (s.dirty) { kept.push({ path: e.path, why: "dirty" }); continue; }
      if (s.unpushed !== 0) { kept.push({ path: e.path, why: s.unpushed === null ? "push state unknown" : s.unpushed + " unpushed" }); continue; }
      await worktreeRemove({ repo: mainRepo, slug: s.slug, worktreeDir: wtDir, liveSessions: 0 });
      removed.push(e.path);
    } catch (err) {
      kept.push({ path: e.path, why: "check failed: " + (err?.message ?? err) });
    }
  }
  await worktreePrune(mainRepo);
  return { removed, kept };
}




