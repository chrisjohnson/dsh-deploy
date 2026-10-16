---
id: K-002
# Filename pattern: {ID}-{slugified-title}.md
title: Session cost badge in the composer stats bar
initiative_id: null
claimed_by: null
claimed_at: null
blocks: null
blocked_by: null
status: needs-refinement
related_cards: []
---

# K-002 — Session cost badge in the composer stats bar

## Context

**The problem.** Sessions accumulate real token spend that is not visible in the
UI. `litellm` reports cost per turn and `dsh-context` (v0.69.1) already computes
the per-session dollar total internally, but there is no badge in the
web GUI surface that surfaces it to the user. The user wants a single compact
cost pill next to the existing token-usage stats in the composer bar, and
silence when the cost is $0.

**Existing data sources (already in the running profile):**
- `dsh-context` (0.69.1) — `addBilledUsage` folds each turn's billed tokens into
  `contextTimeline.cost` using the models.dev price catalog. Exposes the cost
  via the `contextTimeline` session projection.
- `dsh-token-meter` (0.2.0-rc.2) — `tokenUsage` projection (`tokenUsageProjectionDefinition`,
  key `tokenUsage`) holds per-provider billed token totals:
  `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`.
  `StatsPills`/`UsagePill` in `dsh-client-ui-chat` already reads this projection
  (line 7133 of `client.js`) to render the "14.6M tok · Cache hit 97%" pill.
- models.dev price catalog for DeepSeek v4.1 Flash
  (`deepseek-flash` / `deepseek-v4-flash`): **$0.15/M input · $0.60/M output ·
  $0.003/M cache-read**, with peak/off-peak half-price windows (Beijing workday
  9–12 & 14–18 CST = full price, everything else half).

**Insertion point.** The `conversation.composer.dock` slot (kind: `list`,
session-scoped) is owned by `dsh-client-ui-chat`'s `StatsPills`/`UsagePill`,
registered at `order: 0`. This badge inserts at `order: 1` with `id: 'cost'`.
No other plugin owns this slot.

## Plan

1. [ ] Create `packages/session-cost/` in `github.com/chrisjohnson/dsh-plugins`
      with the standard layout (see file list below).
2. [ ] Implement `src/prices.mjs` — **pure** module, no DSH deps. Public
      models.dev price catalog keyed `{provider: {model: {inputPrice,
      outputPrice, cacheReadPrice, cacheWritePrice}}}`. Unit-tested.
      Includes DeepSeek v4.1 Flash rates and peak/off-peak half-price logic
      matching `dsh-context`.
3. [ ] Implement `src/client.mjs` — the UI half:
      - `useSessionCost(sessionId)` reads the `tokenUsage` projection (via the
        same `useProjection` bridge `StatsPills` uses) plus provider/model from
        `useSession()`, multiplies billed token totals by `src/prices.mjs` rates.
      - `<CostPill>` component registered into `conversation.composer.dock` at
        `order: 1`, `id: 'cost'`. Renders `"$X.XX"` (tabular-nums, theme-colored)
        when total > $0; `display: none` at $0 so the row height does not jump.
      - Calls `useSession`/`useProjection` unconditionally at the top level and
        branches on the result (hook-order rule: no conditional hook calls, no
        `typeof` guards, no early returns above hooks).
4. [ ] Implement `src/host.mjs` — thin re-export if a host-side hook is needed
      (initially client-only; `index.mjs` re-exports for consistency with the
      `dsh-plugins` convention).
5. [ ] Add `package.json` with `dsh.bundle.patch` + `dsh.client` fields,
      `peerDependencies` on `@deepseek-ai/*` with the repo-wide range
      `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`, and `engines.dsh` with the same.
      No bare `cordis` dependency.
6. [ ] Add `cordis.patch.yml` — bundle layer with `insert:` row, no `config:`
      (empty config block per the rules; this plugin carries no user-facing
      settings).
7. [ ] Develop and smoke-test in the lab:
      `scripts/lab.sh up`, `scripts/lab.sh link session-cost`, edit the
      checkout, `scripts/lab.sh restart`, `scripts/lab.sh smoke --only sessions`,
      verify the pill renders next to the token stats and hides at $0.
8. [ ] PR to `dsh-plugins`, tag `dsh-session-cost-v0.1.0`.
9. [ ] dsh-deploy PR: add tag spec to BOTH `package.json` files
      (`pnpm install`), add `dsh-session-cost` to `.dsh/profiles/web/package.json`'s
      `dsh.profile.bundles`, restart the `dsh` systemd service in a planned window.

**File layout:**
```
packages/session-cost/
  package.json            # bundle patch + client fields, peer deps
  cordis.patch.yml        # insert row, no config
  index.mjs               # thin host re-export
  src/host.mjs            # host-side projection hook (if needed)
  src/client.mjs          # useSessionCost hook + CostPill component
  src/prices.mjs          # pure price catalog (unit-tested)
  src/client.test.mjs     # price-book + formatting unit tests
  README.md
  CHANGELOG.md
  LICENSE
```

## Signals
<!-- append-only. Leave signals for other agents. Format:
     <!-- signal: <pet-name> <ISO8601-UTC> — <short message> -->
-->

## Decision log
<!-- append-only, one line per entry, newest last. Never move this card to done/
     without a line here explaining why. -->

## Handoff notes
<!-- what's half-done, what the next agent picking this up should do first. -->
