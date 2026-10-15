#!/usr/bin/env node
// Fails when a dependency manifest carries a local-path pin.
//
// A `link:` / `file:` / `portal:` spec points at a checkout on one machine. It
// is the right tool for trying a plugin change in a lab (`scripts/lab.sh
// link`), and a build-breaker if it is ever committed: the lockfile then names
// a directory that exists nowhere else, and a clean install of `main` fails.
//
// Usage: node scripts/check-no-links.mjs [repo-root]
// Exit 0 = clean, 1 = offending pin found, 2 = usage / unreadable repo.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname)
if (!existsSync(join(root, 'package.json'))) {
  console.error(`check-no-links: ${root} has no package.json`)
  process.exit(2)
}

// Every manifest that can pin a dependency: the root install, each profile's
// own package.json, the workspace file (overrides live there) and the lockfile.
const files = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
const profilesDir = join(root, '.dsh', 'profiles')
if (existsSync(profilesDir)) {
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    const manifest = join('.dsh', 'profiles', entry.name, 'package.json')
    if (entry.isDirectory() && existsSync(join(root, manifest))) files.push(manifest)
  }
}

// A spec is a value: it follows a quote, a colon+space (YAML) or an opening
// parenthesis. Anchoring on that avoids flagging prose such as
// "excludeLinksFromLockfile".
const SPEC = /(?:["'(]|:\s+)(link|file|portal):[^\s"',)]*/
// An absolute path into a machine-local tree. The `/packages/...` paths pnpm
// records for git subdirectories do not start with one of these roots.
const ABS_PATH = /(?:["'\s:=(]|^)(\/(?:home|Users|root|tmp|private|mnt|opt|srv|var)\/[^\s"',)]*)/

const problems = []
for (const rel of files) {
  const path = join(root, rel)
  if (!existsSync(path)) continue
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const spec = SPEC.exec(line)
      if (spec) problems.push(`${rel}:${index + 1}: ${spec[1]}: pin  ${line.trim().slice(0, 160)}`)
      const abs = ABS_PATH.exec(line)
      if (abs) problems.push(`${rel}:${index + 1}: absolute local path ${abs[1]}`)
    })
}

if (problems.length > 0) {
  console.error('check-no-links: local-path pins must never be committed:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    '\nRestore the released tag spec (scripts/lab.sh unlink <pkg>, or copy it from `git show HEAD:package.json`) and reinstall.'
  )
  process.exit(1)
}
console.log(`check-no-links: ok (${files.length} files checked)`)
