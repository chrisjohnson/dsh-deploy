// semantic-loop-kicker - versioned Host entry (live-reload lever).
//
// WHY THIS FILE EXISTS: node caches ES modules by resolved URL, and the cordis
// loader imports a row's module once per process. So an edit to
// semantic-loop-kicker.mjs is invisible to the running process until the dsh
// service restarts - even though this profile's cordis.patch.yml is watched
// and reloaded live. The `?r=N` query makes the module URL new, so the loader
// evaluates the real file again and the row picks up the edit without
// restarting dsh.
//
// NOTE: the cache key is the URL of the module the ROW names, so bumping only
// the query below is not enough - this file is imported under its own path and
// is cached too. Each reload therefore needs a NEW entry file plus a repoint
// of the row (exactly what scripts/dev-reload-host.mjs does for
// dsh-better-git-worktree, whose lever this is).
//
// TO RELOAD AFTER A HOST EDIT (current entry: r5, so the next one is r6):
//   1. cp semantic-loop-kicker-r5.mjs semantic-loop-kicker-r6.mjs
//   2. bump the `?r=5` below to `?r=6` in the NEW file
//   3. repoint the semantic-loop-kicker row in cordis.patch.yml at it
//   4. delete the superseded entry file
// The profile watcher remounts the row automatically.
//
// The row id and config are unchanged: only the module URL differs.

export { default } from './semantic-loop-kicker.mjs?r=5'
