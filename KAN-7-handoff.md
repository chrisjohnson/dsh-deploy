# KAN-7 — images in ticket bodies: deploy + restart handoff

Shipped in `dsh-plugins`:

| package | tag | merge commit | what it changes |
| --- | --- | --- | --- |
| dsh-kanban | **`dsh-kanban-v0.11.0`** | `487b037` ([PR #63](https://github.com/chrisjohnson/dsh-plugins/pull/63)) | Ticket bodies can carry images: paste / drop / **Add image** in both the New-ticket dialog and the ticket editor, thumbnail tiles with a working X, a read-only **Body** markdown panel in the detail, and an **Attached images** host-path section in the plan session's prompt. Image bytes live in DSH core's content-addressed attachment store — **no new table, no schema migration, no new config keys**. **This is the version to deploy.** |

Pinned in this worktree (branch `dsh/kan4-deploy`, fast-forwarded onto `main`
`f1de936` first so the pin builds on the released 0.10.0): both `package.json`
and `.dsh/profiles/web/package.json` move from `dsh-kanban-v0.10.0` to
**`dsh-kanban-v0.11.0`**, root `pnpm-lock.yaml` updated (it resolves the tag to
`487b037`), and **both installed trees verified at 0.11.0** — the root
`node_modules/dsh-kanban` and the profile tree dsh actually serves the browser
half from (`.dsh/profiles/web/pnpm-lock.yaml` is gitignored by design; it is
written by the install, not committed).

## What changes on the board

- **Images in bodies.** A ticket body carries image references as markdown:
  `![name](kanban-image:sha256:<64 hex>)`. The bytes are stored by DSH core's
  attachment service (`ctx.attachments.saveImage`) under
  `$DSH_HOME/attachments/v1/objects/xx/<sha256>` — validated (png/jpeg/webp/gif,
  20 MB), content-addressed, deduped, durable across restarts. The body stays
  the single source of truth; nothing else records the images.
- **Two-phase refs.** While a draft is open in the browser the ref carries a
  client token (`kanban-image:pending-<token>`). On save the Host stores every
  upload and rewrites every pending token to its real id **before** the body is
  written. A failed image store, an unresolvable token, or a malformed ref means
  **no ticket is created and no patch is applied** — the board never sees a
  half-resolved body.
- **Caps.** Ten images per ticket, 20 MB each, four media types. The client
  enforces them visibly while editing (a red line under the rail); the Host
  re-checks everything on save regardless of what the client sent.
- **Detail Body panel.** The ticket detail Overview gained a read-only **Body**
  panel rendering the body as light markdown (headings, lists, bold/italic,
  inline and fenced code, links, blockquotes) built as React elements — the
  body is untrusted data and is never interpreted as HTML. Each image ref is
  fetched through the new `readImage` RPC (which re-digest-verifies the stored
  bytes against the id they are read under) and rendered as a real `<img>`; a
  ref whose bytes no longer resolve renders as an *image unavailable* chip
  instead of vanishing. The detail response also carries an `images` array
  derived from the body refs.
- **Agents see the images.** A plan session's ticket block ends with
  *Attached images (read-only, on this host):* listing each image's absolute
  host path (via `ctx.attachments.imageHostPath`), so the session's
  `read_image` tool can look at what the human pasted.
- **The 0.10.0 lock still holds.** Editing a started ticket is refused
  (`ticket_started`) before any image is stored; the image gate sits in front of
  the same guarded `editTicket` boundary.

No new configuration key. The board schema stays at V4. A profile without the
attachment service still boots kanban fine — only an actual image write says
anything about it.

## 1. Update the live checkout (needs write access to `/home/dsh/dsh-deploy`)

**Both trees must be installed** — a root-only install updates the host side and
silently leaves the browser half on 0.10.0 (this repo's `AGENTS.md`):

```sh
cd /home/dsh/dsh-deploy
git status --porcelain          # cordis.patch.yml drift is expected; commit or stash it first
git pull --ff-only              # main carries the pin commit
grep -n 'dsh-kanban' package.json .dsh/profiles/web/package.json
# both lines must read dsh-kanban-v0.11.0

pnpm install                                  # root tree
cd .dsh/profiles/web && pnpm install && cd -  # the tree dsh actually loads from
pnpm run check                                # check-no-links: ok

# PRE-RESTART ASSERTIONS - do not restart until all eight hold:
grep -m1 '"version"' node_modules/dsh-kanban/package.json                        # 0.11.0
grep -m1 '"version"' .dsh/profiles/web/node_modules/dsh-kanban/package.json      # 0.11.0
test -f .dsh/profiles/web/node_modules/dsh-kanban/src/images.mjs && echo ok      # ok (new module)
grep -c 'readImage'     .dsh/profiles/web/node_modules/dsh-kanban/src/host.mjs   # >= 3 (endpoint + case)
grep -c 'prepareBodyImages' .dsh/profiles/web/node_modules/dsh-kanban/src/host.mjs  # 3 (import + create + update)
grep -c 'Add image'     .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs # 1
grep -c 'renderMarkdown' .dsh/profiles/web/node_modules/dsh-kanban/src/client.mjs # 2
grep -c 'Attached images' .dsh/profiles/web/node_modules/dsh-kanban/src/engine.mjs # 1
```

If the profile-tree lines do not hold, the profile tree is still the old
tarball: re-run `pnpm install` inside `.dsh/profiles/web` before touching the
service.

## 2. Production restart — Chris, planned window only

A restart ends every session running in the service, including any agent
session on this box. Do not run it from a session, and pick a window with no
kanban workflow turn in flight (check the board first: a blue, glowing card is
a turn running; a static red one is parked and safe).

```sh
sudo systemctl restart dsh
```

## 3. Post-restart verification

```sh
systemctl status dsh --no-pager | head -5
journalctl -u dsh --since "-3 min" --no-pager | grep -i kanban | head
# expect: applied: db=… routes=/api/kanban/{board,…,sessionInfo,readImage}
```

Then in the GUI (:3081, Kanban panel) — **hard-reload the tab first**
(Cmd/Ctrl+Shift+R), the client half is snapshotted at boot. Confirm from the
browser console:

```js
!!document.getElementById('kanban-styles')?.textContent.includes('kb-img-tile')  // true = new client live
```

- **Create with a pasted image.** + New ticket → type a body → paste a
  screenshot into the body box (or drop a file, or press **Add image**). A
  thumbnail tile appears and the body text gains
  `![…](kanban-image:pending-…)`. The tile's × removes tile and ref together.
  Create the ticket.
- **The stored body carries a real id.** In the detail, the Body panel renders
  the image as a real `<img>` (devtools: `src` is a `data:image/…` URL). From
  the shell:

  ```sh
  sqlite3 "$DSH_HOME/kanban/kanban.db" "select body from tickets order by created_at desc limit 1"
  # contains kanban-image:sha256:<64 hex>, no pending- anywhere
  ls "$DSH_HOME/attachments/v1/objects"/* | head   # the object file exists
  ```

- **Edit adds and removes.** The pencil on this still-pristine ticket opens the
  editor: add one image, remove one, save. The detail shows exactly the new
  set; no pending refs in the body.
- **A started ticket's pencil stays locked.** Drag a ticket with an image into
  Working; once its plan session attaches, the pencil is disabled
  (*Locked — the ticket has already started*) and `update` answers
  `ticket_started`.
- **The agent sees the image.** Open that started ticket's plan session: its
  first prompt ends with *Attached images (read-only, on this host):* and one
  `- <name>: /home/dsh/.dsh/attachments/v1/objects/xx/<sha256>` line per image;
  `read_image` on that path succeeds in the session.
- **Console is clean.** No `slot entry crashed`, no `Minified React error` —
  the image rail adds hooks only inside the existing form components, called
  unconditionally (the repo's hook gate reports 0 findings).

## Lab evidence (before release)

The full browser suite ran against the lab (`scripts/lab.sh`, kanban linked to
the feature checkout) — **24/24 checks passed** (the Playwright driver script
and screenshots were kept during verification and cleaned from the tree after;
what each check proved):

- picker/paste/drop each insert a pending ref + tile in CreateForm; text-only
  paste and non-image files are untouched; × removes tile and ref.
- create persisted `kanban-image:sha256:…` refs with **no pending- left**
  (sqlite-checked); two byte-identical uploads deduped to one object (content
  addressing working).
- the detail Body panel rendered every markdown element (heading, bold, code,
  link, list, blockquote, fenced pre) and three `data:`-URL `<img>`s; a ref to
  an id not in the store rendered the *image unavailable* chip.
- the editor added and removed images and saved; the 11th image in a fresh form
  was refused with the visible cap message at exactly 10 tiles.
- the plan session's prompt artifact carried
  `Attached images (read-only, on this host):` with the real
  `/home/dsh/dsh-lab/default/.dsh/attachments/v1/objects/…` path, and that file
  read back as a valid PNG.
- the started ticket's pencil stayed disabled.

Two bugs the lab caught that unit tests could not: the Host reached the
attachment store through the `ctx.attachments` property sugar, which a real
Cordis context refuses without an inject declaration (now `ctx.get('attachments')`
via `resolveAttachments`); and the client's cap double-counted freshly inserted
refs, stopping the rail at five tiles instead of ten. Both fixed and re-verified
before the tag.

Repo checks on the final commit: `npm run check` (verify + hooks gate 0 findings
+ all suites) and `node scripts/compose-smoke.mjs` 11/11 green; CI on PR #63
green across contract, node 20.9/22/24, and compose.

## Rollback

Pin the previous tag and reinstall both trees, then restart in a planned window:

```sh
cd /home/dsh/dsh-deploy
sed -i 's/dsh-kanban-v0\.11\.0/dsh-kanban-v0.10.0/' package.json .dsh/profiles/web/package.json
pnpm install && (cd .dsh/profiles/web && pnpm install)
sudo systemctl restart dsh
```

Bodies saved by 0.11.0 keep their `kanban-image:` refs; 0.10.0 renders them as
plain markdown text and its prompts carry no Attached images section. The
attachment objects themselves are inert files — nothing to clean up.

## Decisions worth knowing about

- **No new table, no migration.** The earlier design space included an
  `images` table; it was rejected because the body markdown already carries the
  refs and core's store already provides durability, validation, and dedup. The
  one consequence: the read path cannot recover the full `ImageAttachmentRef`
  facts (bytes/width/height) that `ctx.attachments.readImage` verifies against,
  so `readImageFromStore` reads through `imageHostPath` and re-digests the
  bytes — the same integrity guarantee, derived from the content-addressed id.
- **`pending-<token>` refs are a draft-only wire format.** They never survive a
  save: the Host rejects a body that still carries one, so the DB only ever
  holds well-formed ids.
- **The editor rail shows drafts, not saved images.** Saved refs live in the
  body text (and render in the detail's Body panel); the tiles are the
  not-yet-uploaded ones. Removing a saved image is deleting its markdown line.
