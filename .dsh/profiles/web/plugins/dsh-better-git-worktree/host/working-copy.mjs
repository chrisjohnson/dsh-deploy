// dsh-better-git-worktree — working-copy creation and the change-move operation.
//
// Working copies are real `git worktree add` worktrees: the branch and the object
// store stay in the source repository, so there is nothing to clone and nothing
// to keep in sync.
//
// The trade-off is deliberate and expected. A linked worktree keeps its index and
// its branch ref in the source repository's `.git`, and a workspace-write session
// may only write inside its own checkout — so the agent's first `git add` or
// `git commit` inside a worktree asks for the standard sandbox escalation. That
// is the intended shape here (read widely, write locally, escalate explicitly),
// not something to work around by copying the repository.
//
//   createWorktree      `git worktree add -b <branch> <root> <start>`, branched
//                       off the session's *current* HEAD so the working copy
//                       starts exactly where the session was.
//
//   moveWorkingTreeChanges
//                       `git stash push --include-untracked` in the source
//                       checkout, then `git stash apply <sha>` in the working
//                       copy (one shared object store). The stash entry is
//                       intentionally NOT dropped: it stays as a recoverable
//                       backup, and its ref is reported back.
//
// Naming: every working copy gets a two-part pet name (`brave-otter`), used for
// its directory, its branch (`dsh/brave-otter`) and every surface that shows it
// (see host/pet-name.mjs).

import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { allocatePetName } from './pet-name.mjs';
import { gitText, runGit } from './git-runner.mjs';
import { headOid } from './repository.mjs';

const BRANCH_PREFIX = 'dsh';

/** Slug a project name into a branch- and path-safe token. */
function slugify(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug === '' ? 'worktree' : slug;
}

