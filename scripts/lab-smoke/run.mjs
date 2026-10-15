#!/usr/bin/env node
// Smoke runner for the lab. Run through `scripts/lab.sh smoke`; it sets LAB_DIR,
// LAB_PORT, LAB_SH, ... Each module under ./modules/ covers one area, so a
// plugin author can run only theirs:
//
//   scripts/lab.sh smoke --only model-switch,sessions
//   scripts/lab.sh smoke --skip-model        (no check that needs a real model turn)
//
// Results are rewritten after EVERY check: <lab>/.lab/smoke/RESULTS.md and
// results.json. The exit code is non-zero only when a check FAILed; SKIP means
// "could not be automated or not applicable here" and is never a pass.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { labEnv, redact, sleep, Skip } from './lib.mjs'

const ORDER = [
  'boot',
  'ui',
  'sessions',
  'completion',
  'web-search',
  'image-search',
  'webp',
  'scheduled-queue',
  'loop-watchdog',
  'worktree',
  'continue-kicker',
  // Last: a successful switch becomes the lab's default model for new sessions.
  'model-switch'
]

function parseArgs(argv) {
  const out = { only: null, skip: [], skipModel: false, sessions: 4, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') out.only = argv[++i].split(',').filter(Boolean)
    else if (a === '--skip') out.skip = argv[++i].split(',').filter(Boolean)
    else if (a === '--skip-model') out.skipModel = true
    else if (a === '--sessions') out.sessions = Number(argv[++i])
    else if (a === '--verbose') out.verbose = true
    else throw new Error(`unknown smoke option ${a}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const env = labEnv()
const outDir = join(env.meta, 'smoke')
mkdirSync(join(outDir, 'shots'), { recursive: true })

const bundles = JSON.parse(readFileSync(join(env.dshHome, 'profiles/web/package.json'), 'utf8')).dsh.profile.bundles
const results = []
const startedAt = new Date().toISOString()

function flush() {
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 }
  for (const r of results) counts[r.status]++
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ startedAt, lab: env.name, port: env.port, counts, results }, null, 2) + '\n')
  const lines = [
    `# Lab smoke results`,
    ``,
    `lab \`${env.name}\` on :${env.port}, started ${startedAt}`,
    ``,
    `**${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.SKIP} SKIP**`,
    ``,
    `| module | check | status | seconds | detail |`,
    `| --- | --- | --- | --- | --- |`
  ]
  for (const r of results) {
    lines.push(`| ${r.module} | ${r.name} | ${r.status} | ${(r.ms / 1000).toFixed(1)} | ${String(r.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)
  }
  writeFileSync(join(outDir, 'RESULTS.md'), lines.join('\n') + '\n')
}

function record(module, name, status, ms, detail) {
  const entry = { module, name, status, ms, detail: redact(detail ?? '') }
  results.push(entry)
  console.log(`${status.padEnd(4)} ${module} / ${name}${detail ? ` - ${String(entry.detail).split('\n')[0].slice(0, 200)}` : ''}`)
  flush()
}

function makeCtx(moduleName, meta) {
  let attached = null
  return {
    /** Register the browser session of the module so a failing check leaves a screenshot. */
    attach(session) {
      attached = session
    },
    env,
    args,
    bundles,
    state: sharedState,
    /** Run one check with its own timeout; a thrown Skip is a SKIP, any other error a FAIL. */
    async check(name, fn, { timeout = meta.timeout ?? 120_000 } = {}) {
      const t0 = Date.now()
      let timer
      try {
        const detail = await Promise.race([
          fn(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`check timed out after ${Math.round(timeout / 1000)}s`)), timeout)
          })
        ])
        record(moduleName, name, 'PASS', Date.now() - t0, typeof detail === 'string' ? detail : '')
        return true
      } catch (error) {
        if (error instanceof Skip) record(moduleName, name, 'SKIP', Date.now() - t0, error.message)
        else {
          const shot = attached ? await attached.shot(`FAIL-${moduleName}-${name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}`).catch(() => '') : ''
          record(moduleName, name, 'FAIL', Date.now() - t0, `${error instanceof Error ? error.message : String(error)}${shot ? ` [screenshot: ${shot}]` : ''}`)
        }
        return false
      } finally {
        clearTimeout(timer)
      }
    },
    /** Call first inside a check that sends a real model turn: SKIP under --skip-model. */
    needModel() {
      if (args.skipModel) throw new Skip('--skip-model: needs a real model turn')
      const bench = benchmarkRunning()
      if (bench) throw new Skip(`a benchmark is running (${bench.slice(0, 70)}); not sending model requests`)
    },
    skip(name, reason) {
      record(moduleName, name, 'SKIP', 0, reason)
    }
  }
}

/**
 * A speed benchmark in flight is measuring the same local models the model checks
 * would hit. lab.sh smoke refuses to start then; this re-checks before each model
 * turn so a benchmark that starts mid-run is not disturbed. LAB_FORCE=1 skips it.
 */
function benchmarkRunning() {
  if (process.env.LAB_FORCE === '1') return null
  const pattern = process.env.LAB_BENCH_PATTERN ?? 'llm_decode_bench|llm-inference-bench'
  try {
    const out = execFileSync('pgrep', ['-f', '-a', pattern], { encoding: 'utf8' })
    return out.split('\n').find((line) => line && !/pgrep/.test(line)) ?? null
  } catch {
    return null
  }
}

const sharedState = {}
const wanted = ORDER.filter((m) => (args.only ? args.only.includes(m) : true) && !args.skip.includes(m))
for (const name of args.only ?? []) if (!ORDER.includes(name)) throw new Error(`unknown module '${name}'; known: ${ORDER.join(', ')}`)

console.log(`lab smoke: ${wanted.join(', ')} (lab '${env.name}' :${env.port})`)
for (const name of wanted) {
  const mod = await import(pathToFileURL(join(import.meta.dirname, 'modules', `${name}.mjs`)).href)
  const meta = mod.meta ?? {}
  const ctx = makeCtx(name, meta)
  const missing = (meta.needs ?? []).filter((pkg) => !bundles.includes(pkg))
  if (missing.length > 0) {
    ctx.skip('(module)', `plugin not mounted in this lab: ${missing.join(', ')}`)
    continue
  }
  if (meta.model && args.skipModel) {
    ctx.skip('(module)', '--skip-model: needs a real model turn')
    continue
  }
  if (meta.model && benchmarkRunning()) {
    ctx.skip('(module)', `a benchmark is running (${benchmarkRunning().slice(0, 70)}); not sending model requests`)
    continue
  }
  try {
    await mod.run(ctx)
  } catch (error) {
    record(name, '(module crashed)', 'FAIL', 0, error instanceof Error ? (error.stack ?? error.message).split('\n').slice(0, 3).join(' / ') : String(error))
  }
  await sleep(500)
}

const failed = results.filter((r) => r.status === 'FAIL').length
console.log(`\n${results.filter((r) => r.status === 'PASS').length} PASS, ${failed} FAIL, ${results.filter((r) => r.status === 'SKIP').length} SKIP`)
console.log(`results: ${join(outDir, 'RESULTS.md')}`)
process.exit(failed > 0 ? 1 : 0)
