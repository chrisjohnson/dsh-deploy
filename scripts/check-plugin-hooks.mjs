#!/usr/bin/env node
// Gate for React Rules-of-Hooks violations in the Web GUI's *local* profile plugins.
//
// Why this exists: `.dsh/profiles/web/plugins/*/client*.{js,mjs}` are hand-written
// browser React with no build step, no typecheck and no lint — nothing else catches a
// hook-order bug before a user's browser does. These plugins receive their standard
// state as HOOK-VALUED PROPS (`useInput`, `useProjection`, `useSessions`, …), so the
// ordinary defensive reflex (`useInput ? useInput(sel) : null`) silently turns a hook
// call conditional. When that guard flips for a mounted component, every hook below it
// lands on another hook type's slot and React throws "Should have a queue" (production
// `Minified React error #311`); the renderer's SlotErrorBoundary swallows it into a
// BLANK COMPOSER that only a page reload clears.
//
// Usage:
//   node scripts/check-plugin-hooks.mjs [dir ...]        # scan (default: the plugins dir)
//   node scripts/check-plugin-hooks.mjs --core           # also scan installed @deepseek-ai UI bundles
// Exit 1 on a violation, 0 otherwise. Warnings never fail the run.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const wantCore = args.includes('--core');
const dirs = args.filter((a) => !a.startsWith('--')).map((a) => resolve(ROOT, a));
const targets = (dirs.length ? dirs : [join(ROOT, '.dsh/profiles/web/plugins')])
  .concat(wantCore ? [join(ROOT, 'node_modules/@deepseek-ai')] : []);

const FILE = /^client.*\.(js|mjs)$/;
// Hook names follow the `use[A-Z]` convention; a dotted receiver counts (`props.useX(`,
// `React.useX(`), `refuseAttachments` does not (hence the no-word-char lookbehind and the
// dot immediately before the name, rather than a permissive prefix).
const HOOK_NAME = String.raw`(?:[\w$.]*\.)?(?:React\.|react\.)?use[A-Z]\w*`;
const CALL = new RegExp(`(?:^|[^\\w$])((?:${HOOK_NAME}))\\(`);
// `?` that is not part of `??` (nullish coalescing a hook RESULT is legal).
const TERNARY_BEFORE = (line, index) => {
  const before = line.slice(0, index).replace(/\?\?/g, '§§');
  return before.includes('?') || before.includes('&&');
};
// A ternary split over lines: the call's line opens with `?`/`:`, or the line above
// ends with an operator. (`typeof` alone on the line above is NOT enough — that flags
// every unrelated statement that follows a seat type-check.)
const OP_CONT_IN = /^\s*[?:]/;
const OP_CONT_OUT = /[?&:]\s*$/;
const SEAT_GUARD_RETURN = new RegExp(String.raw`\bif\s*\([^)]*typeof\s+[\w$.]*use[A-Z]\w*[^)]*\)\s*return`);

const files = [];
const walk = (dir) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (FILE.test(entry.name) && statSync(full).size < 4_000_000) files.push(full);
  }
};
for (const target of targets) { try { if (statSync(target).isDirectory()) walk(target); } catch { /* absent */ } }

const failures = [];
const warnings = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const match = CALL.exec(line);
    if (match) {
      const previous = lines.slice(0, i).reverse().find((l) => l.trim() !== '' && !l.trim().startsWith('//'));
      const gated =
        TERNARY_BEFORE(line, match.index) ||
        OP_CONT_IN.test(line) ||
        (previous !== undefined && OP_CONT_OUT.test(previous));
      if (gated) {
        failures.push({ file, line: i + 1, text: trimmed, hint: `call ${match[1]} unconditionally (fallback seat → branch on the RESULT)` });
      }
    }
    if (SEAT_GUARD_RETURN.test(line)) {
      warnings.push({ file, line: i + 1, text: trimmed, hint: 'early return gated on a hook seat — no hook call may follow it in this function' });
    }
  }
}

const shown = (list, kind) => {
  for (const hit of list) {
    console.log(`${kind} ${relative(ROOT, hit.file)}:${hit.line}  ${hit.text.slice(0, 110)}`);
    console.log(`       ↳ ${hit.hint}`);
  }
};
shown(failures, 'FAIL');
shown(warnings, 'warn');
console.log(
  `\nchecked ${files.length} client file(s): ${failures.length} violation(s), ${warnings.length} warning(s)`,
);
process.exit(failures.length ? 1 : 0);