/** Whether `candidate` lies inside `root` (path containment, not string prefix). */
function isInside(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Nearest existing ancestor, so a not-yet-created path can still be probed. */
function nearestExisting(candidate) {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Directory that holds this plugin's managed worktrees.
 *
 * `$DSH_HOME/worktrees` is the obvious home, but it is unusable when it lands
 * inside *any* git working tree — a deployment that keeps `$DSH_HOME` inside a
 * checkout (this one does) would otherwise scatter the working copies into that
 * repository's own `git status`, and a working copy inside an unrelated
 * repository is just as bad. In either case the managed trees move to
 * `~/.dsh-worktrees`.
 */
export async function managedRootBase(homeDir, repoRoot) {
  const preferred = join(homeDir, 'worktrees', 'dsh-better-git-worktree');
  if (await isUsableBase(preferred, repoRoot)) return preferred;
  const fallback = join(homedir(), '.dsh-worktrees', 'dsh-better-git-worktree');
  if (await isUsableBase(fallback, repoRoot)) return fallback;
  return join('/tmp', 'dsh-better-git-worktree');
}

/** A base is usable when it is outside the repository being branched *and* outside every other one. */
async function isUsableBase(candidate, repoRoot) {
  if (isInside(candidate, repoRoot)) return false;
  const probe = nearestExisting(candidate);
  const toplevel = await gitText(probe, ['rev-parse', '--show-toplevel']);
  return toplevel === undefined;
}

/** The managed directory a pet name maps to under an already-resolved base. */
export function managedRootFor(base, project, petName) {
  return join(base, `${slugify(project)}-${petName}`);
}

/** The branch a pet name maps to. */
export function branchFor(petName) {
  return `${BRANCH_PREFIX}/${petName}`;
}

/**
 * Create one managed working copy for a session.
 * @returns `{ repoRoot, managedRoot, branch, petName, baseOid, origin }`
 */
export async function createWorktree(options) {
  const { repoRoot, sessionId, homeDir } = options;
  const baseOid = await headOid(repoRoot);
  if (baseOid === undefined) {
    throw new Error(
      `${repoRoot} has no commit yet (unborn HEAD); commit once before creating a worktree session`,
    );
  }
  const project = basename(repoRoot);
  const base = await managedRootBase(homeDir, repoRoot);
  const petName = await allocatePetName({
    managedRoot: base,
    exists: (name) => existsSync(managedRootFor(base, project, name)),
    hasBranch: async (name) =>
      (await gitText(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchFor(name)}`])) !== undefined,
  });
  const managedRoot = managedRootFor(base, project, petName);
  if (existsSync(managedRoot)) {
    throw new Error(`the managed worktree path ${managedRoot} already exists`);
  }
  mkdirSync(join(managedRoot, '..'), { recursive: true });

  const added = await runGit(
    repoRoot,
    ['worktree', 'add', '-b', branchFor(petName), '--', managedRoot, baseOid],
    { timeoutMs: 300000 },
  );
  if (!added.ok) {
    throw new Error(`git worktree add failed: ${added.stderr.trim() || `exit ${added.code}`}`);
  }
  try {
    return {
      repoRoot,
      managedRoot: realpathSync(managedRoot),
      branch: branchFor(petName),
      petName,
      baseOid,
      origin: (await gitText(repoRoot, ['remote', 'get-url', 'origin'])) ?? repoRoot,
    };
  } catch (error) {
    // Never leave a half-built worktree registered anywhere.
    await runGit(repoRoot, ['worktree', 'remove', '--force', '--', managedRoot], { timeoutMs: 120000 });
    rmSync(managedRoot, { recursive: true, force: true });
    await runGit(repoRoot, ['worktree', 'prune']);
    throw error;
  }
}

/**
 * Move the source checkout's uncommitted work into an existing working copy.
 *
 * The source is stashed first (the stash entry survives as a backup and its ref
 * is reported), then the same change is replayed into the target with
 * `git apply`. Returns `{ moved, stashRef, files }`; `moved: false` means the
 * source tree was already clean.
 */
export async function moveWorkingTreeChanges(repoRoot, managedRoot, label) {
  const statusText = await gitText(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (statusText === undefined) throw new Error(`could not read the working tree status of ${repoRoot}`);
  const fileCount = statusText.split('\0').filter((token) => token !== '').length;
  if (fileCount === 0) return { moved: false, stashRef: undefined, files: 0 };

  const stashed = await runGit(repoRoot, ['stash', 'push', '--include-untracked', '-m', label], {
    timeoutMs: 120000,
  });
  if (!stashed.ok) {
    throw new Error(`git stash push failed: ${stashed.stderr.trim() || `exit ${stashed.code}`}`);
  }
  const stashRef = await gitText(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/stash']);
  if (stashRef === undefined) {
    throw new Error('git stash push reported success but produced no stash entry');
  }
  // Same repository, so the stash commit is directly applicable in the worktree.
  const applied = await runGit(managedRoot, ['stash', 'apply', stashRef], { timeoutMs: 120000 });
  if (!applied.ok) {
    // Put the work back where it came from rather than leaving it only in a
    // stash the user has not been told about yet.
    await runGit(repoRoot, ['stash', 'pop', '--index'], { timeoutMs: 120000 });
    throw new Error(
      `the changes could not be applied inside the new worktree (${applied.stderr.trim() || `exit ${applied.code}`}); they were restored to ${repoRoot}`,
    );
  }
  return { moved: true, stashRef, stashEntry: 'stash@{0}', files: fileCount };
}

/** Whether a recorded worktree root still exists on disk. */
export function worktreeExists(record) {
  return typeof record?.managedRoot === 'string' && existsSync(record.managedRoot);
}

/**
 * Branch-vs-default-branch review data for the sidebar panel.
 * Read-only: commit list, file list, and diffstat between the merge base and HEAD.
 */
export async function branchReview(path, status) {
  const baseRef = status?.baseRef;
  if (baseRef === undefined) {
    return {
      baseRef: undefined,
      commits: [],
      files: [],
      diffstat: '',
      note: 'No default branch on origin could be resolved, so there is nothing to compare against.',
    };
  }
  const mergeBase = await gitText(path, ['merge-base', baseRef, 'HEAD']);
  if (mergeBase === undefined) {
    return { baseRef, commits: [], files: [], diffstat: '', note: `${baseRef} and HEAD share no merge base.` };
  }
  const logText = await gitText(path, ['log', '--oneline', '--no-decorate', `${mergeBase}..HEAD`]);
  const commits = (logText ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const space = line.indexOf(' ');
      return { oid: line.slice(0, space), subject: line.slice(space + 1) };
    });
  const nameStatus = await gitText(path, ['diff', '--name-status', `${mergeBase}..HEAD`]);
  const files = (nameStatus ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [code, ...rest] = line.split('\t');
      return { status: code, path: rest.join('\t') };
    });
  const diffstat = await gitText(path, ['diff', '--stat', `${mergeBase}..HEAD`]);
  const behindBase = status?.behindBase ?? 0;
  const note =
    behindBase > 0
      ? `${baseRef} has ${behindBase} commit${behindBase === 1 ? '' : 's'} this branch does not have yet — a rebase is needed to bring it up to date.`
      : `This branch is up to date with ${baseRef}.`;
  return { baseRef, mergeBase, commits, files, diffstat: diffstat ?? '', note };
}
