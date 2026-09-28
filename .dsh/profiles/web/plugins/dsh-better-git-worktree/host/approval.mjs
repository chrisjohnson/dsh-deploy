/**
 * Narrow pre-approval for git work inside a managed worktree.
 *
 * ## Why this exists
 *
 * A linked worktree keeps its index and its branch refs in the *source*
 * repository's git directory, but the harness derives a session's writable set
 * from exactly one root (`dsh-sandbox`'s `writableRoots()` is
 * `[session.header.cwd, /tmp, os.tmpdir()]`, and `dsh-sandbox-policy` resolves
 * that root from the immutable `session.header.cwd`). So `git add`, `git commit`
 * and `git push` inside a worktree write outside the session's boundary by
 * construction, and the agent has to ask for `danger-full-access` every time.
 *
 * This module lets the plugin answer that one class of request itself. It is
 * deliberately paranoid:
 *
 *  - it never trusts the model's justification text — the decision is made from
 *    the *actual* tool call, matched by `callId`;
 *  - every command in the chain must be a plain `git` (or `cd`) invocation;
 *  - `cd` may only enter the managed worktree;
 *  - flags that redirect git at another repository, inject configuration (which
 *    can execute code, e.g. `-c core.hooksPath=…`), or rewrite published history
 *    are refused;
 *  - redirection, command substitution, variable expansion, `~`, `;`, `&`,
 *    newlines and everything else the shell could use to escape the chain are
 *    refused outright.
 *
 * Anything else falls through to the normal answerers, so the human still gets
 * asked. Every approval this module grants is logged with its command.
 *
 * @module dsh-better-git-worktree/approval
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** Subcommands a worktree session may run unattended. */
const ALLOWED_SUBCOMMANDS = new Set([
  'add',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'describe',
  'diff',
  'fetch',
  'log',
  'ls-files',
  'shortlog',
  'merge',
  'mv',
  'pull',
  'push',
  'blame',
  'grep',
  'ls-remote',
  'rebase',
  'remote',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'rm',
  'show',
  'stash',
  'status',
  'switch',
  'tag',
]);

/** Subcommands that need an extra look at their arguments. */
const SUBCOMMAND_RULES = {
  push: ({ args }) => {
    for (const arg of args) {
      if (/^--(force|force-with-lease|mirror|all|delete|prune|atomic|follow-tags)/.test(arg)) return `push ${arg}`;
      if (/^-[a-zA-Z]*f/.test(arg)) return 'push -f';
      if (arg.startsWith('+')) return 'push +refspec';
      if (arg.startsWith(':')) return 'push :refspec';
    }
    return undefined;
  },
  branch: ({ args }) => {
    for (const arg of args) {
      if (/^--(delete|move|copy|edit-description|set-upstream-to|unset-upstream|force)/.test(arg)) return `branch ${arg}`;
      if (/^-[a-zA-Z]*[dDmMcCfu]/.test(arg)) return `branch ${arg}`;
    }
    return undefined;
  },
  remote: ({ args }) => {
    const verbs = args.filter((arg) => !arg.startsWith('-'));
    for (const verb of verbs) {
      if (['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'].includes(verb)) {
        return `remote ${verb}`;
      }
    }
    return undefined;
  },
  tag: ({ args }) => {
    for (const arg of args) {
      if (/^-[a-zA-Z]*[dDf]/.test(arg) || /^--(delete|force|sign)/.test(arg)) return `tag ${arg}`;
    }
    return undefined;
  },
  clean: ({ args }) => {
    // `-x` also removes ignored files; in a disposable working copy that is
    // fine, but it is the one clean variant that can delete build outputs the
    // user cares about, so it stays behind an approval.
    for (const arg of args) if (/^-[a-zA-Z]*x/.test(arg)) return 'clean -x';
    return undefined;
  },
};

/** Flags that must never appear, whatever the subcommand. */
const FORBIDDEN_FLAGS = [
  [/^--git-dir(=|$)/, '--git-dir'],
  [/^--work-tree(=|$)/, '--work-tree'],
  [/^--exec-path(=|$)/, '--exec-path'],
  [/^--config-env(=|$)/, '--config-env'],
  [/^--namespace(=|$)/, '--namespace'],
  [/^--upload-pack(=|$)/, '--upload-pack'],
  [/^--receive-pack(=|$)/, '--receive-pack'],
  [/^--no-index$/, '--no-index'],
  [/^-c$/, '-c'],
  [/^-C$/, '-C'],
  [/^--bare$/, '--bare'],
  [/^--help$/, '--help'],
];

