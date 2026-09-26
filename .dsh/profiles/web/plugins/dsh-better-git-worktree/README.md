# dsh-better-git-worktree

Git worktree **sessions** for the DeepSeek Harness: a session can live in a git
worktree permanently, instead of the harness's review/acceptance lifecycle.

It borrows the UX of [`dsh-git-worktree`](https://github.com/wloops/dsh-git-worktree)
(the composer switch, the session-list status indicator, the session-header menu,
the sidebar browser integration) and drops everything else: there is no review
checkpoint, no preview/apply, no delivery handoff. A worktree here is simply
where the session works.

## What it does

- **Composer switch (blank sessions).** A `Worktree` toggle sits in the composer
  tool row. Turning it on opens one confirmation dialog; confirming creates the
  branch and worktree immediately and continues **that** session inside it. The
  toggle then reads ON and disabled, because the session is in a worktree.
- **`worktree_convert` tool.** Takes a session running in a checkout, creates a
  worktree, moves its uncommitted work into it (kept recoverable as a `git
  stash` entry), and continues the conversation in a session rooted there. Once
  a session is in a worktree the tool is denied for that agent's scope, so it
  leaves the tool list.
- **Session-list status indicator.** **Blue "Progressing"**, **green "Pushed"**,
  plus a **yellow glow** when the branch needs rebasing (independent of the icon
  colour). The tooltip and the session hover card spell out the full status.
- **Worktree sessions are grouped under their project.** The sidebar shows a
  worktree session inside the workspace it was branched from, not as its own
  top-level workspace — the worktree workspace is a host-registered
  implementation detail and is hidden from the list.
- **Header pill and menu, for every session.** The pill reads
  `<name> - <status>` (`brave-otter - Progressing`, `main - In Sync`) and is
  coloured exactly like the sidebar badge. Its menu offers *Git Changes* (the
  `dsh-better-sidebar` git lens), *Review branch vs `<default>`* (this plugin's
  own branch-review panel, with a refresh action), *git fetch* (available for
  every session), *Copy worktree path* / *Open worktree folder* for worktree
  sessions, and *Move this session into a worktree* for the rest. Without
  `dsh-better-sidebar` the review content renders in an inline modal.
- **Archiving a worktree session asks about the working copy.** Hitting
  *Archive* on a worktree session opens one dialog: *Remove worktree and
  archive*, *Archive and keep the worktree*, or *Cancel*. It names the path and
  branch and warns about uncommitted paths and unpushed commits. Removing also
  retires the dead workspace registration, so nothing is left behind in the
  sidebar.
- **Background git with a cache.** TTL cache (single-flight,
  stale-while-revalidate), a 15 s background refresher, and a 90 s-throttled
  `git fetch` that never blocks a read.

## Working copies are real git worktrees

A session in a worktree gets a genuine `git worktree add` checkout: the branch
and object store stay in the source repository, so there is nothing to clone and
nothing to keep in sync. Each one is named with a two-part pet name
(`brave-otter`), used for its directory, its branch (`dsh/brave-otter`) and every
surface that shows it.

The trade-off is deliberate. A linked worktree keeps its **index** and its
**branch ref** in the source repository's `.git`, and the harness confines a
session to its own checkout (`dsh-sandbox-policy`: the workspace root is the
session cwd). So the agent's first `git add` or `git commit` inside a worktree is
a write outside that boundary, and it asks for the standard sandbox escalation.
That is the intended shape here — read widely, write locally, escalate
explicitly — rather than something to work around by copying the repository.

Working copies live outside every repository: `$DSH_HOME/worktrees/…` normally,
`~/.dsh-worktrees/…` when `$DSH_HOME` (or any candidate base) sits inside a git
working tree, so a worktree can never show up as untracked files in some other
checkout.

## Status semantics

| Badge | Meaning |
| --- | --- |
| blue `Progressing` | work is not published yet: no upstream, or commits ahead of it |
| amber `Behind` | the upstream moved on and the branch has nothing of its own |
| green `Up To Date` | exactly in step with its upstream, but not identical to `origin/<default>` |
| green `In Sync` | in step with its upstream **and** identical to `origin/<default>` |
| grey `Missing` | the recorded working-copy directory is gone |

A **yellow glow** is a separate overlay: the branch has its own commits and
`origin/<default>` has moved on, so it needs rebasing.

Working-tree detail (staged / modified / untracked) is in the tooltip, not the
colour.

## Layout

```
index.mjs               canonical Host entry (re-exports host-main.mjs)
host-main.mjs           Host half: registry, status pipeline, RPC, tool, Workspace election
host/git-runner.mjs     git process runner + TTL cache
host/repository.mjs     repository facts and the working-copy status fold
host/registry.mjs       durable session → worktree registry (…/worktrees.json)
host/working-copy.mjs   creation, the change-move, the repair, branch review
client.js               GENERATED browser bundle — do not hand-edit
client.template.js      Client half source, with the inlined official bundle placeholder
scripts/build-client.mjs       regenerates client.js (see NOTICE)
scripts/dev-reload-host.mjs    development-only Host reload lever (below)
entry-rN.mjs            generated Host entry revisions (development lever)
```

## Wiring

The profile row (`.dsh/profiles/web/cordis.patch.yml`) mounts the package and
disables the original plugin:

```yaml
    - id: better-git-worktree
      name: ./plugins/dsh-better-git-worktree/entry-rN.mjs

- id: dsh-git-worktree
  disabled: true
```

No `ui-workspace` row is needed: the Host half disables the official Workspace
row while it is active (restoring that row's composed `disabled` option on
teardown), because it has to stand in for it — see `NOTICE`.

### The managed worktree root

`$DSH_HOME/worktrees/dsh-better-git-worktree/…`, **unless that path is inside the
repository being branched** — which it is in this deployment, where `$DSH_HOME`
is `dsh-deploy/.dsh`. A working copy there would flood the source repository's
`git status` with untracked files, so in that case the managed trees go to
`~/.dsh-worktrees/dsh-better-git-worktree/`.

## Rebuilding the client bundle

```sh
node scripts/build-client.mjs          # regenerate client.js
node scripts/build-client.mjs --check  # fail if it is stale
```

The build parses the generated bundle before writing it, so a syntax error fails
the build instead of blanking the app. A running harness picks a new bundle up
through its client bundle watcher.

## Development: editing the Host half without a restart

The loader imports a row's module once per process and node caches ES modules by
URL, so a Host-side edit is otherwise invisible until the service restarts.
`scripts/dev-reload-host.mjs` writes a fresh `entry-rN.mjs` (new URL), versions
`host-main.mjs`'s `./host/*.mjs` imports with the same revision, and repoints the
profile row:

```sh
node scripts/dev-reload-host.mjs
```

The image therefore keeps its Host logic in modules reached by **static**
imports. Do not convert them to `await import()`: the loader holds its module
lock while a row's module evaluates, and a dynamic import from there never
settles — the entry simply never applies. That is why the versioning is done by
rewriting import specifiers rather than at runtime.

On a deployment that can simply restart, point the row at `index.mjs`, delete the
`entry-rN.mjs` files and strip the `?rN` suffixes; nothing else changes.

## Verified behaviour

- Composer switch → dialog → worktree created, session continues there, badge
  shown, toggle reads ON. A draft typed before confirming (with its attachments)
  is carried into the new session's composer.
- In a worktree session, `touch foo.md && git add foo.md && git commit` under
  `workspace-write` asks for the standard escalation, exactly as any write
  outside the session's checkout would.
- Archiving a worktree session prompts, and *Remove worktree and archive*
  deletes the copy, drops the registry record, retires the workspace
  registration, and leaves no stray row behind.
- Status transitions: unpushed commit → progressing; upstream in step and
  divergent from the default branch → up to date; identical to `origin/<default>`
  → in sync; upstream ahead → behind; `origin/<default>` advanced on top of
  branch commits → the rebase glow.

## Notes

- **The harness cannot re-root a running session.** `session.header.cwd` is
  immutable creation metadata, so "convert this session" means *continue the
  conversation in a session created in the worktree*. For a blank session (the
  composer switch) that is invisible; for a live session the continuation carries
  the conversation prefix and the source session is archived.
- **This harness version has no un-archive affordance.** Because the plugin's own
  flows archive source sessions, the sidebar projection keeps sessions this
  plugin owns visible even if they land in the workspace archive set.
- Moving uncommitted work uses `git stash`; the stash entry is deliberately kept
  as a backup and its ref is reported. If the replay fails, the stash is popped
  back into the source checkout.
