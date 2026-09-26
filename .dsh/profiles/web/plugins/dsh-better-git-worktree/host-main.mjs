// dsh-better-git-worktree — Host half.
//
// What this plugin is
// -------------------
// A session can live in a git worktree *permanently*: created up front from the
// composer's Worktree switch, or moved there mid-session by the
// `worktree_convert` tool. Nothing here reviews, merges or delivers — the
// worktree is just where the session works, and the branch is the user's to
// push. That is the deliberate difference from dsh-git-worktree, whose whole
// review/acceptance lifecycle this plugin drops.
//
// Why the Host owns a registry
// ----------------------------
// The harness fixes a session's cwd at creation (`session.header.cwd` is
// immutable creation metadata), so no one can move a running session. The
// closest faithful conversion is: create the worktree, move the session's
// uncommitted work into it, then continue the conversation in a *new* session
// rooted there. This registry is what makes "which sessions are worktree
// sessions" answerable at all; the sidebar indicator and the tool's
// already-in-a-worktree guard both read it.
//
// Performance contract
// --------------------
// Every git read goes through the TTL cache in host/git-runner.mjs, a background timer
// keeps worktree status warm, and `git fetch` is throttled per repository. A
// sidebar poll therefore costs no git process in the steady state.

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TtlCache, gitFetch, runGit } from './host/git-runner.mjs';
import { baseRefFor, currentBranch, defaultBranch, readWorktreeStatus, repoRoot, statusSummary } from './host/repository.mjs';
import { WorktreeRegistry, stateDir } from './host/registry.mjs';
import { branchReview, createWorktree, managedRootBase, moveWorkingTreeChanges, worktreeExists } from './host/working-copy.mjs';

export const name = 'dsh-better-git-worktree';

/** `connection` is required (the client transport); `loader` is only needed for the Workspace election. */
export const inject = { connection: {}, loader: { await: false } };

const STATUS_TTL_MS = 4000;
const BACKGROUND_REFRESH_MS = 15000;
const FETCH_INTERVAL_MS = 90000;

/** Browser-facing JSON route owned by this plugin. */
const RPC_PATH = '/betterGitWorktree';
const MAX_BODY_BYTES = 1024 * 1024;

/** Collect one bounded JSON request body. */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The conditional disable expression for the official Workspace row. It lives in
 * the profile patch; the string here is only used to identify the row so the
 * lifecycle can re-elect it. Kept in sync with the patch row by construction
 * (the patch is the only place it is evaluated).
 */
const OFFICIAL_WORKSPACE = '@deepseek-ai/dsh-client-ui-workspace';

