#!/usr/bin/env node
// worktree-smoke.mjs — standalone engine test for the dsh-git-worktree
// plugin (no harness needed). Exercises the full engine lifecycle against a
// throwaway repo in a temp dir: create/list/status/remove/prune/sweep,
// collision + safety refusals, and the "never touch external worktrees"
// invariant.
//
// Run: node scripts/worktree-smoke.mjs
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
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
  validSlug,
  validBranchName,
  parseWorktreeListPorcelain,
} from "../dsh-home-seed/profiles/web/plugins/worktree-engine.mjs";

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  -- " + detail : "")); }
}
async function expectError(name, fn, code) {
  try {
    await fn();
    ok(name, false, "expected error, got success");
  } catch (err) {
    ok(name, err instanceof WorktreeError && err.code === code, "got: " + (err?.code ?? err?.message ?? err));
  }
}
function run(cmd, args, cwd) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out, errOut) => {
      if (err) return rej(new Error(cmd + " " + args.join(" ") + " failed: " + errOut));
      res(out);
    });
  });
}
const gitc = (args, cwd) => run("git", args, cwd);

// --- fixtures -------------------------------------------------------------
const root = await mkdtemp(join(tmpdir(), "wt-smoke-"));
const remote = join(root, "remote.git");
const repo = join(root, "repo");
await mkdir(repo, { recursive: true });
await gitc(["init", "--bare", "-b", "main", remote], root);
await gitc(["-c", "user.email=t@t", "-c", "user.name=t", "init", "-b", "main", repo], repo);
await writeFile(join(repo, "README.md"), "hello\n");
await gitc(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], repo);
await gitc(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "one"], repo);
await gitc(["remote", "add", "origin", remote], repo);
await gitc(["push", "-u", "origin", "main"], repo);

console.log("=== validation ===");
ok("slug: basic", validSlug("feature-x"));
ok("slug: max len", validSlug("a".repeat(60)));
ok("slug: rejects upper", !validSlug("Feature"));
ok("slug: rejects leading dot", !validSlug(".x"));
ok("slug: rejects slash", !validSlug("a/b"));
ok("branch: basic", validBranchName("wt/feature-x"));
ok("branch: rejects ..", !validBranchName("wt/a..b"));
ok("branch: rejects trailing dot", !validBranchName("wt/a."));
ok("porcelain parse: basic", (() => {
  const recs = parseWorktreeListPorcelain('worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\nlocked reason "x y"\n');
  return recs.length === 2 && recs[0].branch === "main" && recs[1].detached === true && recs[1].lockReason === "x y";
})());


console.log("=== repo discovery ===");
ok("gitRepoRoot", (await gitRepoRoot(repo)) === repo);
ok("mainCheckoutRoot from main", (await mainCheckoutRoot(repo)) === repo);

console.log("=== create ===");
const created = await worktreeCreate({ repo, slug: "feat-a", base: "head", sessionId: "s-1" });
ok("create: path", created.path === repo + "/.wt/feat-a");
ok("create: branch", created.branch === "wt/feat-a");
const mk1 = await readMarker(created.path);
ok("create: marker + session", mk1?.sessionId === "s-1" && mk1?.branch === "wt/feat-a");
const list1 = await worktreeList({ cwd: repo });
const featA = list1.entries.find((e) => e.path === created.path);
ok("list: dsh role + locked", featA?.role === "dsh" && featA?.locked === true);
ok("list: main role", list1.entries.find((e) => e.role === "main")?.path === repo);
ok("isLinkedWorktree true", await isLinkedWorktree(created.path));
ok("isLinkedWorktree false (main)", !(await isLinkedWorktree(repo)));
ok("mainCheckoutRoot from worktree", (await mainCheckoutRoot(created.path)) === repo);

// work inside it: new file on the branch
await writeFile(join(created.path, "new.txt"), "worktree content\n");
const st1 = await worktreeStatus({ repo, slug: "feat-a" });
ok("status: dirty after touch", st1.dirty === true && st1.dirtyCount >= 1);

// fresh base (remote exists)
const fresh = await worktreeCreate({ repo, slug: "fresh-a", base: "fresh" });
ok("create fresh: no fallback note", !fresh.note);
const freshTip = (await gitc(["rev-parse", "HEAD"], fresh.path)).trim();
const mainTip = (await gitc(["rev-parse", "origin/main"], repo)).trim();
ok("create fresh: at remote default tip", freshTip === mainTip);

console.log("=== collisions ===");
await expectError("create: existing path", () => worktreeCreate({ repo, slug: "feat-a" }), "exists");
await gitc(["-c", "user.email=t@t", "-c", "user.name=t", "branch", "wt/clash", "main"], repo);
await expectError("create: existing branch", () => worktreeCreate({ repo, slug: "clash" }), "branch-exists");
await expectError("create: bad slug", () => worktreeCreate({ repo, slug: "Bad Slug" }), "bad-slug");
await expectError("create: bad base", () => worktreeCreate({ repo, slug: "ok-slug", base: "nope" }), "bad-base");
await expectError("create: not a repo", () => worktreeCreate({ repo: join(root, "nope"), slug: "x" }), "not-a-repo");

