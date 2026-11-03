# KAN-21 handoff — image tiling for the medium-dense vision cap, and what still needs the human

## What shipped

New plugin `dsh-image-tiler` **0.2.0** — dsh-plugins PRs #79 (0.1.0, tag
`dsh-image-tiler-v0.1.0` at `4fb3feb`) and #80 (0.2.0, tag
`dsh-image-tiler-v0.2.0` at `fb69ab3`), pinned in both manifests
(`package.json`, `.dsh/profiles/web/package.json`) and in the profile's
`dsh.profile.bundles`, installed in both trees, live checkout at `558a1d7`.

The feature: a global `agent/pre-step` listener. When a user message about to
enter a step carries an attached image whose stored pixels exceed the routed
model's cap, the image is cut into the smallest overlapping rows×cols grid
whose every tile fits under `cap * safetyFactor` (default 0.95), PNG-encoded
via sharp, committed through `ctx.attachments.saveImages`, and the tiles plus
one explanatory note text block replace the oversized block **before** the
step lands in the session log. The cap is deployment config —
`cordis.patch.yml`'s new `image-tiler` row maps
`local-ai-machine (eGPU)/medium-dense` → `393216`, the eGPU llama.cpp build's
`--image-max-pixels` (dsh's own pipeline normalizes only to 4M px, so the
mismatch must be closed in dsh before the request). pi-ai's strict model-route
schema strips unknown keys, which is why the cap is a plugin row, not a model
field. Routes with no `caps` entry (big-moe) are never touched.

Fail-open by design: no cap, the tile valve (`maxTilesPerImage`, default 32),
unreadable bytes, animated rasters, storage errors, or any internal blow-up
keeps the original block (plus a note when it was over cap) and never rejects
the step.

0.2.0 (after Chris's live test found the gaps): `policy: ask | tile |
send-whole` (row sets `ask`) — an over-cap paste now poses the choice on the
turn through the harness approval card (approve tiles into the planned grid,
reject sends whole with a downscale hint); `askFallback` (default tile)
resolves asks no human can answer. Route resolution reads the session's
PENDING model selection first, fixing the live first-message gap (production
session 3d1e0e0f: composer pick 23:25:53, untiled paste 23:26:59, tiled only
after the header minted). Grid scoring penalizes slivers: 1536x1024 now
tiles 3x2 (6 tiles), a 4K screenshot 5x6 near-square instead of 1x26.

Also in this branch: `scripts/lab.sh link` now allows checkouts under
`<prod>/.dsh-worktrees` (the same exception `assert_lab_dir_safe` already had)
— without it no ticket worktree could ever link a plugin.

## Service state — one restart is owed, and it now covers two tickets

The build never touched the service. Production fingerprint at pre-staging:
`MainPID=4142753`, `ActiveEnterTimestamp=Mon 2026-11-02 21:31:25 UTC`,
`NRestarts=0`.

That 21:31:25 boot predates the KAN-30 0.16.3 pin too, so **one restart picks
up both**: `dsh-kanban` 0.16.3 (denylist backslash fix) and
`dsh-image-tiler` 0.1.0. **Update:** Chris restarted at 23:24:31 (new PID
596092) which took up 0.1.0 + kanban 0.16.3; 0.2.0 then merged and the live
checkout still needs `git pull` + `pnpm install` in BOTH trees + one more
restart (the round-2 deploy was pre-staged only to origin/main `7a891cd` —
the build session could no longer write to the live checkout).

```sh
sudo systemctl restart dsh    # Chris, in a planned window — never grantable
```

Before it, `systemctl show dsh -p MainPID -p ActiveEnterTimestamp` should
still read 4142753 / 21:31:25. After it, a new PID and timestamp, and the
disk state the new process boots into is already verified:
`node -p "require('/home/dsh/dsh-deploy/node_modules/dsh-image-tiler/package.json').version"`
→ `0.1.0`, `…/dsh-kanban/package.json` → `0.16.3`, and
`pnpm run check` → `check-no-links: ok`.

## Verifying after the restart

1. `journalctl -u dsh --since "<restart time>" | grep dsh-image-tiler` —
   expect one line: `active (enabled=true, overlapRatio=0.12, safetyFactor=0.95,
   maxTilesPerImage=32, logToStderr=true, caps={"local-ai-machine (eGPU)/medium-dense":393216})`.
2. Over-cap paste: in a **medium-dense** session, paste a screenshot larger
   than 393,216 px (e.g. 1536×1024). Expect the turn to proceed and the stderr
   log to show `Image 1536x1024 split into 5 overlapping tiles (1x5 grid),
   each <= 373555 px (cap 393216)`; the composer shows the tiles with the
   note. (A 2×2 grid is arithmetically impossible under this cap — 818×545
   tiles are 445,810 px — so 1×5 is the correct fewest-tile answer.)
3. Under-cap paste (≤ 393,216 px) on medium-dense, or any paste on big-moe:
   no tiling log line, image arrives whole.

Rollback: pin `dsh-image-tiler` out of both manifests (or set
`enabled: false` in the row), reinstall both trees, restart in a planned
window. The plugin stores nothing durable beyond the tile attachments
themselves.

## Verification trail

- dsh-plugins main `4fb3feb`: `node --test packages/image-tiler/test/*.test.mjs`
  → 32/32 pass; `npm run check` → verify 0 errors, hook gate clean, 868/868;
  `compose-smoke.mjs image-tiler` → ok (imports, layer + 1 row, profile wiring).
- Lab (`.dsh-worktrees/nimble-reef/.lab/default`, destroyed after the run;
  reports preserved under `.dsh-worktrees/nimble-reef/e2e/evidence/`):
  1536×1024 paste on medium-dense → session log holds 5 image blocks of
  340×1024 = 348,160 px each + the note, and the real medium-dense turn read
  the tile text (its reasoning quoted fragments across tile borders);
  640×480 paste → single untouched block, no note; big-moe paste of the same
  1536×1024 → single untouched 1,572,864-px block. Smoke: all tiler-relevant
  checks pass; the 5 residual failures are environmental (yama
  ptrace_scope=1 blocks the /proc isolation check, a copied production
  session 404s on /api/changes.summary, copied loop-watchdog ledger data,
  one model-turn timing flake).
- Live checkout: both installed copies byte-identical to the tag
  (`diff -r` clean), merged `cordis.patch.yml` carries the row at line 398
  alongside the UI-written kanban drift (committed as `b10b543`).