export default async function apply(ctx, config = {}) {
  const homeDir = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
  const stateRoot = config.stateDir ?? stateDir(homeDir);
  const registry = new WorktreeRegistry(join(stateRoot, 'worktrees.json'));
  const cache = new TtlCache();
  const log = typeof ctx.logger === 'function' ? ctx.logger(name) : console;

  /** sessionId → decoration/capability object the client renders and the tool guards on. */
  const lastStatus = new Map();
  /** repoRoot → timestamp of the last fetch we kicked. */
  const lastFetchAt = new Map();

  // ── status pipeline ───────────────────────────────────────────────────────

  /**
   * The directory a session works in: its managed worktree when it has one,
   * otherwise the session's own cwd. Every status surface works off this, so a
   * plain checkout session gets the same pill, menu and statuses as a worktree
   * session — it is the same question about a different directory.
   */
  function checkoutForSession(sessionId) {
    const record = registry.get(sessionId);
    if (record !== undefined) {
      return worktreeExists(record)
        ? { path: record.managedRoot, record, baseBranch: record.baseBranch }
        : { path: undefined, record, baseBranch: record.baseBranch, missing: true };
    }
    const agent = ctx.get('agents')?.get?.(sessionId);
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd === '') return undefined;
    return { path: cwd, record: undefined, baseBranch: undefined };
  }

  /** Repository root for a session's checkout, or undefined when there is none. */
  async function repoRootForSession(sessionId) {
    const checkout = checkoutForSession(sessionId);
    if (checkout === undefined || checkout.path === undefined) return undefined;
    return (await repoRoot(checkout.path)) ?? undefined;
  }

  async function statusFor(sessionId, options = {}) {
    const checkout = checkoutForSession(sessionId);
    if (checkout === undefined) return undefined;
    if (checkout.missing === true) {
      return {
        ...checkout.record,
        missing: true,
        state: 'unknown',
        needsRebase: false,
        tooltip: `The managed worktree ${checkout.record.managedRoot} no longer exists on disk.`,
      };
    }
    // Cache by directory: sessions sharing a checkout share one status read.
    const key = `status:${checkout.path}`;
    let status;
    try {
      status = await cache.get(
        key,
        () => readWorktreeStatus(checkout.path, { baseBranch: checkout.baseBranch }),
        { ttlMs: STATUS_TTL_MS, force: options.force === true },
      );
    } catch (error) {
      return {
        sessionId,
        path: checkout.path,
        missing: false,
        state: 'unknown',
        needsRebase: false,
        tooltip: `${checkout.path} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const merged = {
      ...(checkout.record ?? { sessionId }),
      sessionId,
      path: checkout.path,
      ...status,
      missing: false,
      tooltip: statusSummary(status, { managedRoot: checkout.record?.managedRoot, petName: checkout.record?.petName }),
    };
    lastStatus.set(sessionId, merged);
    return merged;
  }

  /** Fire-and-forget refresh of every registered worktree; never awaited by a caller. */
  function warmAll() {
    for (const record of registry.list()) {
      void statusFor(record.sessionId).catch(() => {});
    }
  }

  /** Background refresh of the checkout a session runs in, recorded or not. */
  function warmStatuses(extraSessionIds) {
    warmAll();
    for (const sessionId of extraSessionIds ?? []) {
      if (registry.get(sessionId) !== undefined) continue;
      void statusFor(sessionId).catch(() => {});
    }
  }

  /** Throttled, non-blocking `git fetch` for one repository. */
  function kickFetch(root, force = false) {
    const previous = lastFetchAt.get(root) ?? 0;
    if (!force && Date.now() - previous < FETCH_INTERVAL_MS) return;
    lastFetchAt.set(root, Date.now());
    void gitFetch(root).then((result) => {
      if (!result.ok) {
        lastFetchAt.set(root, previous);
        return;
      }
      cache.invalidatePrefix('status:');
      warmAll();
    });
  }

  // ── session bookkeeping ───────────────────────────────────────────────────

  /**
   * Resolve the repository a session is currently working in.
   * @throws when the session cwd is not inside a git repository.
   */
  async function repoForSession(sessionId) {
    const agent = ctx.get('agents')?.get?.(sessionId);
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`session ${sessionId} has no working directory to build a worktree from`);
    }
    // A worktree of a worktree helps nobody: the session already has its own
    // isolated working copy, and nesting just buries the real project.
    const managedRoots = new Set(registry.list().map((record) => record.managedRoot));
    if (managedRoots.has(cwd)) {
      throw new Error(`this session already works in a git worktree (${cwd})`);
    }
    const root = await repoRoot(cwd);
    if (root === undefined) throw new Error(`${cwd} is not inside a git repository`);
    if (managedRoots.has(root)) {
      throw new Error(`this session's repository is already a managed git worktree (${root})`);
    }
    return { cwd, repoRoot: root };
  }

  /** Create a managed worktree for a session and register it. */
  async function createForSession(sessionId, options = {}) {
    const registerAs = options.registerAs ?? sessionId;
    const existing = registry.get(registerAs);
    if (existing !== undefined) return { record: existing, reused: true };
    const { repoRoot: root } = await repoForSession(sessionId);
    const branchName = await currentBranch(root);
    const base = (await defaultBranch(root)) ?? branchName;
    const baseRef = await baseRefFor(root, base);
    const created = await createWorktree({ repoRoot: root, sessionId: registerAs, homeDir });
    const record = registry.put({
      sessionId: registerAs,
      sourceSessionId: registerAs === sessionId ? undefined : sessionId,
      origin: options.origin ?? 'pre-session',
      repoRoot: created.repoRoot,
      managedRoot: created.managedRoot,
      branch: created.branch,
      petName: created.petName,
      baseBranch: base,
      baseRef,
      activated: options.activated ?? false,
      createdAt: Date.now(),
    });
    lastFetchAt.set(created.repoRoot, Date.now());
    void gitFetch(root).then((result) => {
      if (result.ok) {
        cache.invalidatePrefix('status:');
        warmAll();
      }
    });
    return { record, reused: false };
  }

  /**
   * Move a session's uncommitted work into a fresh worktree and continue the
   * conversation in a new session rooted there.
   */
  async function convertSession(sessionId, options = {}) {
    const existing = registry.get(sessionId);
    if (existing !== undefined) {
      throw new Error(`session ${sessionId} is already a worktree session at ${existing.managedRoot}`);
    }
    const source = ctx.get('agents')?.get?.(sessionId);
    if (source === undefined) throw new Error(`session ${sessionId} is not live`);

    const { record } = await createForSession(sessionId, { origin: options.origin ?? 'converted' });
    let move = { moved: false, files: 0 };
    if (options.moveChanges !== false) {
      move = await moveWorkingTreeChanges(record.repoRoot, record.managedRoot, `dsh-better-git-worktree ${record.branch}`);
      if (move.moved) registry.patch(sessionId, { stashRef: move.stashRef, stashEntry: move.stashEntry });
    }

    let targetSessionId;
    let conversationCarried = false;
    try {
      const created = await createWorktreeSessionFor(ctx, source, record);
      targetSessionId = created.sessionId;
      conversationCarried = created.carried;
      // The client watches the snapshot and performs the Workspace + Session
      // activation for this target, then clears `activated`.
      registry.patch(sessionId, { targetSessionId, conversationCarried, activated: false });
    } catch (error) {
      // The worktree and the moved work stay: they are the user's, and the
      // client can still open a fresh session there.
      return {
        ok: false,
        record,
        move,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return { ok: true, record, move, targetSessionId, conversationCarried };
  }

  /**
   * Hand a directory to the desktop's own file manager.
   *
   * Mirrors how the harness's own open-in-app row launches things: detached,
   * stdio-less, with credential-shaped variables stripped from the environment,
   * and success decoupled from process lifetime (a file manager stays in the
   * foreground for as long as its window is open).
   */
  const FOLDER_OPENERS = process.platform === 'darwin'
    ? [{ command: 'open', args: [] }]
    : process.platform === 'win32'
      ? [{ command: 'explorer', args: [] }]
      : [
          { command: 'xdg-open', args: [] },
          { command: 'gio', args: ['open'] },
          { command: 'nautilus', args: [] },
          { command: 'dolphin', args: [] },
          { command: 'thunar', args: [] },
          { command: 'nemo', args: [] },
          { command: 'pcmanfm', args: [] },
        ];

  /** Path-name lookup for the folder opener (no shell involved). */
  function findOpener() {
    const pathValue = process.env.PATH ?? '';
    for (const candidate of FOLDER_OPENERS) {
      for (const dir of pathValue.split(':')) {
        if (dir !== '' && existsSync(join(dir, candidate.command))) return candidate;
      }
    }
    return undefined;
  }

  function openFolder(path) {
    if (!existsSync(path)) throw new Error(`${path} no longer exists`);
    const resolved = findOpener();
    if (resolved === undefined) {
      throw new Error(
        `no folder opener is installed on this host (tried ${FOLDER_OPENERS.map((entry) => entry.command).join(', ')})`,
      );
    }
    const opener = resolved.command;
    const openerArgs = [...resolved.args, path];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => value !== undefined && !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key)),
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(opener, openerArgs, { detached: true, stdio: 'ignore', env });
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.unref();
        outcome();
      };
      const timer = setTimeout(() => settle(resolve), 1500);
      child.on('error', (error) => settle(() => reject(new Error(`${opener} is unavailable: ${error.message}`))));
      child.on('exit', (code) => settle(() => (code === 0 ? resolve() : reject(new Error(`${opener} exited with ${code}`)))));
    });
  }

  /**
   * Remove one managed working copy from disk.
   *
   * Only paths this plugin created are accepted: the registry's own record is
   * the authority, and the path must still sit under a managed root, so a
   * corrupted record can never turn this into an arbitrary `rm -rf`.
   */
  async function removeWorkingCopy(record) {
    const base = await managedRootBase(homeDir, record.repoRoot);
    const resolved = resolve(record.managedRoot);
    if (!resolved.startsWith(`${resolve(base)}${sep}`)) {
      throw new Error(`refusing to remove ${resolved}: it is outside the managed worktree root ${base}`);
    }
    // Resolve the Workspace registration *before* deleting the directory:
    // resolveByPath canonicalizes the path and rejects once it is gone.
    let workspace;
    const workspaceRegistry = ctx.get('workspaceRegistry');
    if (workspaceRegistry !== undefined && typeof workspaceRegistry.resolveByPath === 'function') {
      try {
        workspace = await workspaceRegistry.resolveByPath(resolved);
      } catch {
        workspace = undefined;
      }
    }
    // A linked worktree is registered in the source repository and owns a real
    // branch, so removing it means unregistering it and dropping that branch.
    await runGit(record.repoRoot, ['worktree', 'remove', '--force', '--', resolved], { timeoutMs: 120000 });
    rmSync(resolved, { recursive: true, force: true });
    await runGit(record.repoRoot, ['worktree', 'prune']);
    if (typeof record.branch === 'string' && record.branch !== '') {
      await runGit(record.repoRoot, ['branch', '-D', record.branch]);
    }
    registry.remove(record.sessionId);
    cache.invalidatePrefix('status:');
    lastStatus.delete(record.sessionId);
    // Retire the now-dead Workspace registration as well, or it resurfaces in
    // the sidebar as an ordinary project once the record is gone.
    let workspaceRemoved = false;
    if (workspace !== undefined && typeof workspaceRegistry.delete === 'function') {
      try {
        await workspaceRegistry.delete(workspace.id);
        workspaceRemoved = true;
      } catch (error) {
        log.warn(`could not retire workspace for ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { removed: true, managedRoot: resolved, workspaceRemoved };
  }

  // ── RPC surface (client → host) ───────────────────────────────────────────

  const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

  async function handleRpc(endpoint, payload) {
    const p = payload !== null && typeof payload === 'object' ? payload : {};
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined;
    switch (endpoint) {
      case 'snapshot': {
        const entries = [];
        for (const record of registry.list()) {
          entries.push(await statusFor(record.sessionId));
        }
        return { ok: true, value: { worktrees: entries, at: Date.now() } };
      }
      case 'status': {
        if (sessionId === undefined) return fail('bad-request', 'status needs a sessionId');
        const status = await statusFor(sessionId, { force: p.force === true });
        return { ok: true, value: { status: status ?? null } };
      }
      case 'fetch': {
        if (sessionId === undefined) return fail('bad-request', 'fetch needs a sessionId');
        const root = (await repoRootForSession(sessionId)) ?? registry.get(sessionId)?.repoRoot;
        if (root === undefined) return fail('no-repository', `session ${sessionId} has no git repository to fetch`);
        kickFetch(root, true);
        const status = await statusFor(sessionId, { force: true });
        return { ok: true, value: { status: status ?? null } };
      }
      case 'create': {
        if (sessionId === undefined) return fail('bad-request', 'create needs a sessionId');
        const created = await createForSession(sessionId);
        return { ok: true, value: { worktree: await statusFor(sessionId), reused: created.reused } };
      }
      // Pre-session flow: the composer's Worktree switch has already picked the
      // id the worktree-rooted session will use, so the worktree is created for
      // the *source* session's repository but registered under that target id.
      case 'prepare': {
        const sourceSessionId = typeof p.sourceSessionId === 'string' ? p.sourceSessionId : undefined;
        const targetSessionId = typeof p.targetSessionId === 'string' ? p.targetSessionId : undefined;
        if (sourceSessionId === undefined || targetSessionId === undefined) {
          return fail('bad-request', 'prepare needs sourceSessionId and targetSessionId');
        }
        const already = registry.get(targetSessionId);
        if (already !== undefined) return { ok: true, value: { worktree: await statusFor(targetSessionId), reused: true } };
        const existing = registry.get(sourceSessionId);
        if (existing !== undefined) {
          return fail('already-a-worktree-session', `session ${sourceSessionId} is already a worktree session`);
        }
        const created = await createForSession(sourceSessionId, { origin: 'pre-session', registerAs: targetSessionId });
        return { ok: true, value: { worktree: await statusFor(targetSessionId), reused: created.reused } };
      }
      // The client has opened the worktree-rooted session; nothing more to do.
      case 'activate': {
        if (sessionId === undefined) return fail('bad-request', 'activate needs a sessionId');
        registry.patch(sessionId, { activated: true });
        return { ok: true, value: { activated: true } };
      }
      case 'convert': {
        if (sessionId === undefined) return fail('bad-request', 'convert needs a sessionId');
        // `moveChanges: false` keeps the source checkout untouched: the
        // worktree is still created and the session still continues there, but
        // whatever is uncommitted stays where it is.
        const result = await convertSession(sessionId, { moveChanges: p.moveChanges !== false });
        if (result.ok !== true) {
          return { ok: false, error: { code: 'session-handoff-failed', message: result.error, details: { managedRoot: result.record.managedRoot } } };
        }
        return {
          ok: true,
          value: {
            worktree: await statusFor(sessionId),
            targetSessionId: result.targetSessionId,
            conversationCarried: result.conversationCarried,
            moved: result.move,
          },
        };
      }
      // Removing the working copy for a session the user is retiring. The
      // branch lives in the working copy, so it goes with it unless it was
      // pushed; the client asks before calling this.
      case 'remove': {
        if (sessionId === undefined) return fail('bad-request', 'remove needs a sessionId');
        const record = registry.get(sessionId);
        if (record === undefined) return fail('not-a-worktree-session', `session ${sessionId} is not a worktree session`);
        return { ok: true, value: await removeWorkingCopy(record) };
      }
      // Hand the checkout's folder to the desktop file manager.
      case 'open': {
        if (sessionId === undefined) return fail('bad-request', 'open needs a sessionId');
        const checkout = checkoutForSession(sessionId);
        if (checkout === undefined || checkout.path === undefined) {
          return fail('no-session', `session ${sessionId} has no working directory`);
        }
        await openFolder(checkout.path);
        return { ok: true, value: { opened: checkout.path } };
      }
      case 'workingTree': {
        if (sessionId === undefined) return fail('bad-request', 'workingTree needs a sessionId');
        const checkout = checkoutForSession(sessionId);
        if (checkout === undefined || checkout.path === undefined) {
          return fail('no-session', `session ${sessionId} has no working directory`);
        }
        const status = await readWorktreeStatus(checkout.path, { baseBranch: checkout.baseBranch });
        return {
          ok: true,
          value: { path: checkout.path, status, summary: statusSummary(status, { managedRoot: checkout.record?.managedRoot }) },
        };
      }
      case 'branchReview': {
        if (sessionId === undefined) return fail('bad-request', 'branchReview needs a sessionId');
        const checkout = checkoutForSession(sessionId);
        if (checkout === undefined || checkout.path === undefined) {
          return fail('no-session', `session ${sessionId} has no working directory`);
        }
        // Always re-read: this backs a panel with its own refresh action.
        const status = (await statusFor(sessionId, { force: true }))
          ?? (await readWorktreeStatus(checkout.path, { baseBranch: checkout.baseBranch }));
        const review = await branchReview(checkout.path, status);
        return { ok: true, value: { review, status } };
      }
      case 'forget': {
        if (sessionId === undefined) return fail('bad-request', 'forget needs a sessionId');
        const record = registry.get(sessionId);
        if (record !== undefined) cache.invalidatePrefix(`status:${record.managedRoot}`);
        return { ok: true, value: { removed: registry.remove(sessionId) } };
      }
      default:
        return fail('unknown-endpoint', `unknown endpoint ${endpoint}`);
    }
  }

  ctx.inject(['connection', 'webServer'], (scope) => {
    const webServer = scope.get('webServer');
    if (webServer === undefined || typeof webServer.register !== 'function') {
      log.warn('webServer is unavailable; the sidebar and composer surfaces stay off');
      return;
    }
    // A plugin-owned route rather than `connection.rpc.handle`: that helper
    // reads `owner.webServer` on the Connection service's own context, which
    // this deployment never injects (the service mounts /api from a *child*
    // scope instead), so every channel registered through it answers 405. This
    // route reuses the same trust fence — `connection.requestRejection` is a
    // public method — and speaks plain JSON instead of the RPC envelope.
    scope.effect(
      () =>
        scope.get('webServer').register({
          kind: 'prefix',
          path: RPC_PATH,
          handler: async (req, res) => {
            try {
              const connection = scope.get('connection');
              const rejection =
                connection !== undefined && typeof connection.requestRejection === 'function'
                  ? connection.requestRejection(req)
                  : undefined;
              if (rejection !== undefined) {
                res.writeHead(rejection);
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
                return;
              }
              if (req.method !== 'POST') {
                res.writeHead(405);
                res.end('method not allowed');
                return;
              }
              const url = new URL(req.url ?? '/', 'http://dsh.internal');
              const endpoint = decodeURIComponent(url.pathname.slice(RPC_PATH.length + 1));
              const payload = await readJsonBody(req);
              const result = await handleRpc(endpoint, payload);
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(result));
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(fail('internal', error instanceof Error ? error.message : String(error))));
            }
          },
        }),
      'dsh-better-git-worktree: rpc route',
    );
  });

  // ── model tool ────────────────────────────────────────────────────────────

  ctx.inject(['tools'], (scope) => {
    scope.effect(
      () =>
        scope.tools.register(
          defineTool({
            name: 'worktree_convert',
            description:
              'Move this session into an isolated git worktree. Creates a branch and an isolated working copy for '
              + 'the current repository, moves the uncommitted working-tree changes into it (kept recoverable as a git '
              + 'stash entry), and continues this conversation in a new session rooted there. Use it when work should '
              + 'stop touching the main checkout. Do not call it when the session is already a worktree session.',
            parameters: {},
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true },
                  managedRoot: { type: 'string', required: true },
                  branch: { type: 'string', required: true },
                  baseRef: { type: 'string' },
                  targetSessionId: { type: 'string' },
                  conversationCarried: { type: 'boolean', required: true },
                  movedFiles: { type: 'number', required: true },
                  stashRef: { type: 'string' },
                  status: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                },
              },
              render: (_args, value) => [{ type: 'text', text: value.detail }],
            },
            async execute(_args, exec) {
              const sessionId = exec?.agent?.session?.id;
              if (typeof sessionId !== 'string') throw new Error('worktree_convert can only run inside a DSH session');
              const already = registry.get(sessionId);
              if (already !== undefined) {
                throw new Error(
                  `this session is already a worktree session at ${already.managedRoot} (branch ${already.branch}); nothing to convert`,
                );
              }
              const result = await convertSession(sessionId);
              const status = await statusFor(sessionId).catch(() => undefined);
              const lines = [
                'Moved this session into a git worktree.',
                `Worktree: ${result.record.managedRoot}`,
                `Branch: ${result.record.branch}${result.record.baseBranch ? ` (based on ${result.record.baseBranch})` : ''}`,
                result.move.moved
                  ? `Moved ${result.move.files} changed path(s) from the original checkout; the backup stash entry is ${result.move.stashRef}.`
                  : 'The original checkout had no uncommitted changes to move.',
              ];
              if (result.ok === true) {
                lines.push(
                  result.conversationCarried
                    ? `Continuing in session ${result.targetSessionId}, whose working directory is the worktree.`
                    : `A new session (${result.targetSessionId}) was created in the worktree; open it to continue there.`,
                );
              } else {
                lines.push(`The worktree is ready but the session handoff failed: ${result.error}`);
                lines.push('Open a session in the worktree from the Worktree menu to continue there.');
              }
              return {
                kind: 'worktree_converted',
                managedRoot: result.record.managedRoot,
                branch: result.record.branch,
                baseRef: result.record.baseRef ?? undefined,
                targetSessionId: result.ok === true ? result.targetSessionId : undefined,
                conversationCarried: result.ok === true ? result.conversationCarried : false,
                movedFiles: result.move.files,
                stashRef: result.move.stashRef ?? undefined,
                status: status?.state ?? 'progressing',
                detail: lines.join('\n'),
              };
            },
            presentCall: () => ({ card: 'generic', title: 'Move into a git worktree', kind: 'other', rawInput: {} }),
          }),
        ),
      'dsh-better-git-worktree: worktree_convert tool',
    );

    // Once a session is a worktree session the tool has done its job: deny it in
    // that agent's scope so it disappears from the model's tool list.
    const denyFor = (agent) => {
      const managedRoots = new Set(registry.list().map((record) => record.managedRoot));
      const cwd = agent?.session?.header?.cwd;
      const inWorktree = registry.get(agent.id) !== undefined || (typeof cwd === 'string' && managedRoots.has(cwd));
      if (!inWorktree) return;
      try {
        agent.ctx.tools.restrict({ deny: ['worktree_convert'] });
      } catch (error) {
        log.warn(`could not hide worktree_convert for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    scope.on('agent/created', (payload) => {
      if (payload?.agent !== undefined) denyFor(payload.agent);
    });
  });

  // ── model context ────────────────────────────────────────────────────────

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'better-git-worktree:session-root',
      order: 118,
      text: (context) => {
        const sessionId = context?.agent?.session?.id;
        if (typeof sessionId !== 'string') return '';
        const record = registry.get(sessionId);
        if (record === undefined) return '';
        return [
          'This session works inside an isolated git worktree, not the main checkout.',
          `Authoritative working directory: ${record.managedRoot}`,
          `Branch: ${record.branch}${record.baseRef ? ` (compares against ${record.baseRef})` : ''}`,
          'Run git through the normal tools; never write to the original checkout.',
        ].join('\n');
      },
    });
  });

  // ── Workspace election + background refresh ───────────────────────────────

  mountWorkspaceProviderElection(ctx, log);

  const timer = ctx.get('timer');
  if (timer !== undefined && typeof timer.interval === 'function') {
    const disposeTimer = timer.interval(() => warmAll(), BACKGROUND_REFRESH_MS);
    ctx.effect(() => disposeTimer, 'dsh-better-git-worktree: status refresh');
  } else {
    const handle = setInterval(() => warmAll(), BACKGROUND_REFRESH_MS);
    handle.unref?.();
    ctx.effect(() => () => clearInterval(handle), 'dsh-better-git-worktree: status refresh');
  }

  ctx.on('ready', () => {
    warmAll();
    for (const record of registry.list()) kickFetch(record.repoRoot);
  });

  log.info(`mounted (${registry.list().length} worktree session(s) registered)`);
}

