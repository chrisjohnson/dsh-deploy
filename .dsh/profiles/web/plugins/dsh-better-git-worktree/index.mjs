// dsh-better-git-worktree — canonical Host entry.
//
// The profile row currently points at a revisioned `entry-rN.mjs` so the Host
// half can be edited in a deployment that cannot restart the service (see
// scripts/dev-reload-host.mjs). This is the stable name a normal install can use
// instead; both re-export the same implementation.
export { default, inject, name } from './host-main.mjs';
