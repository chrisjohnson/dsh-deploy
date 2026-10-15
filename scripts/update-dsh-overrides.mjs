#!/usr/bin/env node
// Regenerates the @deepseek-ai/dsh* entries of pnpm-workspace.yaml's
// `overrides` block for a new @deepseek-ai/dsh target version. See
// AGENTS.md ("Upgrading the dsh version") for why this exists: dsh's
// internal packages all publish in lockstep at one shared version, but some
// of them declare a peer/dependency range on a sibling package that omits
// the -rc./-alpha. prerelease tag (e.g. "^0.1.1" instead of "^0.1.1-rc.2") —
// since every real published version in that line IS a prerelease, that
// bare range is unsatisfiable under strict semver and pnpm refuses to
// resolve it (ERR_PNPM_NO_MATCHING_VERSION). Overriding every
// @deepseek-ai/dsh* package to the exact target version sidesteps each
// consumer's (sometimes-wrong) declared range entirely.
//
// Only @deepseek-ai/dsh* entries are regenerated. Every other override
// (e.g. the @deepseek-ai/cordis pin) is kept as-is, together with the
// comment lines directly above it, and stays ahead of the generated block.
//
// Usage: node scripts/update-dsh-overrides.mjs <target-version>
// Then: pnpm install --lockfile-only (regenerates pnpm-lock.yaml), and
// pnpm approve-builds --all (re-approves native build scripts if the
// package set changed) before committing.
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
const execAsync = promisify(exec);

const TARGET = process.argv[2];
if (!TARGET) {
  console.error("Usage: node scripts/update-dsh-overrides.mjs <target-version>");
  process.exit(1);
}

const seenSpecs = new Set();
const dshNames = new Set();
const missingAtTarget = new Set();
let queue = [`@deepseek-ai/dsh@${TARGET}`];
const CAP = 3000;

async function viewOneField(spec, field) {
  try {
    const { stdout } = await execAsync(`npm view "${spec}" ${field} --json`, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20000,
    });
    const out = stdout.trim();
    if (!out || out === "undefined") return undefined;
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

async function viewFields(spec) {
  const [version, deps, peerDeps, optDeps] = await Promise.all([
    viewOneField(spec, "version"),
    viewOneField(spec, "dependencies"),
    viewOneField(spec, "peerDependencies"),
    viewOneField(spec, "optionalDependencies"),
  ]);
  return { spec, version, deps: { ...asObject(deps), ...asObject(peerDeps), ...asObject(optDeps) } };
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// dsh-* packages all publish in lockstep, so always fetch them at TARGET
// directly rather than trusting each consumer's declared range (some are
// the exact bare ranges this script exists to route around). Non-dsh
// packages (cordis, schemastery, etc.) have independent versioning — walk
// those via their own declared range instead.
function isDsh(name) {
  return name.startsWith("@deepseek-ai/dsh");
}

function specFor(name, range) {
  if (isDsh(name)) {
    dshNames.add(name);
    return `${name}@${TARGET}`;
  }
  const ver = String(range).replace(/^[\^~]/, "");
  return `${name}@${ver}`;
}

while (queue.length > 0 && seenSpecs.size < CAP) {
  const toCheck = queue.filter((s) => !seenSpecs.has(s));
  toCheck.forEach((s) => seenSpecs.add(s));
  if (toCheck.length === 0) break;
  process.stderr.write(`checking ${toCheck.length} (total: ${seenSpecs.size}, dsh names: ${dshNames.size})\n`);
  const results = await mapLimit(toCheck, 10, viewFields);
  const next = [];
  for (const { spec, version, deps } of results) {
    // A lockstep assumption that no longer holds must fail loudly rather
    // than write an override pnpm cannot satisfy.
    if (version === undefined && spec.endsWith(`@${TARGET}`) && isDsh(spec)) {
      missingAtTarget.add(spec);
    }
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith("@deepseek-ai/")) continue;
      const nspec = specFor(name, range);
      if (!seenSpecs.has(nspec)) next.push(nspec);
    }
  }
  queue = next;
}

if (missingAtTarget.size > 0) {
  console.error(`These packages have no published ${TARGET} (or the registry lookup failed); pnpm-workspace.yaml left unchanged:`);
  for (const spec of [...missingAtTarget].sort()) console.error(`  ${spec}`);
  process.exit(1);
}

const workspaceYamlPath = new URL("../pnpm-workspace.yaml", import.meta.url);
const existing = readFileSync(workspaceYamlPath, "utf8");
const lines = existing.split("\n");
const overridesStart = lines.findIndex((l) => l.trim() === "overrides:");
if (overridesStart === -1) {
  console.error("Could not find 'overrides:' key in pnpm-workspace.yaml — merge manually.");
  process.exit(1);
}
let overridesEnd = lines.length;
for (let i = overridesStart + 1; i < lines.length; i++) {
  if (lines[i].trim() !== "" && !lines[i].startsWith(" ")) {
    overridesEnd = i;
    break;
  }
}

// Keep every non-dsh override entry, plus the comment lines that sit
// directly above it.
const kept = [];
let pendingComments = [];
for (const line of lines.slice(overridesStart + 1, overridesEnd)) {
  const trimmed = line.trim();
  if (trimmed === "") continue;
  if (trimmed.startsWith("#")) {
    pendingComments.push(line);
    continue;
  }
  const key = trimmed.replace(/^['"]/, "").split(/['"]?\s*:/)[0];
  if (!isDsh(key)) kept.push(...pendingComments, line);
  pendingComments = [];
}

const newOverrideLines = [
  "overrides:",
  ...kept,
  ...[...dshNames].sort().map((n) => `  '${n}': '${TARGET}'`),
];
const updated = [...lines.slice(0, overridesStart), ...newOverrideLines, ...lines.slice(overridesEnd)].join("\n");
writeFileSync(workspaceYamlPath, updated);

process.stderr.write(`\nWrote ${dshNames.size} @deepseek-ai/dsh* overrides for target ${TARGET} into pnpm-workspace.yaml (kept ${kept.filter((l) => !l.trim().startsWith("#")).length} other overrides)\n`);
process.stderr.write(`Next: pnpm install --lockfile-only && pnpm approve-builds --all\n`);
