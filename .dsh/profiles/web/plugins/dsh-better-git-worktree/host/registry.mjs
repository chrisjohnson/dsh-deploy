// dsh-better-git-worktree — the durable session → worktree registry.
//
// The registry is the plugin's own source of truth for "which sessions live in
// a worktree": the harness keeps a session's cwd immutable, so nothing else can
// answer that question. It is plain JSON under $DSH_HOME and is written
// atomically (temp file + rename) so a crash can never leave a half file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STATE_VERSION = 1;

/** Resolve the plugin's state directory under $DSH_HOME. */
export function stateDir(homeDir) {
  return join(homeDir, 'plugins', 'dsh-better-git-worktree');
}

export class WorktreeRegistry {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && parsed.version === STATE_VERSION) {
        for (const [sessionId, record] of Object.entries(parsed.worktrees ?? {})) {
          if (record !== null && typeof record === 'object' && typeof record.managedRoot === 'string') {
            this.records.set(sessionId, { sessionId, ...record });
          }
        }
      }
    } catch {
      // Missing or unreadable state is simply an empty registry.
    }
  }

  persist() {
    const payload = {
      version: STATE_VERSION,
      worktrees: Object.fromEntries([...this.records.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(temp, this.file);
  }

  get(sessionId) {
    return this.records.get(sessionId);
  }

  list() {
    return [...this.records.values()];
  }

  put(record) {
    this.records.set(record.sessionId, record);
    this.persist();
    return record;
  }

  patch(sessionId, fields) {
    const current = this.records.get(sessionId);
    if (current === undefined) return undefined;
    const next = { ...current, ...fields };
    this.records.set(sessionId, next);
    this.persist();
    return next;
  }

  remove(sessionId) {
    const existed = this.records.delete(sessionId);
    if (existed) this.persist();
    return existed;
  }

  /** Find the registry record for a session, or for any session sharing a worktree root. */
  findByRoot(root) {
    return [...this.records.values()].find((record) => record.managedRoot === root);
  }
}
