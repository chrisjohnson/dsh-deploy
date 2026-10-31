# KAN-14 — edit tickets, locked the moment one starts: deploy + restart handoff

Shipped in `dsh-plugins`:

| package | tag | merge commit | what it changes |
| --- | --- | --- | --- |
| dsh-kanban | **`dsh-kanban-v0.10.0`** | `2d00999` ([PR #62](https://github.com/chrisjohnson/dsh-plugins/pull/62)) | One unified **Edit ticket** modal replaces the "Edit modes and budget" pencil and the add-only acceptance dialog. Acceptance becomes editable **and** deletable (`store.setAcceptance`, recorded as an `acceptance_set` event carrying the prior and the new list). A ticket that has started in any way is **locked** to human edits: `store.isEditable`, an `editable` flag on every board card and in the detail, a disabled pencil, and `ticket_started` from `update`, `addAcceptance` and `setAcceptance`. **This is the version to deploy.** |

Pinned in this worktree (branch `dsh/silent-lantern`): both `package.json` and
`.dsh/profiles/web/package.json` move from `dsh-kanban-v0.9.3` to
**`dsh-kanban-v0.10.0`**, root `pnpm-lock.yaml` updated (it resolves the tag to
`2d00999`), and **both installed trees verified at 0.10.0** — the root
`node_modules/dsh-kanban` and the profile tree dsh actually serves the browser
half from (`.dsh/profiles/web/pnpm-lock.yaml` is gitignored by design; it is
written by the install, not committed). The branch was first fast-forwarded onto
`main` (`7000418`, the 0.9.3 pin) so this pin builds on the current released
state rather than the 0.5.1 state the worktree was cut from.

No new configuration key, and **no schema migration** — the board stays at V4.
Nothing about the engine's own writes changes.

## What changes on the board

- **One pencil, one modal.** The ticket detail hero has a single *Edit ticket*
  pencil. It opens one editor for the whole card — title, body, acceptance,
  planning (`now` / `when started`), questions (`ask me` / `decide
  autonomously`), priority, allow-paid, budget USD and workspace cwd — and
  saves everything in **one** `update` call carrying only what actually
  changed. The old "Edit modes and budget" dialog and the add-only acceptance
  dialog are gone; the acceptance panel's pencil opens the same editor.
- **Acceptance is now editable, not append-only.** One statement per line,
  stored verbatim: change a line to edit it, delete a line to remove it, clear
  the box to drop every criterion. The store replaces the rows in one
  transaction with ordinals 1..n and emits `acceptance_set` with
  `{prior: [...], next: [...]}`, so the words a human removed stay readable in
  the audit trail. An identical list is a no-op: no rewrite, no event.
- **The lock.** A ticket that has started in any way can no longer be edited by
  a human. `store.isEditable(id)` is the one predicate, and it says *editable*
  only while the ticket is pristine:

  ```text
  column is backlog or working
    AND phase === 'plan'
    AND attempt_count === 0
    AND spent_usd === 0
    AND needs_attention_reason IS NULL
    AND no child row in sessions, runs, spans or conditions
  ```

  The child-row clause is what catches the quiet touches. Production KAN-7 (a
  plan session that attached and then died on a restart) and KAN-3 (discarded
  while still at `plan`) both look pristine from the ticket columns alone.
- **What the lock looks like.** `editable` ships on every board card and in the
  detail; the hero pencil renders disabled with the tooltip *Locked — the
  ticket has already started* and does not open the modal. The Host refuses the
  same three ways again — `update`, `action addAcceptance` and the new
  `action setAcceptance` all answer
  `{ok:false, error:{code:'ticket_started', message:'KAN-n has already started;
  it can no longer be edited'}}`. A client that guessed wrong is corrected by
  the server, never by the UI alone.
- **What is deliberately *not* locked.** The guard sits at the human edit
  boundary (the new `src/edit.mjs`), **not** in `store.updateTicket`, so the
  engine's and the board's own writes keep working on a started ticket: card
  reorder (`sortOrder`), worktree creation (`workspaceCwd`), and the retry
  patch from a needs-attention resolution. And editing a pristine ticket does
  not lock it — a person may fix a card as often as they like before anything
  starts work on it.
- **The model-facing tools are untouched.** `kanban_submit_plan`,
  `kanban_submit_implementation`, `kanban_submit_review`, `kanban_approve`,
  `kanban_discard` and `kanban_plan` behave exactly as in 0.9.3.

## 1. Update the live checkout (needs write access to `/home/dsh/dsh-deploy`)

**Both trees must be installed** — a root-only install updates the host side and
silently leaves the browser half on 0.9.3 (this repo's `AGENTS.md`):

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only origin dsh/silent-lantern   # the pin commit (or merge it to main first)
grep -n 'dsh-kanban' package.json .dsh/profiles/web/package.json
# both lines must read dsh-kanban-v0.10.0

pnpm install                                  # root tree
cd .dsh/profiles/web && pnpm install && cd -  # the tree dsh actually loads from
pnpm run check                                # check-no-links: ok

# PRE-RESTART ASSERTIONS - do not restart until all nine hold:
grep -m1 '"version"' node_modules/dsh-kanban/package.json                       # 0.10.0
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json     # 0.10.0
test -f .dsh/profiles/web/node_modules/dsh-kanban/src/edit.mjs && echo ok       # ok (new module)
grep -c 'isEditable'      .dsh/profiles/web/node_modules/dsh-kanban/src/store.mjs  # 1
grep -c 'acceptance_set'  .dsh/profiles/web/node_modules/dsh-kanban/src/store.mjs  # 1
grep -c 'editTicket'      .dsh/profiles/web/node_modules/dsh-kanban/src/host.mjs   # 2
grep -c 'isEditable'      .dsh/profiles/web/node_modules/dsh-kanban/src/host.mjs   # 3
grep -c 'TicketEditor'    .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs # 2
grep -c 'ModeEditor\|AcceptanceEditor' .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs  # 0
```

If the last two do not hold, the profile tree is still the old tarball: re-run
`pnpm install` inside `.dsh/profiles/web` before touching the service.

## 2. Production restart — Chris, planned window only

A restart ends every session running in the service, including any agent session
on this box. Do not run it from a session, and pick a window with no kanban
workflow turn in flight (check the board first: a blue, glowing card is a turn
running; a static red one is parked and safe).

```sh
sudo systemctl restart dsh
```

## 3. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i kanban | head
# expect: applied: db=… routes=/api/kanban/{board,…,worktree,events,sessionInfo}
```

Then in the GUI (:3081, Kanban panel) — **hard-reload the tab first**, the
client half is snapshotted at boot:

- **A pristine ticket opens the editor.** Create a ticket in Backlog (do not
  drag it). Its detail hero pencil is enabled and titled *Edit ticket*. Change
  the title, the body, one acceptance line edited and one deleted, the
  priority, and flip allow-paid with a budget. **Save ticket** closes the
  modal and the detail shows all of it at once. Events tab: one
  `ticket_updated` and one `acceptance_set`, the latter showing
  `{"prior":[…],"next":[…]}`.
- **Editing does not lock.** Click the pencil again on the same ticket and save
  a second small change; it lands.
- **A started ticket is locked.** Drag a ticket into Working and wait a few
  seconds for its plan session to attach (the card turns blue / the sessions
  tab is no longer empty). The hero pencil is now greyed out, its tooltip reads
  *Locked — the ticket has already started*, and clicking it opens nothing.
  From the browser devtools console on that page:

  ```js
  await (await fetch('/api/kanban/update', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({id:'<ticket id>', patch:{title:'no'}})})).json()
  // {ok:false, error:{code:'ticket_started', message:'KAN-n has already started; it can no longer be edited', …}}
  ```

- **The engine still writes.** Drag that same started ticket lower in its
  column (reorder) and it saves; the board order persists across a reload.
- **Console is clean.** No `slot entry crashed in 'sidebar.panellist'` or
  `Minified React error` anywhere in the browser console — the editor is a new
  component, not a change to any slot entry's hook order.

## Lab evidence (before release)

Lab `kan14` (`:3099`, `LAB_ROOT=/tmp/kan14-lab`, cloned from `main` at
`7000418`, 6 copied quiet sessions), `dsh-kanban` **linked** to the 0.10.0
checkout (`/home/dsh/dsh-lab/plugins/dsh-plugins-kan14/packages/kanban`).

- `node --test packages/kanban/test/*.test.mjs` — **181 tests, 0 failures**
  (34 skipped: the tiers that need a configured host). Note `node --test
  packages/kanban/test/` is not a directory search on Node 22.23 — the glob is
  the equivalent form.
  - `store.test.mjs` (+8): the `isEditable` matrix — pristine in Backlog and in
    Working, plan-session-attached, phase moved to `implement`, `done` and
    `discarded` at plan phase (production KAN-3's shape), parked (KAN-7's
    shape), spend, attempt, run row, span row, condition rows, and a session
    detached after a real plan round (the run and span keep it locked) — and
    `setAcceptance`: replace with ordinals 1..n, verbatim storage, delete-all,
    validation (`not_found`, non-array, blank entry), the identical-list no-op,
    and `acceptance_set` carrying `prior` and `next`.
  - `edit.test.mjs` (new, 8): the boundary functionally — a pristine save of
    every field in one call, a second save still allowed, a started ticket
    refused with `ticket_started` and **nothing changed**, `not_found` for an
    unknown ticket, a bad acceptance list refused *before* any write, store
    validation surfacing as `bad_request`, both acceptance paths guarded, and
    the engine-internal `sortOrder` / `workspaceCwd` writes still open on a
    started ticket.
  - `host-contract.test.mjs` (+6): the host routes `update`, `addAcceptance`
    and `setAcceptance` through the guarded boundary and keeps the direct store
    writes for reorder / worktree / retry; `editable` present in both
    `summary()` and `detail()`; one editor in the client with every field and
    exactly one save call; the panel returns the response so the modal closes
    on success.
- `node scripts/verify.mjs` — 0 errors, 0 warnings across 11 packages.
  `node scripts/check-plugin-hooks.mjs packages/kanban` — **0 violations, 0
  warnings**. `npm run check` — green.
- `node scripts/compose-smoke.mjs kanban` — `ok dsh-kanban (imports, not
  skipped, layer + 1 row(s), profile wiring)`.
- CI on PR #62: `contract`, `tests` on Node 20.9 / 22 / 24, and `compose` —
  all pass; the same on the `main` push (`41205198901` success), which is what
  the tag `dsh-kanban-v0.10.0` (`2d00999`) was cut on.
- **Live click-through in the lab** (`/tmp/kan14-probe.mjs`, Playwright against
  the linked lab, screenshots in `<lab>/.lab/smoke/shots/`):
  - created a ticket through the UI → `board.editable: true`,
    `detail.editable: true`, acceptance stored as three lines;
  - opened the one editor and changed title, body, acceptance (one line
    edited, one deleted, one added), priority 3, allow-paid on, budget 9 →
    **one save** applied all of it, `editable` still `true`, and the events tab
    shows both `ticket_updated` and `acceptance_set`
    (`KAN-14-02-editor-open.png`, `KAN-14-03-events.png`);
  - a second ticket created and dragged to Working, its real plan session
    attached (`sessions: 1, spans: 1`) → `editable: false`, and
    `update` / `addAcceptance` / `setAcceptance` each answered
    `ticket_started` with the ticket unchanged, while `reorder` on the same
    ticket returned `ok:true`;
  - the locked ticket's pencil: `title: "Locked — the ticket has already
    started"`, `disabled: true`, and clicking it opened no dialog
    (`KAN-14-06-locked-working.png`);
  - a second human edit on the pristine ticket still returned `ok:true`;
  - **console clean throughout** — no `slot entry crashed`, no React error.
- `scripts/lab.sh smoke --only ui,kanban-recovery` with the plugin linked:
  **14 PASS, 0 FAIL, 0 SKIP** (`<lab>/.lab/smoke/RESULTS.md`). `ui` is 5/5
  including *no `slot entry crashed` or React errors in the console*;
  `kanban-recovery` is 9/9 — real role turns, the engine's own kicks, the park
  after the guard declines, and the degraded (no continue-kicker) path — so the
  engine flows that write tickets directly are proven unaffected by the lock.

## Rollback

Rollback is pinning the previous tag, reinstalling **both** trees, and
restarting in a planned window — the same path as the deploy:

```sh
cd /home/dsh/dsh-deploy
sed -i 's/#dsh-kanban-v0.10.0/#dsh-kanban-v0.9.3/' package.json .dsh/profiles/web/package.json
pnpm install && (cd .dsh/profiles/web && pnpm install)
pnpm run check
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json   # 0.9.3
sudo systemctl restart dsh
```

Nothing in 0.10.0 writes state that 0.9.3 cannot read: no schema change, and the
only new event kind (`acceptance_set`) is an audit row the old client ignores.
Tickets edited while 0.10.0 was live keep their edits.

## Decisions worth knowing about

- **A Working ticket nobody has touched is still editable.** The predicate is
  "any engine touch", not "in the Working column", so a ticket dragged to
  Working whose plan session has not started yet can still be fixed in place —
  which is the moment a human most wants to. If the rule should instead be "the
  drag itself locks it", that is one line in `store.isEditable` (drop
  `working` from the allowed columns) and a changelog sentence.
- **`acceptance: []` means "no acceptance criteria"**, not "leave it alone". The
  editor only sends the array when a line actually changed, so an untouched
  list is never cleared by accident.
- **The lock is human-boundary only.** The model-facing `kanban_*` tools and the
  engine's own store writes are deliberately outside it; a session working a
  ticket is the normal case, not an edit.
