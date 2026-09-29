# AGENTS.md — Web-profile plugins (`profiles/web/plugins/`, i.e. `.dsh/profiles/web/plugins/`)

A file here with a `client*.{js,mjs}` half is **live browser React for the Web GUI**: it
mounts as a slot entry into the same React root as core. There is **no build, no
typecheck, no lint and no test** over these files — nothing stands between you and a
user's browser.

## Hooks: always call the seat, branch on the result

The slot renderer injects standard state as **hook-valued props** — `useInput`,
`useProjection`, `useSessions`, `useWorkspaces`, … Each call expands to ~4 real hook
slots, so the set of hooks a component calls must never depend on which props it got.
The defensive reflex is the bug:

```js
var input = useInput ? useInput(sel) : null;                     // WRONG
typeof useSessions === "function" ? useSessions(sel) : undefined  // WRONG
if (typeof seat !== "function") return null; // …more hooks below // WRONG
try { return seat(sel); } catch { return null; }                  // WRONG
```

A guard is *not* made safe by the seat "always being a function in practice": a
session-maybe entry adopts its first session **without remounting** (by design), so a
prop's presence can differ between two renders of one mounted component. React then
throws "Should have a queue" (production `Minified React error #311`; `#310` when the
list grew), the renderer's `SlotErrorBoundary` swallows it, and the region re-renders as
an empty `<div>` — a blank composer that only a page reload clears. That is exactly how
this bug shipped here: the crash surfaced far from the guard, with a message naming
neither React nor hooks.

Do instead, in order of preference:

1. Call unconditionally over a stable fallback, then branch on the **result**:

   ```js
   var NO_SEAT = function () { return null; };   // module scope → stable identity
   var input = (props.useInput || NO_SEAT)(sel);
   if (!input) …                                 // the result, not the seat
   ```

2. If a seat genuinely may or may not exist, branch on the **element**: render one of two
   components, or key one component by that presence, so React remounts and the hook list
   resets legally.
3. Never add an early `return` above a hook based on props.

Check it — this grep is the only gate these files get:

    node scripts/check-plugin-hooks.mjs

Expect 0 findings. It also accepts directories, which is useful when triaging an
installed bundle: `node scripts/check-plugin-hooks.mjs node_modules/dsh-context`. Core is
a clean control: the same scan reports 0 across all 69 `@deepseek-ai/dsh-client-ui-*`
bundles, so a hit there is news.

## Editing notes

- **`dsh-better-git-worktree/client.js` is generated** from `client.template.js` by
  `node scripts/build-client.mjs` (it inlines `@deepseek-ai/dsh-client-ui-workspace`'s
  client through exact-string seams). Edit the template and rebuild; `--check` reports
  whether the committed bundle matches. Editing `client.js` directly gets overwritten.
- **Nothing takes effect until the service restarts.** Bundle bytes are read during
  profile composition and only reach the served graph through the HMR hook
  (`clientModuleHost.rebuilt`); this deployment has no HMR service (the unit lacks
  `--expose-internals`). So: edit → `systemctl restart dsh` → reload the page. The
  restart also ends every session running inside that service, **including your own** —
  land and commit the work before restarting.
- `dsh-context` and `dsh-better-sidebar` are npm-installed and contain the guarded-seat
  pattern themselves. Don't hand-patch `node_modules`: pin, reproduce, report upstream.

## If a GUI region goes blank

The console logs `slot entry crashed in '<slotKey>':` (the renderer's
`SlotErrorBoundary`) and the slot renders `<div data-slot-error="<slotKey>">` in its
place. `#311`/`#310` mean a hook count changed in the entry owning `<slotKey>` — look in
this directory before suspecting core. The shipped bundle is minified with no sourcemaps;
a code's throw site can be read in
`node_modules/react-dom/cjs/react-dom.production.min.js`, and only a dev build prints the
offending component name.
