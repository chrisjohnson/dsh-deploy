/**
 * Table-driven test for the worktree pre-approval decision.
 *
 * Run: node scripts/test-approval.mjs
 *
 * The two "real" cases are the exact commands from the session that prompted
 * this feature (a denied `git commit` and the `git push` escalation).
 */

import { confinedGitDecision, createCallMemory } from '../host/approval.mjs';

const WORKTREE = '/home/dsh/.dsh-worktrees/dsh-better-git-worktree/strix-halo-r9700-llm-builds-zesty-sedge';

const ALLOW = [
  // the real escalation that started this
  `cd ${WORKTREE} && git remote -v && git push origin HEAD:main 2>&1 | tail -5`,
  `cd ${WORKTREE} && git add -A && git commit -m "modelctl: fix the log path"`,
  'git add -A && git commit -m "fix: thing"',
  'git status --short',
  'git log --oneline -5 | head -20',
  'git diff --stat',
  'git fetch origin',
  'git ls-remote --heads origin',
  'git blame src/index.mjs | head -20',
  'git grep -n "sandbox"',
  'git pull --rebase origin main',
  'git stash push --include-untracked -m wip',
  'git push -u origin HEAD',
  'git branch --show-current',
  'git rev-parse --abbrev-ref HEAD',
  `cd ${WORKTREE}/sub && git status`,
  'git add src/index.mjs && git commit -m "narrow change"',
  'git clean -fd',
  'git tag v1.2.3',
];

const DENY = [
  'sudo nixos-rebuild switch',
  'rm -rf /tmp/x',
  'git commit -m "x" && rm -rf ~/scratch',
  'git -c core.hooksPath=/tmp/hooks commit -m x',
  'git -C /home/dsh/other-repo commit -m x',
  'git --git-dir=/home/dsh/other/.git status',
  'git --work-tree=/tmp status',
  'git push --force origin main',
  'git push -f origin main',
  'git push --force-with-lease origin main',
  'git push --mirror origin',
  'git push --delete origin main',
  'git push origin +main',
  'git push origin :main',
  'git config user.email me@example.com',
  'git config --file /tmp/x user.email me@example.com',
  'git branch -D main',
  'git branch -m other',
  'git remote set-url origin git@evil.example:x.git',
  'git remote add evil git@evil.example:x.git',
  'git tag -d v1',
  'git clean -fdx',
  `cd ${WORKTREE}/.. && git commit -m x`,
  'cd .. && git commit -m x',
  'cd /home/dsh/strix-halo-r9700-llm-builds && git commit -m x',
  'git add /etc/passwd',
  'git add ../../outside.txt',
  'git apply /tmp/patch.diff',
  'git commit -m `whoami`',
  'git commit -m "$(date)"',
  'git commit -m "a" > /tmp/out',
  'git commit -m "a" | tee /tmp/out',
  'git commit -m "a"; rm -rf /tmp/x',
  'git commit -m "a" & git push',
  'git commit -m "a" # comment',
  'git filter-branch --all',
  'git worktree add /tmp/x',
  'git daemon --export-all',
  'echo hi',
  'cat /etc/passwd',
  'git',
  'git status && sudo reboot',
  'git status || rm -rf /tmp/x',
  'git commit -m "unterminated',
];

let failures = 0;
for (const command of ALLOW) {
  const decision = confinedGitDecision(command, { worktreeRoot: WORKTREE });
  if (decision.allow !== true) {
    failures += 1;
    console.log(`FAIL (should allow): ${command}\n      → ${decision.reason}`);
  }
}
for (const command of DENY) {
  const decision = confinedGitDecision(command, { worktreeRoot: WORKTREE });
  if (decision.allow === true) {
    failures += 1;
    console.log(`FAIL (should deny):  ${command}`);
  }
}

// The memory keeps only what a pending approval can still need.
const memory = createCallMemory({ limit: 2 });
memory.remember('s1', 'a', 'git status');
memory.remember('s1', 'b', 'git add -A');
memory.remember('s1', 'c', 'git commit -m x');
if (memory.commandFor('s1', 'a') !== undefined) {
  failures += 1;
  console.log('FAIL: call memory did not evict the oldest entry');
}
if (memory.commandFor('s1', 'c') !== 'git commit -m x') {
  failures += 1;
  console.log('FAIL: call memory lost the newest entry');
}
memory.forget('s1');
if (memory.commandFor('s1', 'c') !== undefined) {
  failures += 1;
  console.log('FAIL: call memory did not forget the session');
}

const total = ALLOW.length + DENY.length;
console.log(`${total - failures}/${total} decisions correct (${ALLOW.length} allowed, ${DENY.length} refused)`);
process.exit(failures === 0 ? 0 : 1);
