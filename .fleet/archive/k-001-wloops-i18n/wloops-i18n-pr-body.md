# Add i18n for all client-UI strings via the dsh locale registry

Extracts every browser-visible Chinese string in `src/client/**` (~290 keys) into a plugin-owned `worktree` locale namespace and wires it through the dsh locale system, so the plugin renders in the active locale (zh/en) with Chinese behavior unchanged.

## What changes

- **`src/client/locales/worktree.ts`** — `worktreeZh` (byte-identical to the previously hard-coded strings) + `worktreeEn` translation, a compile-time bilingual key-set balance assertion, the `WorktreeLocaleKey` / `WorktreeTranslate` types, shared `TARGET_STATE_KEYS` / `SIDEBAR_STATE_KEYS` label maps, and `registerWorktreeLocale(locale)`.
- **`src/client/locales/worktree-locale.d.ts`** — ambient declaration merging the `worktree` key set into `LocaleNamespaceMap` wherever the full dsh type graph is present.
- **Components** — every UI string now resolves through a `WorktreeTranslate` function. `t` rides the existing `services` objects (`WorktreeClientServices` gains `t: WorktreeTranslate`); the presentational pieces (`WorktreeReviewPanel`, `DeliveryProof`, `PreflightStatus`, `PreSessionWorktreeToggle`) take it as an explicit prop.
- **`src/client/index.tsx`** — binds the namespace and registers both dictionaries with the locale runtime in a fiber effect (disposed with the fiber); slot descriptors carry `locale: 'worktree'`. The console-remote entry passes an optional bound `t` into the remote adapter (zh fallback when no locale service is present).
- **Tests** — all 325 existing tests keep their exact-Chinese assertions: fixtures wire a zh-backed translate (`tests/support/zh-translate.ts`) that resolves keys through the shipped `worktreeZh` dictionary, so the assertions now verify the dictionary itself.

## Intentionally not in the locale tables

- **Agent-facing recovery prompts** (recovery-analysis / handoff / conflict-resolution instructions sent to sessions) — they are protocol text, not UI copy.
- **Host-side protocol literals the browser matches on** (e.g. the target-not-selected detection in `WorktreeReviewRow`) — commented in place.
- **Host-side (node) messages** — separate design question; happy to follow up.
- `console-remote/adapter.ts` keeps a zh fallback path for standalone use; its codec-rejection detection now matches on the error **code** instead of the (now translatable) message, so classification is locale-independent.

## Verification

- `pnpm typecheck` clean
- `pnpm test`: 325/325 passing (22 files)
- `pnpm run build` clean; the built bundle's external-require set is unchanged (the locale module is data-only)
- Verified against a dsh 0.1.0-rc.8 deployment running dsh-git-worktree 0.4.0 where the locale service is installed in the client fiber

## Notes for review

- The `locale` service is declared in the plugin's `inject` list, so the client entry treats it as a hard dependency; the remote adapter tolerates its absence (zh fallback) because it can be mounted in a fiber without it.
- If you prefer the shared `common` namespace for generic verbs (cancel/close), the keys are isolated enough to dedupe in a follow-up.