/** Commands (other than git) allowed to receive a pipe. */
const SAFE_PIPE_TARGETS = new Set(['tail', 'head', 'cat', 'grep', 'wc', 'sort', 'uniq', 'tr', 'cut', 'awk', 'sed', 'column', 'less', 'more']);

/** Pipe targets that can write files with the right flags. */
const PIPE_TARGET_GUARDS = [[/^-i(\s|$)|--in-place/, 'in-place editing']];

const SAFE_TEXT = /^[A-Za-z0-9 _.,:/=@^+%{}[\]()'"!?*#-]*$/;

/**
 * Split a command into `&&`- and `|`-separated segments without a shell.
 *
 * Quotes group text; everything else the shell could interpret (substitution,
 * redirection, background jobs, sequencing) is refused rather than interpreted.
 *
 * @param command - the raw command string from the tool call.
 * @returns segments, or a refusal reason.
 */
function tokenize(command) {
  const segments = [[]];
  const operators = [];
  let current = '';
  let quote;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (char === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1];
        i += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '`' || char === '\\' || char === '~' || char === '#' || char === '!' || char === ';' || char === '&' || char === '\n' || char === '\r') {
      // `&&` is the one chaining operator we understand; `&` / `;` / newline are not.
      if (char === '&' && command[i + 1] === '&') {
        segments[segments.length - 1].push(current);
        current = '';
        operators.push('&&');
        segments.push([]);
        i += 1;
        continue;
      }
      return { ok: false, reason: `unsupported shell syntax ${JSON.stringify(char)}` };
    }
    if (char === '<') return { ok: false, reason: 'unsupported input redirection' };
    if (char === '>') {
      // Only descriptor duplication (`2>&1`) is tolerated.
      const tail = command.slice(i);
      if (/^>&\d/.test(tail) || /^>>?&?\d*$/.test(tail)) {
        i += tail.match(/^>&?\d*/)[0].length - 1;
        continue;
      }
      return { ok: false, reason: 'unsupported output redirection' };
    }
    if (char === '$') return { ok: false, reason: 'unsupported variable expansion' };
    if (char === '|') {
      if (command[i + 1] === '|') return { ok: false, reason: 'unsupported `||` chaining' };
      segments[segments.length - 1].push(current);
      current = '';
      operators.push('|');
      segments.push([]);
      continue;
    }
    if (char === ' ') {
      const words = segments[segments.length - 1];
      if (current !== '') words.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote !== undefined) return { ok: false, reason: 'unterminated quote' };
  segments[segments.length - 1].push(current);
  const cleaned = segments.map((words) => words.filter((word) => word !== ''));
  if (cleaned.some((words) => words.length === 0)) return { ok: false, reason: 'empty command segment' };
  return { ok: true, segments: cleaned, operators };
}

/** Whether `candidate` is `root` or lives under it (after symlink resolution). */
function isInside(candidate, root) {
  const real = (path) => {
    try {
      return existsSync(path) ? realpathSync(path) : resolve(path);
    } catch {
      return resolve(path);
    }
  };
  const target = real(candidate);
  const base = real(root);
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Arguments that no git invocation may carry. */
function forbiddenArgument(segment, args, worktreeRoot) {
  for (const arg of args) {
    for (const [pattern, label] of FORBIDDEN_FLAGS) {
      if (pattern.test(arg)) return `git ${label}`;
    }
    if (arg.startsWith('-')) continue;
    if (arg.includes('..')) return `path ${arg}`;
    // A `-m "message with spaces"` quote pair arrives as one token; only tokens
    // that look like paths are held to the containment rule.
    if (arg.includes('/')) {
      const candidate = isAbsolute(arg) ? arg : resolve(worktreeRoot, arg);
      if (!isInside(candidate, worktreeRoot)) return `path outside the worktree: ${arg}`;
    }
    if (!SAFE_TEXT.test(arg)) return `argument ${JSON.stringify(arg)}`;
  }
  return undefined;
}

/**
 * Decide whether one git invocation may run unattended.
 *
 * This is the single source of truth for every entry point: the `worktree_git`
 * tool passes a structured argv (no shell involved at all), and the shell-form
 * {@link confinedGitDecision} tokenizes a command and defers here per segment.
 *
 * @param argv - git arguments only, without the leading `git` word.
 * @param options.worktreeRoot - the managed working copy the command must stay inside.
 * @returns `{ allow: true }` or `{ allow: false, reason }`.
 */
function confinedGitArgv(argv, options) {
  const worktreeRoot = options?.worktreeRoot;
  if (typeof worktreeRoot !== 'string' || worktreeRoot === '') return { allow: false, reason: 'no worktree root' };
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((word) => typeof word !== 'string')) {
    return { allow: false, reason: 'no git arguments' };
  }
  const subcommand = argv.find((word) => !word.startsWith('-'));
  if (subcommand === undefined || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return { allow: false, reason: `git ${subcommand ?? '(none)'}` };
  }
  const args = argv.filter((word) => word !== subcommand);
  const forbidden = forbiddenArgument(argv, args, worktreeRoot);
  if (forbidden !== undefined) return { allow: false, reason: forbidden };
  const rule = SUBCOMMAND_RULES[subcommand];
  if (rule !== undefined) {
    const refused = rule({ args });
    if (refused !== undefined) return { allow: false, reason: `git ${refused}` };
  }
  return { allow: true };
}

