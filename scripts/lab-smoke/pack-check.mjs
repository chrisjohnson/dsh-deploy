#!/usr/bin/env node
// A linked checkout is loaded straight from the working tree, so it never goes
// through the package's `files` allowlist. A file the plugin needs but the
// published tarball would leave out therefore works in the lab and breaks the
// first real install. This check packs the checkout (dry run) and verifies
// that everything package.json points at, and every relative import between
// shipped modules, is actually in the tarball.
//
// Usage: node pack-check.mjs <package-dir>   (exit 1 on a missing file)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '.')
const manifestPath = join(dir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`no package.json in ${dir}`)
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

let packed
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--silent'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  packed = new Set(JSON.parse(out)[0].files.map((f) => normalize(f.path)))
} catch (error) {
  console.error(`npm pack --dry-run failed: ${String(error.stderr ?? error.message).split('\n')[0]}`)
  process.exit(2)
}

const referenced = new Set()
const addRef = (value) => {
  if (typeof value === 'string' && value.startsWith('.') && !value.includes('*')) referenced.add(normalize(value))
}
const walk = (value) => {
  if (typeof value === 'string') addRef(value)
  else if (value && typeof value === 'object') Object.values(value).forEach(walk)
}
addRef(manifest.main)
walk(manifest.exports)
addRef(manifest.dsh?.bundle?.patch)
walk(manifest.bin)

const missing = []
for (const ref of referenced) {
  if (ref === 'package.json') continue
  if (!packed.has(ref)) missing.push(`${ref} (named in package.json)`)
}

// Relative imports between shipped modules.
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g
for (const file of packed) {
  if (!/\.(m?js|cjs)$/.test(file)) continue
  const text = readFileSync(join(dir, file), 'utf8')
  for (const match of text.matchAll(IMPORT)) {
    const target = normalize(join(dirname(file), match[1]))
    if (!packed.has(target)) missing.push(`${target} (imported by ${file})`)
  }
}

if (missing.length > 0) {
  console.error(`MISSING from the published tarball of ${manifest.name}:`)
  for (const m of missing) console.error(`  ${m}`)
  console.error('Add them to package.json "files"; the lab loads the working tree and will not notice.')
  process.exit(1)
}
console.log(`${manifest.name}: ${packed.size} files in the tarball, every referenced file and relative import is included`)
