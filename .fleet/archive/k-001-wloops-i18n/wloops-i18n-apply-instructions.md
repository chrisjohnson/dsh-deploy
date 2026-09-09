# Applying the client-UI i18n change to wloops/dsh-git-worktree

- Patch: `/work/wloops-dsh-git-worktree-client-i18n.patch` (3430 lines, verified against main @ 4a90c37 = v0.7.5: typecheck clean, 325/325 tests)
- PR body: `/work/wloops-i18n-pr-body.md`

The GitHub App bot (chrisjohnson0-ai-agents[bot]) cannot fork or push to wloops/dsh-git-worktree (App tokens have no fork right, and the App is not installed on that repo), so the PR must be opened from a human account.

## Turnkey (any machine with gh + git, logged in as your account)

```
git clone https://github.com/wloops/dsh-git-worktree
cd dsh-git-worktree
git checkout -b feat/client-ui-i18n
git apply /path/to/wloops-dsh-git-worktree-client-i18n.patch
pnpm install && pnpm typecheck && pnpm test   # expect 325/325
git add -A && git commit -m "Add i18n for all client-UI strings via the dsh locale registry"
gh repo fork wloops/dsh-git-worktree
git remote add fork https://github.com/<you>/dsh-git-worktree
git push fork feat/client-ui-i18n
gh pr create --repo wloops/dsh-git-worktree --base main --head <you>:feat/client-ui-i18n \
  --title "Add i18n for all client-UI strings via the dsh locale registry" \
  --body "$(cat /path/to/wloops-i18n-pr-body.md)"
```

Or send the patch + PR body to wloops directly (issue/email) and let them apply it.
