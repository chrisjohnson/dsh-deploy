// dsh-git-worktree.mjs — host-plane plugin giving dsh sessions isolated
// git worktrees (card K-001, Phase 1).
//
// WHY THIS SHAPE
// The sandbox root of a session is its immutable SessionHeader.cwd
// (dsh-sandbox-policy), so the only way a session stays in workspace-write
// while working in a worktree is (a) the session is ROOTED at the worktree
// path, or (b) the worktree lives UNDER the session's workspace root. This
// plugin therefore:
//   - creates worktrees NESTED under the repo (<repo>/.wt/<slug>) so they
//     are sandbox-writable from any session rooted at the repo;
//   - reports the created path so a NEW session can be started with it as
//     its workspace directory (the directory picker accepts any dir) —
//     that session then has the worktree as its own immutable sandbox root;
//   - registers a per-agent isolation guard for sessions whose cwd IS a dsh
//     worktree, denying mutating tool calls that target the main checkout
//     (the monotonic ctx.tools.guard seam — the dsh analog of Claude Code's
//     non-disableable isolation checks);
//   - tracks live sessions per worktree and refuses removal while any are
//     attached (the oh-my-pi premature-delete failure class);
//   - auto-cleans on the last session leaving (only when clean and pushed),
//     and runs a periodic retention sweep (marker + lock + age + clean +
//     pushed — never external worktrees, never --force).
//
// git execution lives in ./worktree-engine.mjs (pure Node, unit-tested by
// dsh-deploy scripts/worktree-smoke.mjs). This file is the harness glue.
//
// Config (cordis.patch.yml):
//   worktreeDir       (default ".wt")        nested dir under each repo
//   branchPrefix      (default "wt/")        branch = prefix + slug
//   autoCleanup       (default true)         clean worktrees on last session leave
//   cleanupDays       (default 7)            sweep age threshold
//   sweepIntervalMs   (default 3600000)      retention sweep period
//   enforceIsolation  (default true)         per-agent main-checkout guard

import { isAbsolute, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  WorktreeError,
  gitRepoRoot,
  mainCheckoutRoot,
  isLinkedWorktree,
  readMarker,
  worktreeCreate,
  worktreeList,
  worktreeStatus,
  worktreeRemove,
  worktreePrune,
  sweepWorktrees,
} from "./worktree-engine.mjs";

export const name = "dsh-git-worktree";
export const inject = ["tools", "systemPrompt"];
export const Config = z.object({
  worktreeDir: z.string().default(".wt"),
  branchPrefix: z.string().default("wt/"),
  autoCleanup: z.boolean().default(true),
  cleanupDays: z.number().default(7),
  sweepIntervalMs: z.number().default(3600000),
  enforceIsolation: z.boolean().default(true),
});

const log = (msg) => console.log("[dsh-git-worktree] " + msg);

/** true when path === root or is under root/ */
function inside(path, root) {
  return path === root || path.startsWith(root + "/");
}
const isAbs = (p) => isAbsolute(p);
const resolvePath = (p) => resolve(p);

/**
 * What worktree (if any) is a cwd rooted in? Returns
 * { wtPath, marker, mainRepo } or null. cwd may be the worktree root or a
 * subdirectory of it.
 */
async function worktreeInfoForCwd(cwd) {
  if (!cwd) return null;
  const toplevel = await gitRepoRoot(cwd);
  if (!toplevel) return null;
  if (!(await isLinkedWorktree(toplevel))) return null;
  const marker = await readMarker(toplevel);
  if (!marker) return null;
  const mainRepo = (await mainCheckoutRoot(toplevel)) ?? (marker.repo ?? null);
  return { wtPath: toplevel, marker, mainRepo };
}


