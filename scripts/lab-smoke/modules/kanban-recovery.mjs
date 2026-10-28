// kanban-recovery: dsh-kanban's engine-owned recovery of a halted role turn,
// driven through the kick service dsh-continue-kicker provides (KAN-4).
//
// Scenario A (recovery): a lab-only model route with a 48-token output budget is
// put under the kanban implementer, so its turn halts `max-tokens` on every
// attempt. The engine must kick the session itself (continue-kicker's policy,
// maxConsecutiveKicks in this deployment = 3), the ticket must stay In flight
// while kicks are being granted, and it must park in Needs attention with the
// original failure only once the runaway guard declines. The session log must
// carry exactly maxConsecutiveKicks kick messages: the engine's kick always
// beats the watcher's delayed re-analysis, so nothing is kicked twice.
//
// Scenario B (degraded): with the continue-kicker bundle removed the same ticket
// parks straight away, with no auto_recovered events and no kicks at all.
//
// Both scenarios restart the lab and rewrite the lab's own cordis.patch.yml /
// profile bundles; everything is restored before the module returns.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { labSh, openLab, readSessionEvents, sleep } from '../lib.mjs'

export const meta = { needs: ['dsh-kanban'], model: true, timeout: 900_000 }

const PROVIDER_ID = 'kanban-recovery-lab'
const KICK_SOURCE = 'plugin:continue-kicker'
const PROFILE = '.dsh/profiles/web/cordis.patch.yml'
const BUNDLES = '.dsh/profiles/web/package.json'

const TASK = {
  title: 'KAN-4 recovery probe: write hello.txt',
  body: 'Create a file named hello.txt in the workspace containing exactly the word hello. Nothing else.',
  acceptance: ['hello.txt exists in the workspace and contains the word hello'],
}

// --------------------------------------------------------------------- config --

function profilePath(env) {
  return join(env.labDir, PROFILE)
}

/** Insert the tiny-output provider and route the implementer at it. Idempotent. */
function patchProfile(env) {
  const path = profilePath(env)
  let text = readFileSync(path, 'utf8')
  if (!text.includes(`${PROVIDER_ID}:`)) {
    const anchor = text.match(/^(- id: llm-pi-ai\n(?:.*\n)*?    providers:\n)/m)
    if (!anchor) throw new Error(`no 'providers:' block under the llm-pi-ai row in ${path}`)
    const insert = [
      `      ${PROVIDER_ID}:`,
      `        displayName: KAN-4 lab route (real backend, 48-token output budget)`,
      `        apiKeyEnv: LOCAL_AI_MACHINE_API_KEY`,
      `        api: openai-completions`,
      `        baseURL: http://127.0.0.1:4000/v1`,
      `        models:`,
      `          - id: medium-dense`,
      `            contextWindow: 262144`,
      // maxTokens is the output budget sent with every request: 48 makes any
      // real generation halt `max-tokens` within a second or two.
      `            maxTokens: 48`,
      `            reasoningEfforts: false`,
      ``,
    ].join('\n')
    text = text.replace(anchor[1], `${anchor[1]}${insert}`)
  }
  if (!text.includes(`provider: ${PROVIDER_ID}`)) {
    // Point the kanban implementer at it, and declare the provider local so the
    // admission gate treats it like the other lab routes.
    const kanban = text.match(/^(- id: kanban\n)((?:.*\n)*?)(?=^- id: |(?![\s\S]))/m)
    if (!kanban) throw new Error(`no '- id: kanban' row in ${path}`)
    let block = kanban[2]
    if (!/^      implementer:\n        provider: .*$/m.test(block)) {
      throw new Error('the kanban row has no roles.implementer provider to rewrite')
    }
    block = block.replace(/^(      implementer:\n        provider: )(.*)$/m, `$1${PROVIDER_ID}`)
    if (!block.includes(`- name: ${PROVIDER_ID}`)) {
      block = block.replace(/^    providers:\n/m, `    providers:\n      - name: ${PROVIDER_ID}\n        tier: local\n`)
    }
    text = text.replace(kanban[0], `${kanban[1]}${block}`)
  }
  writeFileSync(path, text)
}

function setKickerMounted(env, mounted) {
  const path = join(env.labDir, BUNDLES)
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const bundles = json.dsh.profile.bundles
  const has = bundles.includes('dsh-continue-kicker')
  if (mounted && !has) throw new Error('dsh-continue-kicker is not in the lab profile bundles; nothing to restore')
  if (mounted === has) return mounted
  json.dsh.profile.bundles = mounted ? bundles : bundles.filter((b) => b !== 'dsh-continue-kicker')
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
  return mounted
}

function restoreConfig(env, saved) {
  writeFileSync(profilePath(env), saved.profile)
  writeFileSync(join(env.labDir, BUNDLES), saved.bundles)
}

// ----------------------------------------------------------------------- api --