/**
 * Decide whether one command may run without asking the human.
 *
 * @param command - the raw bash command from the pending tool call.
 * @param options.worktreeRoot - the managed working copy this session lives in.
 * @returns `{ allow: true }` or `{ allow: false, reason }`.
 */
export function confinedGitDecision(command, options) {
  if (typeof command !== 'string' || command.trim() === '') return { allow: false, reason: 'no command' };
  const worktreeRoot = options?.worktreeRoot;
  if (typeof worktreeRoot !== 'string' || worktreeRoot === '') return { allow: false, reason: 'no worktree root' };
  const tokenized = tokenize(command);
  if (tokenized.ok !== true) return { allow: false, reason: tokenized.reason };

  const { segments, operators } = tokenized;
  for (let index = 0; index < segments.length; index += 1) {
    const words = segments[index];
    const piped = operators[index - 1] === '|';
    const [head] = words;
    if (piped) {
      if (!SAFE_PIPE_TARGETS.has(head)) return { allow: false, reason: `piped into ${head}` };
      const guard = words.slice(1).find((arg) => PIPE_TARGET_GUARDS.some(([pattern]) => pattern.test(arg)));
      if (guard !== undefined) return { allow: false, reason: `piped into ${head} with ${guard}` };
      continue;
    }
    if (head === 'cd') {
      if (words.length !== 2) return { allow: false, reason: 'cd with more than one argument' };
      const target = words[1];
      if (target.includes('..')) return { allow: false, reason: `cd ${target}` };
      const resolved = isAbsolute(target) ? target : resolve(worktreeRoot, target);
      if (!isInside(resolved, worktreeRoot)) return { allow: false, reason: `cd outside the worktree: ${target}` };
      continue;
    }
    if (head !== 'git') return { allow: false, reason: `command ${head}` };
    const judged = confinedGitArgv(words.slice(1), { worktreeRoot });
    if (judged.allow !== true) return judged;
  }
  return { allow: true };
}

/**
 * Bounded per-session memory of pending tool calls, so an approval request can
 * be judged from the command it actually belongs to rather than from the
 * model-authored justification that rides along with it.
 */
export function createCallMemory(options = {}) {
  const limit = options.limit ?? 32;
  const bySession = new Map();

  return {
    /** Record one `tool/call` event. */
    remember(sessionId, callId, command) {
      if (typeof sessionId !== 'string' || typeof callId !== 'string' || typeof command !== 'string') return;
      let calls = bySession.get(sessionId);
      if (calls === undefined) {
        calls = new Map();
        bySession.set(sessionId, calls);
      }
      calls.set(callId, command);
      while (calls.size > limit) calls.delete(calls.keys().next().value);
    },
    /** The command belonging to one pending call, if it is still remembered. */
    commandFor(sessionId, callId) {
      const calls = bySession.get(sessionId);
      return calls === undefined ? undefined : calls.get(callId);
    },
    /** Forget one session (it left the registry). */
    forget(sessionId) {
      bySession.delete(sessionId);
    },
  };
}
