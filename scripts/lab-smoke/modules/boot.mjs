// boot: the lab is the process it claims to be, it is isolated from production,
// the boot log is clean and the profile composed with every bundle.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Skip, accessUrl, redact } from '../lib.mjs'

export const meta = { timeout: 60_000 }

// Real failure shapes only: the bare word "error" appears in healthy plugin startup lines (kickOnError=...).
const SUSPICIOUS = /skipping profile bundle|admission|did not activate|failed to import|incompatib|unsupported\/|no-getter|\berror:| error |fatal|exception|unhandled|rejection|cannot find|ERR_|^\s+at /i

const readEnviron = (pid) =>
  Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])
  )

function linkedPackages(env) {
  const root = JSON.parse(readFileSync(join(env.labDir, 'package.json'), 'utf8'))
  return Object.entries(root.dependencies).filter(([, spec]) => /^link:/.test(spec))
}

export async function run(ctx) {
  const { env } = ctx

  await ctx.check('lab process is isolated from production', async () => {
    const pid = readFileSync(join(env.meta, 'pid'), 'utf8').trim()
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (!cmdline.join(' ').includes(join(env.labDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) throw new Error('pid does not run the lab checkout')
    if (!cmdline.includes('--expose-internals')) throw new Error('the lab is not running with --expose-internals like the unit')
    const port = cmdline[cmdline.indexOf('--port') + 1]
    if (port !== String(env.port) || port === '3081') throw new Error(`lab listens on --port ${port}`)
    const proc = readEnviron(pid)
    if (!proc.DSH_HOME?.startsWith(env.labDir + '/')) throw new Error('DSH_HOME is outside the lab directory')
    if (!proc.HOME?.startsWith(env.labDir + '/')) throw new Error('HOME is outside the lab directory')
    for (const key of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GH_REAL_BIN']) {
      if (key in proc) throw new Error(`${key} leaked into the lab environment`)
    }
    return `pid ${pid}, port ${port}, DSH_HOME and HOME inside the lab`
  })

  await ctx.check('server answers over HTTP', async () => {
    // The access URL answers 303 + a session cookie; the page itself needs that cookie.
    const first = await fetch(accessUrl(env), { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    if (first.status !== 303) throw new Error(`access URL answered HTTP ${first.status}, expected the 303 hand-off`)
    const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    const target = new URL(first.headers.get('location') ?? '/', accessUrl(env)).href
    const response = await fetch(target, { headers: { cookie }, signal: AbortSignal.timeout(15_000) })
    const html = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status} after the cookie hand-off`)
    if (!/DeepSeek|<div id="root"/i.test(html)) throw new Error('the page does not look like the DSH web app')
    return `HTTP ${response.status}, ${html.length} bytes`
  })

  await ctx.check('boot log has no skip/admission/error/stack lines', async () => {
    const lines = readFileSync(join(env.meta, 'lab.log'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !/^dsh web: http/.test(l))
    const bad = lines.filter((l) => SUSPICIOUS.test(l))
    if (bad.length > 0) throw new Error(`${bad.length} suspicious line(s): ${redact(bad.slice(0, 3).join(' // '))}`)
    return lines.length === 0 ? 'log is empty apart from the access line' : `${lines.length} other line(s), none suspicious`
  })

  await ctx.check('no plugin was rejected at admission', async () => {
    const path = join(env.dshHome, 'profiles/web/compatibility.json')
    if (existsSync(path)) throw new Error(`${path} exists: ${readFileSync(path, 'utf8').slice(0, 300)}`)
    return 'no compatibility.json written'
  })

  await ctx.check('--dump-config composed a layer for every bundle', async () => {
    const dump = join(env.meta, 'dump-config.txt')
    if (!existsSync(dump)) throw new Error('lab.sh has not written dump-config.txt; restart the lab with lab.sh restart')
    const text = readFileSync(dump, 'utf8')
    const missing = ctx.bundles.filter((b) => !text.includes(`# == ${b}`))
    if (missing.length > 0) throw new Error(`no layer for: ${missing.join(', ')}`)
    return `${ctx.bundles.length} bundles, ${(text.match(/^# == /gm) ?? []).length} layer annotations`
  })

  const linked = linkedPackages(env)
  await ctx.check('linked packages resolve to their checkout and pack cleanly', async () => {
    if (linked.length === 0) throw new Skip('nothing is linked in this lab')
    const notes = []
    for (const [pkg, spec] of linked) {
      const target = spec.replace(/^link:/, '')
      const nm = join(env.labDir, 'node_modules', pkg)
      if (!lstatSync(nm).isSymbolicLink()) throw new Error(`node_modules/${pkg} is not a symlink`)
      if (realpathSync(nm) !== realpathSync(target)) throw new Error(`node_modules/${pkg} -> ${readlinkSync(nm)}, expected ${target}`)
      try {
        execFileSync('node', [join(import.meta.dirname, '..', 'pack-check.mjs'), target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        throw new Error(`${pkg}: ${String(error.stderr || error.message).trim().split('\n').slice(0, 4).join(' / ')}`)
      }
      notes.push(`${pkg} -> ${target}`)
    }
    return notes.join('; ')
  })
}
