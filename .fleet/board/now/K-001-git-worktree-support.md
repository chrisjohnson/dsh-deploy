---
id: K-001
# Filename pattern: {ID}-{slugified-title}.md
title: Git worktree support for parallel agent sessions
initiative_id: null
claimed_by: session-2963a257
claimed_at: 2026-09-08T03:39:40Z
blocks: null
blocked_by: null
status: null
related_cards: []
---

# K-001 — Git worktree support for parallel agent sessions

## Context

**The problem.** Every dsh session in this stack is sandboxed to its own
immutable workspace root (the session's SessionHeader.cwd), but when two or
more sessions — or one session plus its fan-out of subagents — target the
same git checkout under /work, they share one working tree and one index.
The failure modes are the well-known ones: index.lock contention, dirty
trees clobbering each other, a branch switch under an agent's feet, and
runtime state leaking between sessions (the Codex CLI bug #11435 pattern:
shared session dirs corrupting parallel runs).

**Research fan-out (5 workers, 2026-09-08).** Full raw reports in
.research/ (gitignored scratch; this card is self-contained). Summary:

1. **Ecosystem (NO official dsh registry — community catalogs:
   awesome-dsh-plugin / awesome-dsh-plugin.com, 3,363 entries, mirrored as
   the dsh-plugin-catalog npm package; plus dsh-market and dshplug.com).**
   A dense worktree plugin cluster exists in the "Git & Code Review"
   section (11+ plugins; adoption data from live npm/GitHub, 2026-09-08):
   - wloops/dsh-git-worktree (npm, 11 stars, ~3,419 dl/mo, pushed
     2026-09-05 — HIGHEST ADOPTION) — worktree "Session Targets": isolated
     task sessions, Ready-for-Review state, reversible Local Preview,
     human-confirmed delivery, env retention/recovery.
   - Letter2025/dsh-task-worktree (npm v0.4.1, ~2,234 dl/mo — BEST
     DOCUMENTED) — task-scoped worktrees on own branch, durable
     <repo>/.dsh-worktrees/ manifest (survives restarts), human-gated
     bring-back (move to local) or direct commit.
   - HeathHe/dsh-worktree-panel (npm, ~857 dl/mo) — sidebar grouping
     project → main/linked worktree → sessions; create/remove worktrees;
     dirty-tree and active-session safeguards.
   - alpathe/dsh-worktree (@alpathe/dsh-simple-worktree npm v1.0.13,
     ~1,134 dl/mo) — creates task branches and **registers the worktrees
     as DSH Workspaces** (the closest fit to our workspaceRegistry
     integration), opens isolated sessions.
   - JohnXu22786/worktree-mgr — per-task create/sync/finish lifecycle,
     task-name → branch derivation, double-checked merge targets, batch
     cleanup.
   - alpacachen/dsh-worktree — minimal (one button, one dialog).
   - Also worktree-aware: Cerbur/clutch-dsh (9 stars, pushed 2026-09-07,
     worktree session management in a multi-plugin monorepo),
     LaoYueHanNi/dsh-git-worktree, MoonlitDropOfBlood/dsh-git-manager,
     Palaiologos1453/dsh-worktree-studio (validation-bound merge
     delivery), february2015/dsh-taskswarm (parallel worktree "lanes"),
     Web0926/dsh-llm-verifier (candidate agents in detached worktrees),
     dennisrongo/dsh-plugins (dsh-git tab incl. worktree ops),
     kaixinbaba/dsh-git-workbench, JohnXu22786/worktree-mgr (create/sync/
     finish lifecycle, git-dep only), alpacachen/dsh-worktree (minimal).
   - Adjacent multi-checkout/sandbox patterns worth stealing:
     AngelosZou/dsh-multi-folder (8 stars — secondary working dirs with
     read/write/exec), somnusovis/dsh-multi-workspace (auto-grants
     file-write to every registered workspace).
   - **Native precedent:** the DeepSeek Harness **desktop (Tauri) client
     ships dsh-tauri-worktree built-in** — "create a Git worktree per
     session ... keeps concurrent tasks on separate branches and protects
     the repository's main checkout" — but it is bundled in the desktop
     client, not an installable standalone plugin.
   - Distribution: install contract is uniform — declare a dsh.bundle
     patch (cordis.patch.yml insert), optional dsh.client.inject for web
     panels (server lib/ + client/client.js); install via dsh plugin add,
     npm (leaders are npm packages) or git dep pinned by SHA (the pattern
     this stack already uses for dsh-claude-cli / dsh-web-search-searxng)
     or local files in a profile. No official worktree plugin ships with
     dsh.
   - **Verdict (refined after deep-dive): ready-made, actively-maintained
     dsh worktree plugins EXIST — the gap is not existence but fit: the
     cluster is web-UI panels / task-scoped single-worktree helpers; none
     implements agent-layer isolation of every concurrent session AND
     subagent with sandbox re-scoping (see §3 immutable-root finding),
     and none is vetted for this stack. Evaluate the top three first
     (Phase 0); build first-party only if evaluation fails.**

2. **Prior art (other harnesses).** Claude Code has the most mature model
   (official docs, code.claude.com/docs/en/worktrees): --worktree/-w CLI
   entry, EnterWorktree/ExitWorktree model tools, desktop auto-per-session
   worktrees, default location .claude/worktrees/<name>/ on branch
   worktree-<name>, baseRef fresh|head, PR-branch (--worktree "#1234"),
   subagents with isolation: worktree frontmatter (temporary worktrees,
   auto-removed when finished clean), git worktree lock while active +
   marker + periodic retention sweep (cleanupPeriodDays), .worktreeinclude
   for gitignored files, WorktreeCreate/WorktreeRemove hooks for custom
   placement, 4 non-disableable isolation checks (file edits, command cwd,
   git redirects, unparseable commands), resume contract (verify worktree
   still exists). Codex CLI: no native worktrees; manual git worktree add
   + per-instance $CODEX_HOME is the community pattern. oh-my-pi: task
   subagent fans out into isolated worktrees; its changelog shows the
   classic premature-cleanup race (deleted a running subagent's worktree)
   — the exact failure class our cleanup must avoid. Cline Kanban / VS
   Code: board cards get worktrees, diff review in card, ship via Open PR,
   trash → git worktree remove; VS Code offers "worktree OR folder"
   isolation. @tintinweb/pi-subagents (pi ecosystem): a worktreeIsolation
   toggle (off|worktree) gives each subagent an isolated git worktree and
   refuses worktrees on non-isolated paths — the SMALLEST clean analog to
   port for our subagent goal. Claude Agent SDK (@anthropic-ai/
   claude-agent-sdk) exposes the contract side (WorktreeCreate/Remove
   hook events, EnterWorktree/ExitWorktree inputs, worktree config:
   branchFrom fresh|head, bgIsolation worktree|none, symlinkDirs,
   sparseCheckDirs) but contains NO git-worktree execution — that lives
   in the Claude Code CLI — so porting the SDK gives the contract, not
   the executor. Anthropic issue #45645 (closed): stale
   repositoryformatversion=1 / extensions.worktreeConfig left in shared
   .git/config after worktree teardown poisoned other tools — **clean
   teardown is a hard requirement**.

3. **Verified dsh seams (installed v0.1.0-rc.8, evidence in
   .research/sdk.md and below):**
   - Tools register via ctx.tools.register(defineTool({...}))
     (dsh-tool-bash/lib/index.js:259; defineTool from
     @deepseek-ai/dsh-tools).
   - **Isolation enforcement exists:** tools/pre-execute is the
     reorderable allow/deny/ask gate and ctx.tools.guard(guard) registers
     a monotonic owner policy — plain-context = global, agent.ctx =
     per-agent; a returned string is a final denial reason (dsh-tools
     README L5, L25). This is how a worktree session can be hard-kept out
     of the main checkout (the dsh analog of Claude Code's isolation
     checks).
   - Host-plane lifecycle: ctx.on('agent/created', ({agent}) => ...),
     ctx.on('agent/disposed', ...), per-agent
     agent.ctx.on('session/event', (subject, event) => ...) firehose
     (worked example: dsh-home-seed/profiles/web/plugins/continue-kicker.mjs
     L254ff).
   - **Sandbox root is immutable per session:** workspace-write confines
     writes to the session's SessionHeader.cwd (+ /tmp); setSandboxMode
     changes mode only, never root; "the immutable SessionHeader.cwd
     recorded at creation is the root for every call in that session"
     (dsh-sandbox-policy README). **Consequence: a worktree is only
     sandbox-writable if (a) the session is created with cwd = the
     worktree path, or (b) the worktree lives UNDER the session's
     workspace root.**
   - Workspace registry: ctx.workspaceRegistry.create(path, title),
     Workspace.attachSession(id) group sessions by canonical path
     (dsh-workspace README) — the sidebar grouping seam.
   - Subagents inherit the parent session's cwd (dsh-subagent-claude-code
     README: "derives the child cwd from the parent Session") —
     per-subagent worktrees need an upstream cwd-override seam
     (Phase 2/3).
   - The bash tool's default workdir is session.header.cwd
     (dsh-tool-bash README); per-call workdir override available.
   - **No worktree support anywhere in the installed @deepseek-ai
     packages** (grep-verified).

4. **Git ground truth (experimented in this container, git 2.39.5):**
   - Nested worktrees inside the main tree work: git worktree add
     <repo>/.wt/<n> rc=0; parent git status shows "?? .wt/" → must be
     gitignored.
   - Dirty worktree: git worktree remove fails with "contains modified or
     untracked files, use --force" (rc=128); --force removes.
   - Stale worktree (dir deleted out from under, e.g. manual cleanup or
     re-clone): listed as "prunable"; git worktree prune removes the entry
     and the .git/worktrees/<name>/ metadata.
   - Branch already checked out elsewhere: fatal: a branch named 'X'
     already exists (rc=255) — uniqueness must be enforced by the plugin,
     not by retry.
   - Concurrent commit (one worktree) + branch creates (main) succeeded
     together in a simple race; ref-lock contention is possible but rare —
     treat transient lock errors as retryable, not fatal.
   - Plain git worktree add does NOT set extensions.worktreeConfig in this
     git (the #45645 pollution came from a specific tool's behavior; still,
     verify-and-restore config on teardown).
   - git worktree list --porcelain gives stable parseable output.
   - Worktree metadata entry is named after the worktree PATH basename,
     not the branch — the plugin must track path→branch itself.

5. **This stack (local-ai-machine / dsh-deploy):**
   - /work holds real multi-session targets: local-ai-machine (box config
     repo), asdf-herdr, printer-dashboard (dirty, on a feature branch),
     pi-web-perf-metrics; plus non-repos.
   - /work is a host bind mount shared with pi-web and oh-my-pi — worktree
     dirs under it are visible cross-tool (acceptable: they are
     gitignored; document the .wt/ convention in local-ai-machine).
   - Web profile wiring: plugins reach the container via (a) local file +
     cordis.patch.yml insert (continue-kicker pattern), or (b) git dep:
     profile package.json dependencies + dsh.profile.bundles, image build
     dep in /app/package.json, and an entrypoint symlink
     ln -sfn /app/node_modules/<p> /dsh-home/profiles/web/node_modules/<p>
     (docker-entrypoint.sh L79-100). Profile package.json is
     always-overwritten on seed; other seed files are no-clobber.
   - Container is recreated on every deploy (writable layer destroyed;
     /work and /dsh-home survive) → worktree state must live under /work
     or /dsh-home, and cleanup must tolerate "session died mid-work".
   - Pushes of worktree branches reuse the existing GitHub App credential
     helper (fresh ~1h token per use) — no credential work; branch naming
     (wt/*) keeps agent branches reviewable and easy to batch.
   - Session runtime state is keyed by session id under /dsh-home
     (DSH_SESSION_JSONL), NOT by cwd — dsh already avoids the Codex
     #11435 class of shared-runtime-state bug; only git-side state needs
     the worktree.

**The best solution (synthesis).** Claude Code's layered model, adapted to
dsh's hard constraints: **(1)** worktrees created *before* session start,
with the session's cwd = the worktree path (only way to stay in
workspace-write without escalation, given the immutable sandbox root);
**(2)** placement under the repo's own tree at <repo>/.wt/<slug>/
(sandbox-writable when the session is rooted at the repo, gitignored);
**(3)** model-invoked management tools (list/status/create/remove/prune)
plus a per-agent ctx.tools.guard that keeps a worktree session out of the
main checkout; **(4)** lock-while-active + dsh-owned marker + retention
sweep + clean-teardown cleanup (remove, then prune, then config-verify)
with hard refusals for dirty trees and live sessions; **(5)**
per-subagent worktrees once upstream exposes a child-cwd seam. Evaluate
the existing cluster first — if a candidate passes the acceptance
criteria, pin it instead of building.

## Plan

### Phase 0 — Evaluate off-the-shelf plugins (spike, ~1 day)
1. [ ] In a scratch profile (NOT the box's web profile yet): install the
      top candidates — wloops/dsh-git-worktree (highest adoption, npm),
      Letter2025/dsh-task-worktree (best documented, npm v0.4.1), and
      @alpathe/dsh-simple-worktree (registers DSH Workspaces — closest
      integration fit, npm v1.0.13); optionally HeathHe/dsh-worktree-panel
      and Cerbur/clutch-dsh for UI comparison. Prefer npm refs for the
      scratch run; mirror the stack's git-dep-pin-by-SHA pattern only for
      what gets adopted. Install via dsh plugin --profile <scratch> add
      <ref> (or the entrypoint symlink pattern for git deps).
2. [ ] Score each against the acceptance criteria below (sandbox
      compatibility is the gate: does creating/using a worktree require
      danger-full-access escalations? does cleanup respect live
      sessions?).
3. [ ] Record the verdict in the Decision log. If one passes: pin it in
      the web profile, document, and close this card at Phase 1 scope. If
      none passes (expected): proceed to Phase 1 with the candidate's UX
      notes as requirements input.

### Phase 1 — First-party dsh-git-worktree plugin (core)
Build as a local file plugin in dsh-deploy's seed (continue-kicker
pattern) so it is config-as-code and auditable:
4. [ ] Host-plane engine (dsh-home-seed/profiles/web/plugins/
      dsh-git-worktree.mjs or a small module tree beside it):
   - [ ] create(repo, slug, base): base in {fresh (fetch origin/HEAD),
         head (local HEAD), branch:<name>}; path <repo>/.wt/<slug>;
         branch wt/<slug> (uniqueness-checked, fail loud on collision);
         write dsh-owned marker (e.g. .wt/<slug>/.dsh-worktree json with
         session id, created-at, base) and git worktree lock it.
   - [ ] list/status/remove/prune wrappers over git, using --porcelain
         output; remove = refuse if dirty (unless explicit force from a
         human UI action), refuse if a live session is attached, else
         git worktree remove + git worktree prune + config-verify (no
         stray worktreeConfig/repositoryformatversion).
   - [ ] Track live sessions per worktree path from agent/created /
         agent/disposed (agent.id = session id; session header cwd).
5. [ ] Session-bootstrap flow (the "new worktree session" action):
      client-side companion (composer button or workspace-picker
      extension — same client-plugin pattern the git-manager plugins use)
      calls the host engine to create the worktree FIRST, then adopts the
      worktree path as the session's workspace directory, so
      SessionHeader.cwd = worktree path and the whole session stays
      workspace-write with zero escalations. Register the worktree path
      in ctx.workspaceRegistry (title: "repo · wt/<slug>") so sessions
      group under it in the sidebar.
6. [ ] Model-facing tools (register via ctx.tools.register(defineTool())):
      worktree_create, worktree_list, worktree_status, worktree_remove,
      worktree_prune — args/semantics per the engine above. A
      worktree_create called from a session rooted at the main checkout
      creates a NESTED worktree the model can use via per-call workdir
      (documented in the prompt section); session-root worktrees come
      from step 5.
7. [ ] Isolation guard: on agent/created, if the session cwd is a dsh
      worktree, register a per-agent ctx.tools.guard (via agent.ctx) that
      denies tool calls whose target path or bash workdir resolves into
      the MAIN checkout (denial reason tells the model its worktree
      path). Dispose the guard on agent/disposed. (Approximates Claude
      Code's 4 isolation checks with the monotonic guard; log every
      denial.)
8. [ ] systemPrompt contribution (same mechanism as dsh-tool-bash's
      tool:bash section): worktree conventions — where worktrees live,
      branch prefix, "stay in your workdir", cleanup policy, when to call
      which tool.
9. [ ] Cleanup sweep: on agent/disposed → if worktree clean (no
      changed/untracked, no unpushed commits) AND unlocked AND no other
      live session → auto-remove (keep the branch, offer PR handoff);
      otherwise keep and surface it. Periodic sweep (cordis timer
      plugin) → git worktree prune for stale entries, and remove
      marker-bearing, lock-free, aged (>N days, config), clean
      worktrees. NEVER auto --force; NEVER remove a worktree dsh didn't
      create (no marker).
10. [ ] Config + wiring: cordis.patch.yml insert with config block
      (worktreeDir: .wt, branchPrefix: wt/, cleanupDays, autoSweep). No
      compose/entrypoint changes (local file plugin rides the existing
      seed-copy). Per-repo: add .wt/ to .gitignore (separate small
      changes in local-ai-machine etc.).

### Phase 2 — Subagents + handoff (after Phase 1 is live)
11. [ ] Per-subagent worktrees: children currently inherit the parent
      cwd, so sibling subagents share the parent's worktree. Requires an
      upstream seam (child-cwd override at subagent spawn — a provider
      hook in dsh-subagent-* or a subagent option); file the upstream
      issue first, implement here once merged. Fallback until then:
      document "one subagent at a time per worktree, or use nested
      worktrees via worktree_create + workdir".
12. [ ] Merge/PR handoff: UI action (and tool) to push wt/<slug> and
      open a PR through the existing GitHub App credential helper;
      per-worktree diff view (can reuse an existing diff plugin from the
      Phase 0 shortlist).
13. [ ] .worktreeinclude equivalent: copy gitignored runtime files (.env*)
      from the main checkout into new worktrees (config list).
14. [ ] Resume/repair contract: on session reopen, verify the worktree
      still exists (.git file + git worktree list); if the dir is gone
      but metadata remains → prune + inform; if metadata is gone → offer
      re-attach to the branch.

### Phase 3 — Upstream contribution
15. [ ] Propose to @deepseek-ai/dsh: (a) a per-session workspace-root
      extension or mutable-root seam (would allow sibling-dir worktree
      placement and per-subagent roots without hacks); (b) worktree
      lifecycle primitives. Port this plugin's engine upstream when
      accepted; this card then shrinks to "use built-in".

### Acceptance criteria (Phase 1)
- Two concurrent web sessions on the same repo (e.g. local-ai-machine),
  both in workspace-write mode, no approval escalations, no
  cross-session edits visible; both can commit/push independently.
- A session in a worktree cannot write to the main checkout (guard
  denies, with a reason the model can act on) — verified by trying.
- Killing the container mid-session leaves no worktree in a state that
  blocks the main checkout; after restart, the sweep prunes stale
  metadata; git status in the main checkout is clean (.wt/ ignored).
- Removing a dirty worktree is refused by the engine and only a human
  force action (or model with explicit user approval) removes it.
- Session resume lands back in its worktree; a manually-deleted worktree
  is detected and surfaced, not silently broken.
- No stale extensions.worktreeConfig / repositoryformatversion left in
  shared config after any teardown (test explicitly, per #45645).

### Risks / open questions
- R1: client-plugin API for the composer button / picker extension —
  exact seam to be confirmed during Phase 0/1 (the git-manager plugins
  prove it exists; dsh-client-ui-directory-picker-browse documents the
  workspace directoryFlow; published worktree plugins confirm the
  dsh.client.inject pattern over @deepseek-ai/dsh-client-* layers).
- R1b: there is NO stable dsh worktree/workspace-target API (grep across
  installed packages: 0 hits) — every plugin self-convents (Letter2025
  manifest, alpathe registers Workspaces). Our plugin must define its
  convention explicitly (this card: workspaceRegistry + .wt/ + marker
  file) and Phase 3 should ask upstream to ratify it.
- R2: guard path-resolution for bash commands (a "git -C mainrepo ..."
  inside a worktree session) — Claude Code treats unparseable shapes as
  denials; we may need conservative "deny on uncertainty" for git
  commands in worktree sessions.
- R3: nested worktrees bloat the main repo's .git/worktrees/ and the
  parent's untracked list if the gitignore is forgotten — sweep +
  gitignore step mitigate; verify with the local-ai-machine repo.
- R4: /work is shared with pi-web/oh-my-pi — their agents could
  accidentally edit a dsh worktree. Mitigation: .wt/ gitignore +
  convention note in local-ai-machine; (stronger) shared AGENTS.md.
- OQ: should the headless profile also get the plugin (CI-style parallel
  runs)? Likely yes, cheap once the engine is a shared module.
- OQ: naming — wt/<slug> branch prefix vs Claude's worktree-<name> vs the
  one ecosystem convention observed (Letter2025's <repo>/.dsh-worktrees/
  manifest dir); keep wt/ (shorter, namespaced) unless Phase 0 shows
  stronger convergence.
- OQ: this deploy's /app/package.json pins dsh-web-search-searxng to
  github.com/d3cker/dsh-web-search-searxng, but npm and the local
  checkout point at owner chinng-inta — reconcile which repo is canonical
  (unrelated to worktrees, flagged by the ecosystem scan).

## Signals
<!-- append-only. Leave signals for other agents. Format:
     <!-- signal: <pet-name> <ISO8601-UTC> — <short message> -->
-->
<!-- signal: session-2963a257 2026-09-08T01:45Z — card created after 5-worker research fan-out; raw reports in .research/ (gitignored). Plan ready to claim; start at Phase 0. -->
<!-- signal: session-2963a257 2026-09-08T02:10Z — ecosystem deep-dive landed (research/ecosystem.md): ready-made plugins confirmed (wloops ~3.4k dl/mo, Letter2025 v0.4.1, alpathe registers DSH Workspaces); verdict refined — gap is agent-layer isolation + sandbox re-scoping, not existence. Phase 0 list and context updated. -->
<!-- signal: session-2963a257 2026-09-08T03:39:40Z — claimed; started Phase 1 implementation on branch feat/dsh-git-worktree-plugin (user-directed: build first; Phase 0 off-the-shelf eval deferred as later comparison). -->

## Decision log
<!-- append-only, one line per entry, newest last. Never move this card to done/
     without a line here explaining why. -->
- 2026-09-08: Card created. Research verdict: no audited ready-made dsh worktree plugin; evaluate top-3 candidates first (Phase 0), build first-party plugin if they fail the sandbox-compatibility gate.
- 2026-09-08: Placement decided: nested <repo>/.wt/<slug> under the workspace root — the only placement writable under workspace-write without escalations, given SessionHeader.cwd immutability (dsh-sandbox-policy). Sibling placement deferred to an upstream root-seam (Phase 3).
- 2026-09-08: Session-rooted worktrees are created BEFORE session start (cwd = worktree path); post-creation re-anchoring is impossible with the current SDK, so the auto path is the bootstrap flow + model-invoked nested worktrees, not an agent/created re-home.
- 2026-09-08: Cleanup policy: lock-while-active + dsh marker + retention sweep + clean teardown; never auto --force; never touch worktrees without a dsh marker (Claude Code model; oh-my-pi premature-delete and Anthropic #45645 as the two cautionary cases).
- 2026-09-08: User directed starting the PR directly (build-first); Phase 0 off-the-shelf evaluation deferred to a later comparison, not a blocker for the first-party core.
- 2026-09-08 (ecosystem deep-dive): verdict refined — ready-made actively-maintained dsh worktree plugins DO exist (wloops/dsh-git-worktree top adoption ~3,419 dl/mo; Letter2025/dsh-task-worktree best documented; alpathe/dsh-simple-worktree registers DSH Workspaces). They are UI panels / task-scoped helpers, none does agent-layer isolation of sessions AND subagents with sandbox re-scoping, none is vetted for this stack → Phase 0 evaluates the top three (wloops, Letter2025, alpathe) before any first-party build. No official dsh plugin registry exists; distribution is community catalogs (awesome-dsh-plugin, 3,363 entries).

## Handoff notes
- Start with Phase 0: clone wloops/dsh-git-worktree and
  HeathHe/dsh-worktree-panel into a scratch profile and score them
  against the acceptance criteria — the sandbox-escalation question is
  the gate.
- Raw research reports: .research/harnesses.md (prior art + synthesis,
  complete), .research/ecosystem.md (plugin catalog with adoption data,
  complete), .research/git.md (git experiments), .research/sdk.md (SDK
  skeleton; the verified seam facts are quoted in Context §3 above —
  treat those as the source of truth), .research/awesome-dsh-plugin-
  README.md (full ecosystem catalog; "Git & Code Review" section at
  L2616). A SDK seam-map subagent may still land detail in .research/ —
  fold in if present.
- Phase 0 scratch-profile eval order: wloops/dsh-git-worktree,
  Letter2025/dsh-task-worktree, @alpathe/dsh-simple-worktree — all npm,
  so a plain dsh plugin add works without the git-dep/symlink dance.
- Do NOT touch the box's live web profile until the Phase 0 verdict is
  logged.
- Per-repo .wt/ gitignore changes belong to their own repos (local-ai-
  machine etc.), not this one.





