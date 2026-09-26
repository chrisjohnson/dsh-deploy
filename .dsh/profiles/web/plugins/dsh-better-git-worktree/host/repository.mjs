// dsh-better-git-worktree — repository facts and the worktree status fold.
//
// One status read is a handful of fast local git commands (no network). The
// result is the single source for both the session-list indicator and the
// dropdown panel, so they can never disagree.

import { runGit, gitText } from './git-runner.mjs';

/** Strip a trailing newline only; git output is otherwise significant. */
function lines(text) {
  if (text === undefined) return [];
  const trimmed = text.replace(/\n$/, '');
  return trimmed === '' ? [] : trimmed.split('\n');
}

/** Absolute repository root for a working directory, or undefined outside a repo. */
export function repoRoot(cwd) {
  return gitText(cwd, ['rev-parse', '--show-toplevel']);
}

/** Current branch name, or a detached-HEAD marker. */
export async function currentBranch(cwd) {
  const name = await gitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (name === undefined) return undefined;
  return name === 'HEAD' ? undefined : name;
}

/** Current HEAD commit, or undefined on an unborn branch. */
export function headOid(cwd) {
  return gitText(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
}

/** Whether the working directory belongs to a linked worktree rather than the main checkout. */
export async function isLinkedWorktree(cwd) {
  const gitDir = await gitText(cwd, ['rev-parse', '--absolute-git-dir']);
  const commonDir = await gitText(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (gitDir === undefined || commonDir === undefined) return undefined;
  return gitDir !== commonDir;
}

/**
 * The repository's default branch name (not a ref).
 * Prefers `origin/HEAD`, then the usual candidates, then the branch the repo
 * currently has checked out in its main worktree.
 */
export async function defaultBranch(cwd) {
  const symbolic = await gitText(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic !== undefined && symbolic.startsWith('refs/remotes/origin/')) {
    return symbolic.slice('refs/remotes/origin/'.length);
  }
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    const remote = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`]);
    if (remote !== undefined) return candidate;
  }
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    const local = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (local !== undefined) return candidate;
  }
  return undefined;
}

/** Resolve the comparison ref for "the default branch on origin". */
export async function baseRefFor(cwd, branch) {
  if (branch === undefined) {
    for (const candidate of ['main', 'master']) {
      if ((await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])) !== undefined) {
        return `origin/${candidate}`;
      }
    }
    return undefined;
  }
  const remote = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (remote !== undefined) return `origin/${branch}`;
  const local = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return local === undefined ? undefined : branch;
}

/** Parse `git status --porcelain=v1 -z` into change counts. */
function parsePorcelain(text) {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const files = [];
  const tokens = text.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '') continue;
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    if (xy === '??') {
      untracked += 1;
    } else {
      if (xy[0] !== ' ' && xy[0] !== '?') staged += 1;
      if (xy[1] !== ' ' && xy[1] !== '?') unstaged += 1;
      // A rename/copy emits a second NUL-framed path we do not need.
      if (xy[0] === 'R' || xy[0] === 'C') index += 1;
    }
    if (files.length < 200) files.push({ path, xy });
  }
  return { staged, unstaged, untracked, files, dirty: staged + unstaged + untracked };
}

/** Parse `git rev-list --left-right --count A...B` into `{ left, right }`. */
function parseLeftRight(text) {
  if (text === undefined) return undefined;
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  const left = Number(parts[0]);
  const right = Number(parts[1]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;
  return { left, right };
}

/**
 * The one status vocabulary shared by the sidebar badge, the header pill, and
 * every tooltip.
 *
 *   progressing  work is not published yet: no upstream, or commits ahead of it
 *   behind       the upstream moved on and this branch has nothing of its own
 *   up_to_date   exactly in step with its upstream, but not identical to
 *                `origin/<default>`
 *   in_sync      in step with its upstream AND identical to `origin/<default>`
 *
 * The needs-rebasing glow is a separate overlay: a branch with its own commits
 * and a default branch that has moved on.
 */
export function worktreeState(measured) {
  const { upstream, aheadUpstream, behindUpstream, baseRef, aheadBase, behindBase } = measured;
  if (upstream === undefined || upstream === '') return 'progressing';
  if ((aheadUpstream ?? 0) > 0) return 'progressing';
  if ((behindUpstream ?? 0) > 0) return 'behind';
  if (baseRef !== undefined && (aheadBase ?? 0) === 0 && (behindBase ?? 0) === 0) return 'in_sync';
  return 'up_to_date';
}

/**
 * Read one worktree's complete status.
 * @param path - worktree root (this is where git runs).
 * @param options.baseBranch - repository default branch name.
 * @returns a plain JSON status object; `error` is set when the path is not a usable repo.
 */
export async function readWorktreeStatus(path, options = {}) {
  const branch = await currentBranch(path);
  if (branch === undefined && (await headOid(path)) === undefined) {
    return {
      branch: undefined,
      state: 'unknown',
      needsRebase: false,
      dirty: 0,
      error: 'the worktree has no commit to inspect (unborn HEAD)',
      files: [],
    };
  }

  const [oid, statusText, upstreamName, subjectLine] = await Promise.all([
    headOid(path),
    gitText(path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    gitText(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    gitText(path, ['log', '-1', '--format=%h%x1f%s']),
  ]);
  const changes = parsePorcelain(statusText ?? '');

  let upstream;
  let aheadUpstream;
  let behindUpstream;
  if (upstreamName !== undefined && upstreamName !== '') {
    upstream = upstreamName;
    const counts = parseLeftRight(await gitText(path, ['rev-list', '--left-right', '--count', `${upstreamName}...HEAD`]));
    if (counts !== undefined) {
      behindUpstream = counts.left;
      aheadUpstream = counts.right;
    }
  }

  const baseBranch = options.baseBranch;
  const baseRef = await baseRefFor(path, baseBranch);
  let aheadBase;
  let behindBase;
  if (baseRef !== undefined) {
    const counts = parseLeftRight(await gitText(path, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`]));
    if (counts !== undefined) {
      behindBase = counts.left;
      aheadBase = counts.right;
    }
  }

  const needsRebase = (behindBase ?? 0) > 0 && (aheadBase ?? 0) > 0;
  const [shortOid, subject] = (subjectLine ?? '').split('\x1f');

  return {
    branch,
    oid,
    shortOid: shortOid || undefined,
    subject: subject || undefined,
    upstream,
    aheadUpstream,
    behindUpstream,
    baseBranch,
    baseRef,
    aheadBase,
    behindBase,
    needsRebase,
    dirty: changes.dirty,
    staged: changes.staged,
    unstaged: changes.unstaged,
    untracked: changes.untracked,
    files: changes.files,
    state: worktreeState({ upstream, aheadUpstream, behindUpstream, baseRef, aheadBase, behindBase }),
    error: undefined,
  };
}

