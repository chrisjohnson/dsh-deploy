# Contributing

Direct pushes to `main` are the established workflow for this repo — no
PR requirement, no worktree-branch convention. No CI currently - dsh runs
natively (no Docker), so there's no image to build.

See `AGENTS.md` for what does and doesn't need Chris's confirmation before
proceeding (in short: ordinary work on this repo doesn't; deviating from
the standard deploy path does).

This repo has a `.fleet/board/` — it follows `local-ai-machine`'s own
fleet conventions (claim/signal/decision-log discipline; see that repo's
`AGENTS.md` for the full spec) for any ticket-driven work here.