console.log("=== remove safety ===");
await expectError("remove: dirty refused", () => worktreeRemove({ repo, slug: "feat-a" }), "not-clean");
await expectError("remove: live session refused", () => worktreeRemove({ repo, slug: "fresh-a", liveSessions: 1 }), "live-sessions");

// make feat-a clean + pushed, then removal succeeds
await gitc(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], created.path);
await gitc(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feat-a commit"], created.path);
await gitc(["push", "-u", "origin", "wt/feat-a"], created.path);
const st2 = await worktreeStatus({ repo, slug: "feat-a" });
ok("status: clean + unpushed 0 after push", st2.dirty === false && st2.unpushed === 0);
const rm1 = await worktreeRemove({ repo, slug: "feat-a" });
ok("remove: success", rm1.removed === true);
let dirGone = true;
try { await stat(created.path); dirGone = false; } catch { /* gone */ }
ok("remove: dir gone", dirGone);
const listAfter = await worktreeList({ cwd: repo });
ok("remove: no longer listed", !listAfter.entries.find((e) => e.path === created.path));
let branchKept = false;
try { await gitc(["show-ref", "--verify", "--quiet", "refs/heads/wt/feat-a"], repo); branchKept = true; } catch { /* gone */ }
ok("remove: branch kept", branchKept);
const cfgTxt = await readFile(join(repo, ".git/config"), "utf8");
ok("remove: .git/config clean of worktreeConfig", !/worktreeConfig|repositoryformatversion\s*=\s*[1-9]/.test(cfgTxt));


console.log("=== force + prune + sweep ===");
// force-removes a dirty worktree
await writeFile(join(fresh.path, "junk.txt"), "uncommitted\n");
const rmf = await worktreeRemove({ repo, slug: "fresh-a", force: true });
ok("remove: force over dirty", rmf.removed === true);

// manual deletion → stale metadata → prune
const stale = await worktreeCreate({ repo, slug: "stale-a", base: "head" });
await rm(stale.path, { recursive: true, force: true });
const listStale = await worktreeList({ cwd: repo });
ok("prune: stale detected", listStale.entries.find((e) => e.path === stale.path)?.dirGone === true);
const pr = await worktreePrune(repo);
ok("prune: metadata dropped", pr.pruned.includes(stale.path));
const listPost = await worktreeList({ cwd: repo });
ok("prune: gone from list", !listPost.entries.find((e) => e.path === stale.path));

// sweep: old clean pushed worktree removed; old dirty one kept; external untouched
const sw1 = await worktreeCreate({ repo, slug: "old-clean", base: "head" });
await gitc(["push", "-u", "origin", "wt/old-clean"], sw1.path);
const sw2 = await worktreeCreate({ repo, slug: "old-dirty", base: "head" });
await writeFile(join(sw2.path, "dirty.txt"), "keep me\n");
// age both markers 10 days
for (const wt of [sw1.path, sw2.path]) {
  const m = await readMarker(wt);
  m.createdAt = new Date(Date.now() - 10 * 86400000).toISOString();
  await import("node:fs/promises").then((mm) => mm.writeFile(wt + "/.dsh-worktree", JSON.stringify(m, null, 2) + "\n"));
}
// external worktree OUTSIDE .wt (created with plain git)
const extPath = join(root, "external-wt");
await run("git", ["worktree", "add", extPath, "-b", "ext-branch", "main"], repo);
const sw = await sweepWorktrees({ repo, worktreeDir: ".wt", cleanupDays: 7, isLive: () => false });
ok("sweep: old clean removed", sw.removed.includes(sw1.path));
const keptOld = sw.kept.find((k) => k.path === sw2.path);
ok("sweep: old dirty kept", !!keptOld && /dirty/.test(keptOld.why));
const listExt = await worktreeList({ cwd: repo });
ok("sweep: external untouched", listExt.entries.find((e) => e.path === extPath)?.role === "external");
// live worktree never swept
const liveWt = await worktreeCreate({ repo, slug: "live-old", base: "head" });
await gitc(["push", "-u", "origin", "wt/live-old"], liveWt.path);
{
  const m = await readMarker(liveWt.path);
  m.createdAt = new Date(Date.now() - 10 * 86400000).toISOString();
  await import("node:fs/promises").then((mm) => mm.writeFile(liveWt.path + "/.dsh-worktree", JSON.stringify(m, null, 2) + "\n"));
}
const sw2r = await sweepWorktrees({ repo, worktreeDir: ".wt", cleanupDays: 7, isLive: (p) => p === liveWt.path });
ok("sweep: live attached kept", sw2r.kept.some((k) => k.path === liveWt.path) && !sw2r.removed.includes(liveWt.path));

console.log("\n" + passed + " passed, " + failed + " failed");
await rm(root, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);


