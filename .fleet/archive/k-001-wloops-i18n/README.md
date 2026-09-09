# K-001: wloops/dsh-git-worktree client-UI i18n contribution (abandoned 2026-09-09)

Complete, verified i18n contribution for **wloops/dsh-git-worktree**, built
against main @ 4a90c37 (v0.7.5). **Abandoned before opening the PR**: the
upstream maintainer shipped their own i18n implementation overnight
(2026-09-09). Nothing here was pushed to wloops.

## Files

| File | What it is |
| --- | --- |
| `wloops-dsh-git-worktree-client-i18n.patch` | Full change: 29 files, +1261/-391. `git apply`-verified against a clean v0.7.5 checkout. |
| `wloops-i18n-pr-body.md` | The PR description (scope, design notes, verification, review notes). |
| `wloops-i18n-apply-instructions.md` | Turnkey fork/apply/push/PR commands (now obsolete; kept for the record). |

## What the change did

Extracted all ~290 browser-visible Chinese strings from `src/client/**` into a
plugin-owned `worktree` locale namespace wired through the dsh locale system
(`@deepseek-ai/dsh-client-locale` + `@deepseek-ai/dsh-client-ui-slots`):

- `src/client/locales/worktree.ts` — `worktreeZh` (byte-identical to the
  previously hardcoded strings) + `worktreeEn` translation; compile-time
  bilingual key-set balance assertion; `WorktreeLocaleKey` /
  `WorktreeTranslate` types; shared `TARGET_STATE_KEYS` /
  `SIDEBAR_STATE_KEYS` label maps; `registerWorktreeLocale(locale)`.
- `src/client/locales/worktree-locale.d.ts` — ambient declaration merging the
  `worktree` key set into `LocaleNamespaceMap` where the full dsh type graph
  is present (must be a .d.ts: a module-scope augmentation hard-fails when
  ui-slots is not installed).
- Components read copy through `t: WorktreeTranslate` on the existing
  services objects; presentational pieces (panel, delivery proof, preflight,
  pre-session toggle) take an explicit prop.
- Client entry registers both dictionaries in a fiber effect (disposed with
  the fiber) and marks slot descriptors with `locale: 'worktree'`.
- Tests keep every exact-Chinese assertion: fixtures wire a zh-backed
  translate (`tests/support/zh-translate.ts`) resolving keys through the
  shipped `worktreeZh` dict.
## Design decisions worth keeping (if i18n work resumes on this plugin)

1. **Scope**: browser UI copy only. Agent-facing recovery prompts and
   host-side protocol literals (e.g. the target-not-selected match in
   `WorktreeReviewRow`) are protocol text, not UI copy — keep verbatim.
   Host-side (node) messages are a separate design question.
2. **No new package dependency.** Adding `dsh-client-ui-slots` as a devDep
   *breaks* `tsc --noEmit`: it makes the previously-unresolvable ui-slots
   import inside `dsh-client-ui-workspace`'s d.ts resolve to real (but
   incomplete-without-the-dsh-core) types, surfacing 3 errors in the
   vendored `workspace-sidebar/index.tsx` wrapper. The standalone plugin graph
   relies on those imports degrading to `any` under skipLibCheck.
3. **Locale-independent protocol matching**: where code matched its own
   (now-translatable) output string (the remote adapter's
   codec-rejection check), switch to matching the error **code**.
4. **Locale service availability**: the client entry declares `locale` in
   its inject list (hard dependency, guaranteed by cordis); the
   console-remote adapter tolerates absence with a zh fallback because it
   can mount in a fiber without the locale service.
5. **Test strategy**: zh-backed mock `t` = existing exact-string assertions
   keep working unchanged and now verify the dictionary itself.

## Verification evidence (2026-09-09)

- `pnpm typecheck` clean; `pnpm test` 325/325 (22 files); `pnpm run build`
  clean with the built bundle's external-require set unchanged (the locale
  module is data-only) — validated twice: the working tree, and a fresh
  patch apply on a clean v0.7.5 worktree.
- Context: built while this box ran the plugin 0.4.0 live under dsh
  0.1.0-rc.8; the locale service is installed in the client fiber there, so
  the runtime wiring (bind/register/effect) matches what the 0.7.x line
  expects.

## Why it was abandoned

- The GitHub App bot (`chrisjohnson0-ai-agents[bot]`) cannot open the PR:
  App tokens have no fork right (HTTP 403), the App is not installed on
  wloops/dsh-git-worktree (push denied), and App bots cannot create repos.
  The PR would have needed a human-account push.
- Before that push happened, upstream shipped its own i18n
  (2026-09-09, per user). The contribution is obsolete; the branch is
  preserved for prior art (scope decisions, dependency trap, test
  strategy) and possible salvage of the en dictionary.

## Resurrection path (if ever needed)

`/work/wloops-dsh-git-worktree` (scratch clone) still holds branch
`feat/client-ui-i18n` @ 639c639. If upstream's implementation lands and a
gap remains (e.g. missing en translations or uncovered surfaces), diff
their locale tables against `worktreeEn` in the patch rather than
re-applying it wholesale.