/** POST one /api/kanban endpoint from inside the authenticated page. */
function makeRpc(page) {
  return async (endpoint, body = {}) => {
    const out = await page.evaluate(
      async ([e, b]) => {
        const res = await fetch(`/api/kanban/${e}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(b),
        })
        return { status: res.status, json: await res.json().catch(() => null) }
      },
      [endpoint, body]
    )
    if (out.status !== 200 || out.json === null) throw new Error(`${endpoint} -> HTTP ${out.status}`)
    if (out.json.ok !== true) throw new Error(`${endpoint} -> ${JSON.stringify(out.json.error ?? out.json).slice(0, 300)}`)
    return out.json.value
  }
}

/** The kanban session rows of a ticket, newest first. */
function sessionsOf(rpc, ticketId) {
  return rpc('ticket', { id: ticketId }).then((detail) => detail.sessions ?? [])
}

/** Read a dsh session's own event log out of the lab's DSH_HOME. */
function sessionEvents(env, sessionId) {
  const root = join(env.dshHome, 'sessions')
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws, sessionId)
    for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
      const file = join(dir, name)
      if (existsSync(file)) return readSessionEvents(file)
    }
  }
  return []
}

const kickMessages = (events) => events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === KICK_SOURCE)
const turnEnds = (events) => events.filter((e) => e.type === 'turn/end')

// ---------------------------------------------------------------------- flow --

/**
 * Create a ticket and watch it until it parks. Returns the ticket, its sessions,
 * its timeline events and the per-second column samples taken while it ran.
 */
async function driveTicket(env, rpc, workspaceCwd) {
  const created = await rpc('create', {
    title: TASK.title,
    body: TASK.body,
    acceptance: TASK.acceptance,
    workspaceCwd,
    planTiming: 'now',
    planQuestions: 'autonomous',
    column: 'now',
  })
  const ticketId = created.ticket.id
  const samples = []
  const deadline = Date.now() + 600_000
  let detail = null
  for (;;) {
    detail = await rpc('ticket', { id: ticketId })
    const events = await rpc('events', { id: ticketId, limit: 500 })
    samples.push({ at: new Date().toISOString(), column: detail.ticket.column, phase: detail.ticket.phase, autoRecovered: events.filter((e) => e.kind === 'auto_recovered').length })
    if (detail.ticket.column === 'needs_attention' || detail.ticket.column === 'done') break
    if (Date.now() > deadline) throw new Error(`ticket ${detail.ticket.key} never parked (last: ${detail.ticket.column}/${detail.ticket.phase})`)
    await sleep(1000)
  }  const events = await rpc('events', { id: ticketId, limit: 500 })
  return { ticketId, key: detail.ticket.key, ticket: detail.ticket, sessions: detail.sessions ?? [], events, samples }
}

function autoRecovered(events) {
  return events.filter((e) => e.kind === 'auto_recovered')
}

export async function run(ctx) {
  const { env } = ctx
  ctx.needModel()

  const bundlesPath = join(env.labDir, BUNDLES)
  const saved = { profile: readFileSync(profilePath(env), 'utf8'), bundles: readFileSync(bundlesPath, 'utf8') }
  const workspaceCwd = join(env.meta, 'home', 'lab-kanban-recovery')
  mkdirSync(workspaceCwd, { recursive: true })

  try {
    // ---- scenario A: the engine recovers a halted turn inside the workflow ----
    await ctx.check('lab route with a 48-token output budget is mounted under the implementer', async () => {
      patchProfile(env)
      const r = await labSh(env, ['restart'])
      if (r.code !== 0) throw new Error(`lab.sh restart exited ${r.code}: ${(r.stderr || r.stdout).split('\n').slice(-4).join(' / ')}`)
      const log = readFileSync(join(env.meta, 'lab.log'), 'utf8')
      if (!/kick service v1 provided/.test(log)) {
        throw new Error('continue-kicker did not report its kick service at boot; is dsh-continue-kicker linked to 0.3.0?')
      }
      return 'continue-kicker 0.3.0 mounted with its kick service; lab restarted on the 48-token route'
    })

    let runA = null
    {
      const s = await openLab(env)
      ctx.attach(s)
      try {
        await s.goto()
        const rpc = makeRpc(s.page)
        await ctx.check('capabilities reports the kick service', async () => {
          const caps = await rpc('capabilities')
          if (caps.continueKicker !== true) throw new Error(`capabilities: ${JSON.stringify(caps)}`)
          return `continueKicker=${caps.continueKicker} worktree=${caps.worktree}`
        })
        await ctx.check('a halted implement turn is kicked by the engine and the ticket stays In flight', async () => {
          runA = await driveTicket(env, rpc, workspaceCwd)
          const kicks = autoRecovered(runA.events)
          if (kicks.length === 0) throw new Error(`no auto_recovered events; parked as: ${runA.ticket.needsAttentionReason}`)
          // The poll ran every second through the whole recovery: the ticket may
          // only leave In flight on the sample that parks it, and by then every
          // kick must already be on the timeline.
          const inflight = runA.samples.filter((sample) => sample.column === 'now').length
          if (inflight < 2) throw new Error(`only ${inflight} In-flight samples; the ticket parked before recovery ran`)
          const park = runA.samples[runA.samples.length - 1]
          if (park.autoRecovered !== kicks.length) {
            throw new Error(`parked after ${park.autoRecovered} of ${kicks.length} kicks: ${JSON.stringify(runA.samples.slice(-3))}`)
          }
          return `${kicks.length} auto_recovered events (${kicks.map((k) => k.payload.flavor).join(', ')}) over ${inflight} In-flight samples, parked as '${runA.ticket.needsAttentionReason}'`
        })
        await ctx.check('the session carries exactly maxConsecutiveKicks kicks and no duplicates', async () => {
          const build = runA.sessions.filter((row) => row.purpose === 'build')
          if (build.length === 0) throw new Error(`no build session recorded for ${runA.key}`)
          const sessionId = build[build.length - 1].dshSessionId ?? build[build.length - 1].sessionId
          const events = sessionEvents(env, sessionId)
          const kicks = kickMessages(events)
          const ends = turnEnds(events)
          const expected = autoRecovered(runA.events).length
          if (kicks.length !== expected) throw new Error(`${kicks.length} kick messages in the session log, ${expected} auto_recovered events`)
          if (kicks.length > 3) throw new Error(`${kicks.length} kicks, more than maxConsecutiveKicks=3: the watcher double-kicked`)
          const halts = ends.filter((e) => ['max-tokens', 'error', 'interrupted'].includes(e.data?.reason?.kind)).length
          return `${kicks.length} kicks, ${ends.length} turn ends (${halts} halts) in session ${sessionId}`
        })
        await ctx.check('the ticket parks with the original halt once the guard declines', async () => {
          if (runA.ticket.column !== 'needs_attention') throw new Error(`ticket is in ${runA.ticket.column}`)
          const reason = runA.ticket.needsAttentionReason ?? ''
          if (!reason.startsWith('turn failed in implement:')) throw new Error(`unexpected park reason: ${reason}`)
          if (!/max-tokens/.test(reason)) throw new Error(`expected a max-tokens halt, got: ${reason}`)
          return `parked: ${reason}`
        })
      } finally {
        await s.close()
      }
    }

    // ---- scenario B: continue-kicker absent, the halt parks straight away ----
    await ctx.check('degraded: with continue-kicker unmounted the ticket parks directly', async () => {
      setKickerMounted(env, false)
      const r = await labSh(env, ['restart'])
      if (r.code !== 0) throw new Error(`lab.sh restart exited ${r.code}: ${(r.stderr || r.stdout).split('\n').slice(-4).join(' / ')}`)
      const log = readFileSync(join(env.meta, 'lab.log'), 'utf8')
      if (/kick service v1 provided/.test(log)) throw new Error('continue-kicker is still mounted; the bundle removal did not take effect')
      return 'lab restarted with the continue-kicker bundle removed'
    })

    {
      const s = await openLab(env)
      ctx.attach(s)
      try {
        await s.goto()
        const rpc = makeRpc(s.page)
        await ctx.check('degraded: capabilities says the service is absent', async () => {
          const caps = await rpc('capabilities')
          if (caps.continueKicker !== false) throw new Error(`capabilities: ${JSON.stringify(caps)}`)
          return 'continueKicker=false'
        })
        await ctx.check('degraded: one halt, no kicks, straight to Needs attention', async () => {
          const runB = await driveTicket(env, rpc, workspaceCwd)
          const kicks = autoRecovered(runB.events)
          if (kicks.length !== 0) throw new Error(`${kicks.length} auto_recovered events without the service`)
          if (runB.ticket.column !== 'needs_attention') throw new Error(`ticket is in ${runB.ticket.column}`)
          if (!/^turn failed in implement:/.test(runB.ticket.needsAttentionReason ?? '')) {
            throw new Error(`unexpected park reason: ${runB.ticket.needsAttentionReason}`)
          }
          const build = runB.sessions.filter((row) => row.purpose === 'build')
          if (build.length > 0) {
            const sessionId = build[build.length - 1].dshSessionId ?? build[build.length - 1].sessionId
            const n = kickMessages(sessionEvents(env, sessionId)).length
            if (n !== 0) throw new Error(`${n} kick messages in the session log with continue-kicker unmounted`)
          }
          return `parked: ${runB.ticket.needsAttentionReason}, zero auto_recovered events`
        })
      } finally {
        await s.close()
      }
    }
  } finally {
    restoreConfig(env, saved)
    await labSh(env, ['restart'])
  }
}