/**
 * The official Workspace Browser is replaced by this plugin's decorated copy, so
 * the official row must be disabled while this plugin owns the surface — and
 * restored when it does not. The row's `disabled` expression (in the profile
 * patch) tests the marker provided here, so electing and releasing is just a
 * matter of re-evaluating it through the public Loader entry operations.
 */
function mountWorkspaceProviderElection(ctx, log) {
  const loader = ctx.get('loader');
  if (loader === undefined) return;
  /** The one official Workspace row this plugin stands in for. */
  const owned = () => [...loader.entries()].find((entry) => entry.options?.name === OFFICIAL_WORKSPACE);
  // Remember the row's own disabled option so teardown restores exactly what
  // the profile composed (a bundle patch's `!!js` expression, or nothing).
  const original = owned()?.options?.disabled;
  let released = false;
  let pending = Promise.resolve();

  const elect = () => {
    pending = pending.then(async () => {
      if (released) return;
      const entry = owned();
      if (entry === undefined) return;
      try {
        // `true` disposes the official fiber (its Browser leaves the page);
        // this plugin's inlined copy is the only Workspace provider left.
        await entry.update({ disabled: true }, false, true);
      } catch (error) {
        log.warn(`could not stand the official Workspace row down: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return pending;
  };

  ctx.effect(() => {
    void elect().catch(() => {});
    ctx.on('internal/plugin', (fiber) => {
      // A late Include may add or replace the official row after this plugin
      // activated; re-elect whenever that happens.
      if (fiber?.entry?.options?.name === OFFICIAL_WORKSPACE) void elect().catch(() => {});
    });
    ctx.on('internal/status', (fiber) => {
      if (fiber === ctx.fiber) void elect().catch(() => {});
    });
    return async () => {
      released = true;
      await pending.catch(() => {});
      released = false;
      const entry = owned();
      if (entry === undefined) return;
      try {
        // Restore the official Browser: the plugin's inlined copy unmounts with
        // this fiber, so the sidebar must not be left without a provider.
        await entry.update({ disabled: original ?? undefined }, false, true);
      } catch (error) {
        log.warn(`could not restore the official Workspace row: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }, 'dsh-better-git-worktree: workspace election');
}

/**
 * Create the worktree-rooted session that continues `source`'s conversation.
 *
 * The harness cannot re-root a live session, so the continuation is a forged
 * child session: same conversation prefix, new cwd. When the fork cannot be
 * built (no completed turn yet, or an unexpected host error) a plain empty
 * session in the worktree is still better than nothing, and the caller reports
 * which one happened.
 */
async function createWorktreeSessionFor(ctx, source, record) {
  const sessionId = `session-${randomUUID()}`;
  const agentLoop = ctx.get('agentLoop');
  if (agentLoop === undefined || typeof agentLoop.createAgent !== 'function') {
    throw new Error('ctx.agentLoop is unavailable, so a worktree session cannot be created');
  }
  const seed = forkSeed(source.session);
  const agentPreset = ctx.get('agentPresets')?.composedPreset?.(source.ctx);
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {};
  const options = {
    sessionId,
    meta: {
      cwd: record.managedRoot,
      // Lineage only when the conversation prefix actually came along: a
      // seeded marker without a seed would misreport the new session's origin.
      ...(seed.length > 0 ? { parentSession: source.session.id, isSeeded: true } : {}),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
    ...(seed.length > 0 ? { seed, inheritedEventCount: seed.length } : {}),
    agentOptions: {
      ...(selection.provider === undefined ? {} : { provider: selection.provider }),
      ...(selection.model === undefined ? {} : { model: selection.model }),
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
  };
  await agentLoop.createAgent(ctx, options);
  return { sessionId, carried: seed.length > 0 };
}

/** Balanced completed-turn prefix of a session log, safe to hand to a new session. */
function forkSeed(session) {
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
    if (!Array.isArray(events) || events.length === 0) return [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/end') return events.slice(0, index + 1);
    }
    return [];
  } catch {
    return [];
  }
}
