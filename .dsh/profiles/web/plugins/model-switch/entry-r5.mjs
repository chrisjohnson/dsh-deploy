// model-switch: VERSIONED host entry.
//
// Node caches ES modules by URL, so editing host.mjs is invisible to the running
// process — a live patch reload would remount the row but re-import the SAME
// cached module. The entry therefore carries a `?r=` cache-buster, and reloading
// host code after an edit is a three-step ritual with no service restart:
//
//   1. cp entry-r5.mjs entry-r5.mjs
//   2. inside entry-r5.mjs, change `?r=5` to `?r=5`
//   3. repoint the model-switch row's `name` in
//      .dsh/profiles/web/cordis.patch.yml at entry-r5.mjs, and delete entry-r5.mjs
//
// (Bumping only the query inside the SAME entry file does nothing: the entry's
// own URL is the cache key the loader already holds.) This is the same lever
// dsh-better-git-worktree uses with entry-r60.mjs and the semantic-loop-kicker
// row documents; preferred here over scripts/dev-reload-host.mjs because other
// sessions may be mid-turn when it changes.
//
// The Client half needs none of this: dsh-client-modules serves client bundles
// by content hash, so an edit to client.mjs reaches the browser on the next page
// load.
export { default } from './host.mjs?r=5'