export function apply(ctx, config) {
  const cfg = config ?? {};
  const wtDir = (cfg.worktreeDir ?? ".wt").replace(/\/+$/, "");
  const branchPrefix = cfg.branchPrefix ?? "wt/";

  // Live-session tracking (this dsh instance only — external pi-web/
  // oh-my-pi sessions are out of scope, see card risk R4).
  const sessionWorktree = new Map(); // sessionId -> wtPath
  const liveByWorktree = new Map();  // wtPath -> Set<sessionId>
  const knownRepos = new Set();

  const isLive = (p) => (liveByWorktree.get(p)?.size ?? 0) > 0;

  const TEXT_OUTPUT = {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }],
  };

  // --- model-facing tools -------------------------------------------------
  ctx.tools.register(defineTool({
    name: "worktree_create",
    description: "Create an isolated git worktree for parallel agent work. The worktree is nested under the repo (sandbox-writable), gets its own locked branch, and is tracked for safe lifecycle management. To work IN it: start a new session with the returned path as its workspace directory, or use it from this session via bash workdir=<path>.",
    parameters: {
      repo: { type: "string", description: "The git repository (or any path inside it) to create the worktree under. Defaults to this session's workspace." },
      slug: { type: "string", required: true, description: "1-60 chars of [a-z0-9._-], starting alphanumeric. Becomes dir <repo>/.wt/<slug> and branch <wt/ prefix><slug>. Must not collide with an existing branch." },
      base: { type: "string", description: "What to branch from: head (default, local HEAD of the main checkout) | fresh (fetch origin, branch from the remote default branch) | branch:<name>." },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
      const repoArg = args.repo ?? cwd;
      const repo = await gitRepoRoot(repoArg);
      if (!repo) throw new WorktreeError(repoArg + " is not inside a git repository", "not-a-repo");
      knownRepos.add(repo);
      const r = await worktreeCreate({ repo, slug: args.slug, base: args.base ?? "head", branchPrefix, sessionId: exec.agent?.id ?? null });
      let text = "Created worktree " + r.path + " on branch " + r.branch + " (base: " + r.baseRef + ").";
      if (r.note) text += " " + r.note;
      text += " It is locked and tracked: start a new session with that path as its workspace directory to work in it under its own sandbox root, or use bash workdir=" + r.path + " from here. Manage it with worktree_status / worktree_remove / worktree_prune.";
      return text;
    },
  }));

  ctx.tools.register(defineTool({
    name: "worktree_list",
    description: "List git worktrees of a repository, annotated with their role (main / dsh-managed / external), branch, lock state, and whether the directory still exists (stale = prunable).",
    parameters: {
      repo: { type: "string", description: "The repository (or any path inside it). Defaults to this session's workspace." },
    },
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
      const { mainRepo, entries } = await worktreeList({ cwd, worktreeDir: wtDir });
      const lines = ["worktrees of " + mainRepo + ":"];
      for (const e of entries) {
        const bits = [];
        if (e.branch) bits.push("[" + e.branch + "]");
        else if (e.detached) bits.push("[detached]");
        if (e.locked) bits.push("locked" + (e.lockReason ? " (" + e.lockReason + ")" : ""));
        if (e.role === "main") bits.push("MAIN CHECKOUT");
        if (e.role === "dsh") bits.push("dsh-managed" + (isLive(e.path) ? ", live session attached" : ""));
        if (e.role === "dsh-unmarked") bits.push("under " + wtDir + "/ but NOT dsh-managed (no marker) — do not remove via this plugin");
        if (e.role === "external") bits.push("external");
        if (e.dirGone) bits.push("DIR GONE (stale metadata — worktree_prune)");
        lines.push("- " + e.path + (bits.length ? " " + bits.join(" ") : ""));
      }
      return lines.join("\n");
    },
  }));

  ctx.tools.register(defineTool({
    name: "worktree_status",
    description: "Status of one dsh worktree (or of this session's own worktree when no slug is given): branch, head, dirty state, unpushed commits, marker.",
    parameters: {
      repo: { type: "string", description: "The repository the worktree lives under. Defaults to this session's workspace." },
      slug: { type: "string", description: "The worktree slug (dir name under .wt/). Omit to inspect this session's own worktree, if it has one." },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
      let repoArg = args.repo;
      let slug = args.slug;
      if (!slug) {
        const info = await worktreeInfoForCwd(cwd);
        if (!info) throw new WorktreeError("no slug given and this session is not rooted in a dsh worktree", "no-slug");
        slug = info.marker?.slug ?? info.wtPath.split("/").pop();
        repoArg = repoArg ?? info.mainRepo;
      }
      const repo = await gitRepoRoot(repoArg ?? cwd);
      if (!repo) throw new WorktreeError((repoArg ?? cwd) + " is not inside a git repository", "not-a-repo");
      knownRepos.add(repo);
      const s = await worktreeStatus({ repo, slug, worktreeDir: wtDir });
      const lines = ["worktree " + s.path + ":"];
      lines.push("- branch: " + (s.branch ?? "(detached)") + " @ " + s.head);
      lines.push("- dirty: " + (s.dirty ? s.dirtyCount + " changed/untracked path(s)" : "no") + (s.dirty ? " e.g. " + s.dirtySample.slice(0, 5).join(", ") : ""));
      lines.push("- unpushed: " + (s.unpushed === null ? "unknown (no upstream — cleanup will keep it)" : String(s.unpushed)));
      if (isLive(s.path)) lines.push("- live dsh session(s) attached: " + liveByWorktree.get(s.path).size);
      return lines.join("\n");
    },
  }));

  ctx.tools.register(defineTool({
    name: "worktree_remove",
    description: "Finish a dsh worktree: unlock, remove, prune metadata. The branch is KEPT. Refused while a live session is attached, and (without force) when the tree is dirty or has unpushed work. force destroys uncommitted/unpushed work — only with explicit user approval.",
    parameters: {
      repo: { type: "string", description: "The repository the worktree lives under. Defaults to this session's workspace." },
      slug: { type: "string", description: "The worktree slug. Omit to remove this session's own worktree, if it has one." },
      force: { type: "boolean", description: "Remove even if dirty or unpushed. Requires explicit user approval — do not set on your own initiative." },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
      let repoArg = args.repo;
      let slug = args.slug;
      if (!slug) {
        const info = await worktreeInfoForCwd(cwd);
        if (!info) throw new WorktreeError("no slug given and this session is not rooted in a dsh worktree", "no-slug");
        slug = info.marker?.slug ?? info.wtPath.split("/").pop();
        repoArg = repoArg ?? info.mainRepo;
      }
      const repo = await gitRepoRoot(repoArg ?? cwd);
      if (!repo) throw new WorktreeError((repoArg ?? cwd) + " is not inside a git repository", "not-a-repo");
      const live = liveByWorktree.get(repo + "/" + wtDir + "/" + slug)?.size ?? 0;
      const r = await worktreeRemove({ repo, slug, worktreeDir: wtDir, force: args.force === true, liveSessions: live });
      let text = "Removed worktree " + repo + "/" + wtDir + "/" + slug + ". Branch kept — push/open a PR from it when ready, then delete the branch if unneeded.";
      if (r.configWarning) text += " WARNING: " + r.configWarning;
      return text;
    },
  }));

  ctx.tools.register(defineTool({
    name: "worktree_prune",
    description: "Drop stale worktree metadata (directories that were deleted out from under — manual cleanup, re-clone). Safe and idempotent; also runs after every plugin removal.",
    parameters: {
      repo: { type: "string", description: "The repository (or any path inside it). Defaults to this session's workspace." },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
      const repo = await gitRepoRoot(args.repo ?? cwd);
      if (!repo) throw new WorktreeError((args.repo ?? cwd) + " is not inside a git repository", "not-a-repo");
      knownRepos.add(repo);
      const r = await worktreePrune(repo);
      return r.pruned.length
        ? "Pruned stale metadata for: " + r.pruned.join(", ")
        : "Nothing to prune — all worktree metadata is healthy.";
    },
  }));

  // --- isolation guard ----------------------------------------------------
  // Mutating tools whose target path we can determine. Read-only tools
  // (read/grep/glob) may touch the main checkout freely — mirroring Claude
  // Code, which only blocks writes. run_code (code-mode transport) is not
  // guarded: its SDK sub-dispatches execute the leaf tools, which ARE
  // guarded individually.
  const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

  function targetPaths(toolName, args, cwd) {
    const out = [];
    const push = (p) => {
      if (typeof p !== "string" || p.length === 0) return;
      try {
        const abs = isAbs(p) ? p : (cwd ? cwd + "/" + p : p);
        out.push(resolvePath(abs));
      } catch { /* unresolvable: skip */ }
    };
    if (toolName === "bash") {
      push(args.workdir);
      // conservative (card risk R2): any bash command naming the main
      // checkout's absolute path targets it (covers "git -C <main> ..."
      // redirects); the model should use the worktree tools instead.
      if (typeof args.command === "string") out.push("__CMD__" + args.command);
    } else if (toolName === "write" || toolName === "edit") {
      push(args.file_path);
    }
    return out;
  }

  function registerGuard(agent, info) {
    const mainRoot = info.mainRepo;
    const wtRoot = info.wtPath;
    if (!mainRoot) {
      log("guard skipped for " + agent.id + ": could not resolve main checkout root for " + wtRoot);
      return;
    }
    const dispose = agent.ctx.tools.guard((execution) => {
      try {
        if (!MUTATING_TOOLS.has(execution.name)) return undefined;
        const args = execution.arguments && typeof execution.arguments === "object" ? execution.arguments : {};
        const cwd = execution.agent?.session?.header?.cwd ?? null;
        const targets = targetPaths(execution.name, args, cwd);
        for (const t of targets) {
          if (t.startsWith("__CMD__")) {
            const cmd = t.slice(7);
            if (cmd.includes(mainRoot)) {
              log("guard denied " + execution.name + " in worktree " + wtRoot + ": command references main checkout " + mainRoot);
              return "worktree isolation: this session lives in worktree " + wtRoot + "; that bash command references the main checkout (" + mainRoot + "). Keep git operations inside your worktree — for repo-wide queries use the worktree_* tools, and for the main checkout ask the user.";
            }
            continue;
          }
          if (inside(t, mainRoot) && !inside(t, wtRoot)) {
            log("guard denied " + execution.name + " -> " + t + " (main checkout) in worktree " + wtRoot);
            return "worktree isolation: this session lives in worktree " + wtRoot + "; the call targets " + t + " inside the main checkout " + mainRoot + ". Keep all writes inside your worktree (bash: pass workdir inside " + wtRoot + "; file tools: use paths under " + wtRoot + ").";
          }
        }
        return undefined;
      } catch {
        return undefined; // a guard failure must never wedge a session
      }
    });
    void dispose;
  }

  // --- lifecycle ------------------------------------------------------------
  async function handleCreated(agent) {
    try {
      const cwd = agent.session?.header?.cwd ?? null;
      const info = await worktreeInfoForCwd(cwd);
      if (!info) return;
      sessionWorktree.set(agent.id, info.wtPath);
      let set = liveByWorktree.get(info.wtPath);
      if (!set) { set = new Set(); liveByWorktree.set(info.wtPath, set); }
      set.add(agent.id);
      if (info.mainRepo) knownRepos.add(info.mainRepo);
      log("session " + agent.id + " attached to worktree " + info.wtPath + " (branch " + (info.marker?.branch ?? "?") + ")");
      if (cfg.enforceIsolation !== false) registerGuard(agent, info);
    } catch (err) {
      log("agent/created handling failed: " + (err?.message ?? err));
    }
  }

  async function autoCleanup(wtPath) {
    try {
      const marker = await readMarker(wtPath);
      const repo = (marker?.repo && (await gitRepoRoot(marker.repo))) ?? (await mainCheckoutRoot(wtPath));
      if (!repo) { log("auto-cleanup: cannot resolve repo for " + wtPath + " — leaving for sweep/human"); return; }
      const slug = wtPath.split("/").pop();
      await worktreeRemove({ repo, slug, worktreeDir: wtDir, liveSessions: 0 });
      log("auto-cleanup: removed clean worktree " + wtPath + " (branch kept: " + (marker?.branch ?? "?") + ")");
    } catch (err) {
      // refusal is the expected path (dirty / unpushed / unknown): the
      // worktree stays for the user, and the sweep re-evaluates it later
      log("auto-cleanup kept " + wtPath + ": " + (err?.message ?? err));
    }
  }

  async function handleDisposed(agent) {
    const wtPath = sessionWorktree.get(agent.id);
    if (!wtPath) return;
    sessionWorktree.delete(agent.id);
    const set = liveByWorktree.get(wtPath);
    if (set) {
      set.delete(agent.id);
      if (set.size === 0) {
        liveByWorktree.delete(wtPath);
        if (cfg.autoCleanup !== false) log("last session left " + wtPath + " — auto-cleanup evaluating");
        else log("last session left " + wtPath + " — kept (autoCleanup disabled)");
      }
    }
    if (cfg.autoCleanup !== false && !(liveByWorktree.get(wtPath)?.size)) {
      void autoCleanup(wtPath);
    }
  }

  ctx.on("agent/created", ({ agent }) => { void handleCreated(agent); });
  ctx.on("agent/disposed", ({ agent }) => { void handleDisposed(agent); });

  // --- retention sweep --------------------------------------------------------
  async function sweepAll() {
    for (const repo of [...knownRepos]) {
      try {
        const r = await sweepWorktrees({ repo, worktreeDir: wtDir, cleanupDays: cfg.cleanupDays ?? 7, isLive });
        if (r.removed.length > 0) log("sweep removed: " + r.removed.join(", "));
        for (const k of r.kept) log("sweep kept " + k.path + ": " + k.why);
      } catch (err) {
        log("sweep failed for " + repo + ": " + (err?.message ?? err));
      }
    }
  }
  const timer = setInterval(() => { void sweepAll(); }, (cfg.sweepIntervalMs ?? 3600000) > 0 ? cfg.sweepIntervalMs : 3600000);
  if (typeof timer.unref === "function") timer.unref();

  // --- prompt contribution ------------------------------------------------------
  ctx.systemPrompt.section({
    name: "tool:git-worktree",
    order: 110,
    text:
      "Git worktrees: parallel agent sessions get isolated git worktrees managed by this deployment. " +
      "Worktrees live under <repo>/.wt/<slug> on branches wt/<slug> (locked, marker-tracked, prunable). " +
      "Tools: worktree_list (inspect all), worktree_create (slug: 1-60 chars of [a-z0-9._-]; base: head | fresh | branch:<name>), " +
      "worktree_status, worktree_remove (refused while dirty, unpushed, or session-attached; force needs explicit user approval; the branch is always kept), " +
      "worktree_prune (stale metadata). " +
      "To work in a worktree: start a new session with the worktree path as its workspace directory (it becomes that session's sandbox root), " +
      "or use bash workdir=<worktree path> from here. " +
      "Never delete a worktree directory with rm -rf — removal must go through worktree_remove so locks, metadata, and shared config stay clean. " +
      "If this session's workspace is itself a worktree, keep all writes inside it: mutating calls targeting the main checkout are denied by an isolation guard.",
  });
}