/**
 * One-line-per-fact human summary of a status object — the tooltip. Deliberately
 * complete rather than terse: it is only ever shown on hover.
 */
export function statusSummary(status, options = {}) {
  const parts = [];
  const branch = status.branch ?? '(detached HEAD)';
  if (options.petName) parts.push(`Worktree ${options.petName}`);
  parts.push(`branch ${branch}`);
  if (options.managedRoot) parts.push(`at ${options.managedRoot}`);

  if (status.state === 'progressing') {
    if (status.upstream === undefined) {
      const ahead = status.aheadBase ?? 0;
      parts.push(
        ahead > 0
          ? `Progressing: ${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${status.baseRef ?? 'the base branch'}, nothing published yet`
          : 'Progressing: not published yet (no upstream)',
      );
    } else {
      parts.push(`Progressing: ${status.aheadUpstream} unpushed commit${status.aheadUpstream === 1 ? '' : 's'} on ${status.upstream}`);
    }
  } else if (status.state === 'behind') {
    parts.push(`Behind ${status.upstream} by ${status.behindUpstream} commit${status.behindUpstream === 1 ? '' : 's'}`);
  } else if (status.state === 'up_to_date') {
    parts.push(`Up to date with ${status.upstream}`);
  } else {
    parts.push(`In sync with ${status.upstream}`);
  }

  const dirtyParts = [];
  if (status.staged > 0) dirtyParts.push(`${status.staged} staged`);
  if (status.unstaged > 0) dirtyParts.push(`${status.unstaged} modified`);
  if (status.untracked > 0) dirtyParts.push(`${status.untracked} untracked`);
  parts.push(dirtyParts.length > 0 ? `Working tree: ${dirtyParts.join(', ')}` : 'Working tree: clean');

  if (status.needsRebase) {
    parts.push(`Needs rebasing: ${status.baseRef} has ${status.behindBase} commit${status.behindBase === 1 ? '' : 's'} this branch does not have`);
  } else if (status.baseRef !== undefined && (status.aheadBase ?? 0) === 0 && (status.behindBase ?? 0) === 0) {
    parts.push(`Same commit as ${status.baseRef}`);
  } else if (status.baseRef !== undefined && (status.aheadBase ?? 0) > 0) {
    parts.push(`${status.aheadBase} commit${status.aheadBase === 1 ? '' : 's'} ahead of ${status.baseRef}, not merged`);
  }

  if (status.lastCommit) parts.push(status.lastCommit);
  return parts.join(' · ');
}
