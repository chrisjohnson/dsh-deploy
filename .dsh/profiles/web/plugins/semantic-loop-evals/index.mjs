// semantic-loop-evals: the READER half of the semantic-loop-kicker signal.
//
// The watchdog (../semantic-loop-kicker.mjs) is the producer: every evaluation
// it performs appends one JSON line to
//
//   $DSH_HOME/storages/semantic-loop-kicker/evaluations.jsonl
//
// carrying BOTH layers of the signal - the deterministic fingerprint (code)
// result and, when the code layer was inconclusive, the model's verdict. This
// plugin is purely a consumer of that file: it never writes to the ledger and
// never influences the watchdog's decisions. That separation is deliberate -
// the ledger is the interface, and this is just one reader of it.
//
// It exposes the ledger to the browser over the authenticated /api fence (the
// same connection.fetch.register + connection.rpc.call idiom the other local
// plugins in this profile use; see ../scheduled-queue/). The Client half
// (client.mjs) renders it as a right-sidebar tab via dsh-better-sidebar's
// ctx.betterSidebar.registerTab.
//
// TWO RECORD SCHEMAS are handled here, because the migration is not
// retroactive:
//   v2 (current): explicit `code` and `model` phase objects, plus skip
//                 records for steps that were deliberately not evaluated.
//   v1 (older):   decisions only, flattened - `source` says which layer
//                 decided and `fingerprints` holds the code layer's hits.
//                 v1 is NORMALIZED into the v2 shape (marked `synthesized`)
//                 so the client never needs to know which era a row is from.
//                 Note v1 has no record at all for non-decisions: a v1
//                 timeline is legitimately sparser than a v2 one.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_NAME = 'dsh-semantic-loop-evals'
const CHANNEL = '/semanticLoopEvals'
const API_BASE = '/api/semanticLoopEvals'
const ENDPOINTS = ['list', 'sessions', 'detail']

const HOME = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
const LEDGER_DIR = join(HOME, 'storages', 'semantic-loop-kicker')
const LEDGER_FILE = join(LEDGER_DIR, 'evaluations.jsonl')

const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 20000

// ================================================================
// LEDGER READ + NORMALIZE
// ================================================================

/**
 * Canonicalize one ledger line into the shape the client consumes, whatever
 * schema era it came from. `id` is the LINE INDEX, which is stable because the
 * ledger is append-only - the client uses it to request the full record
 * (including the transcript window) only for the row it is inspecting.
 */
function normalize(raw, id) {
  const v = Number(raw.v) || 1
  const skip = typeof raw.skip === 'string' && raw.skip ? raw.skip : null
  const source = typeof raw.source === 'string' ? raw.source : null

  let code = raw.code && typeof raw.code === 'object' ? raw.code : null
  let model = raw.model && typeof raw.model === 'object' ? raw.model : null

  if (v < 2) {
    // v1 recorded decisions only. Reconstruct both phases from what is there:
    //   - the code layer ALWAYS ran (it is evaluated before the model), so a
    //     v1 llm decision means "code layer ran and found nothing stuck".
    //   - `source: 'fingerprint'` means the code layer is what decided.
    const fps = Array.isArray(raw.fingerprints) ? raw.fingerprints : []
    const codeDecided = source === 'fingerprint' || source === 'fast-path'
    code = {
      ran: true,
      calls: null,
      groupCount: fps.length,
      stuckGroups: fps,
      stuck: codeDecided,
      topGroups: fps,
      synthesized: true,
    }
    model =
      source === 'llm'
        ? {
            verdict: raw.verdict ?? null,
            confidence: raw.confidence ?? null,
            latencyMs: typeof raw.latencyMs === 'number' ? raw.latencyMs : 0,
            raw: '',
            hasReasoning: null,
            inferred: false,
            synthesized: true,
          }
        : null
  }

  // Which layer produced the outcome: code decided, model decided, or the
  // step was never evaluated (a skip). This is the axis the panel splits on.
  const layer = skip !== null ? 'none' : source === 'llm' ? 'model' : source ? 'code' : 'none'

  return {
    id,
    v,
    ts: raw.ts ?? null,
    sessionId: raw.sessionId ?? null,
    skip,
    source,
    layer,
    verdict: raw.verdict ?? null,
    confidence: raw.confidence ?? null,
    band: raw.band ?? null,
    streak: typeof raw.streak === 'number' ? raw.streak : 0,
    mode: raw.mode ?? null,
    outcome: raw.outcome ?? null,
    latencyMs: typeof raw.latencyMs === 'number' ? raw.latencyMs : 0,
    events: raw.events ?? null,
    code,
    model,
    fingerprints: Array.isArray(raw.fingerprints) ? raw.fingerprints : [],
    window: typeof raw.window === 'string' ? raw.window : '',
  }
}

function summarizeSessions(records) {
  const byId = new Map()
  for (const r of records) {
    let s = byId.get(r.sessionId)
    if (!s) {
      s = { sessionId: r.sessionId, count: 0, code: 0, model: 0, skipped: 0, stuck: 0, firstTs: r.ts, lastTs: r.ts }
      byId.set(r.sessionId, s)
    }
    s.count++
    if (r.layer === 'code') s.code++
    else if (r.layer === 'model') s.model++
    else s.skipped++
    if (r.band === 'stuck') s.stuck++
    if (r.ts && (!s.firstTs || r.ts < s.firstTs)) s.firstTs = r.ts
    if (r.ts && (!s.lastTs || r.ts > s.lastTs)) s.lastTs = r.ts
  }
  return [...byId.values()].sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)))
}

/**
 * Parse the whole ledger, memoized on (mtime, size). The file only ever grows,
 * so re-reading is cheap and correctness never depends on a stale cache: any
 * write changes at least one of the two keys.
 */
let cache = { mtimeMs: 0, size: -1, records: [], byId: new Map(), sessions: [], error: null }

function loadLedger() {
  let st
  try {
    st = statSync(LEDGER_FILE)
  } catch {
    // No ledger yet (the watchdog has not run since this file was introduced).
    // An empty result is correct, not an error - the panel renders its empty
    // state and the reason.
    cache = { mtimeMs: 0, size: -1, records: [], byId: new Map(), sessions: [], error: 'ledger-missing' }
    return cache
  }
  if (st.mtimeMs === cache.mtimeMs && st.size === cache.size && cache.error === null) return cache

  const records = []
  const byId = new Map()
  let corrupt = 0
  const lines = readFileSync(LEDGER_FILE, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    let raw
    try {
      raw = JSON.parse(line)
    } catch {
      corrupt++
      continue
    }
    if (!raw || typeof raw !== 'object') {
      corrupt++
      continue
    }
    const rec = normalize(raw, i)
    records.push(rec)
    byId.set(rec.id, rec)
  }
  cache = { mtimeMs: st.mtimeMs, size: st.size, records, byId, sessions: summarizeSessions(records), error: null, corrupt }
  return cache
}

// ================================================================
// PROJECTIONS
// ================================================================

/**
 * List projection: everything the graph and ledger need, WITHOUT the
 * transcript window (which can be several KB per row). The window is fetched
 * per-row through `detail` only when the operator inspects one.
 */
function projectList(r) {
  return {
    id: r.id,
    v: r.v,
    ts: r.ts,
    sessionId: r.sessionId,
    skip: r.skip,
    source: r.source,
    layer: r.layer,
    verdict: r.verdict,
    confidence: r.confidence,
    band: r.band,
    streak: r.streak,
    mode: r.mode,
    outcome: r.outcome,
    latencyMs: r.latencyMs,
    events: r.events,
    code: r.code
      ? {
          ran: !!r.code.ran,
          calls: r.code.calls ?? null,
          groupCount: r.code.groupCount ?? 0,
          stuck: !!r.code.stuck,
          stuckCount: Array.isArray(r.code.stuckGroups) ? r.code.stuckGroups.length : 0,
          synthesized: !!r.code.synthesized,
        }
      : null,
    model: r.model
      ? {
          verdict: r.model.verdict ?? null,
          confidence: r.model.confidence ?? null,
          latencyMs: r.model.latencyMs ?? 0,
          inferred: !!r.model.inferred,
          hasReasoning: r.model.hasReasoning ?? null,
          synthesized: !!r.model.synthesized,
        }
      : null,
    windowChars: r.window.length,
    windowLines: r.window ? r.window.split('\n').length : 0,
  }
}

const ok = (value) => ({ ok: true, value })
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } })

// ================================================================
// PLUGIN
// ================================================================

export default {
  inject: ['connection'],

  apply(ctx) {
    const log = ctx.logger ? ctx.logger(PLUGIN_NAME) : null
    const say = (msg, level) => {
      try {
        if (log && typeof log[level ?? 'info'] === 'function') log[level ?? 'info'](msg)
        else console.log(msg)
      } catch {
        // logging must never break the plugin
      }
    }

    const connection = ctx.get('connection')
    if (!connection) {
      say(`[X] ${PLUGIN_NAME}: connection service missing - panel stays off`, 'error')
      return
    }

    const handler = async (endpoint, payload) => {
      try {
        const p = payload && typeof payload === 'object' ? payload : {}
        const led = loadLedger()

        if (endpoint === 'list') {
          const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null
          const includeSkipped = p.includeSkipped !== false
          let rows = led.records
          if (sessionId) rows = rows.filter((r) => r.sessionId === sessionId)
          if (!includeSkipped) rows = rows.filter((r) => r.skip === null)

          const requested = Number.isFinite(p.limit) ? p.limit : DEFAULT_LIMIT
          const limit = Math.max(1, Math.min(MAX_LIMIT, requested))
          const truncated = rows.length > limit
          if (truncated) rows = rows.slice(-limit)

          const stats = { total: led.records.length, matched: rows.length, truncated, corrupt: led.corrupt ?? 0 }
          stats.code = led.records.filter((r) => r.layer === 'code').length
          stats.model = led.records.filter((r) => r.layer === 'model').length
          stats.skipped = led.records.filter((r) => r.skip !== null).length
          stats.stuck = led.records.filter((r) => r.band === 'stuck').length

          return ok({
            records: rows.map(projectList),
            stats,
            sessions: led.sessions,
            error: led.error ?? null,
            ledgerFile: LEDGER_FILE,
          })
        }

        if (endpoint === 'sessions') {
          return ok({ sessions: led.sessions, error: led.error ?? null })
        }

        if (endpoint === 'detail') {
          const id = Number(p.id)
          if (!Number.isFinite(id)) return fail('bad_request', 'detail requires a numeric id')
          const rec = led.byId.get(id)
          if (!rec) return fail('not_found', `no evaluation with id ${id} (it may have rotated out of the ledger)`)
          return ok({ record: rec })
        }

        return fail('unknown_endpoint', `unknown endpoint ${String(endpoint)}`)
      } catch (err) {
        return fail('internal', err && err.message ? err.message : String(err))
      }
    }

    // --- transport 1: Fetch routes under the /api fence (what the browser
    // client reaches through connection.rpc.call("/api", "<prefix>/<endpoint>")).
    // Mirrors ../scheduled-queue/: the route is consulted before the shared
    // interceptor, so an unauthenticated probe gets 401, not 404.
    const apiFetch = (endpoint) => async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        body = {}
      }
      const envelope =
        body && typeof body === 'object' && body.type === 'client-request' && typeof body.rpcId === 'string' ? body : null
      const result = await handler(endpoint, envelope ? envelope.payload : body)
      const response = envelope ? { type: 'server-response', rpcId: envelope.rpcId, result } : result
      return Response.json(response, { headers: { 'cache-control': 'no-store' } })
    }

    ctx.effect(
      () => {
        const disposes = []
        for (const endpoint of ENDPOINTS) {
          try {
            disposes.push(
              connection.fetch.register({
                path: `${API_BASE}/${endpoint}`,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: apiFetch(endpoint),
              }),
            )
          } catch (err) {
            say(
              `[X] ${PLUGIN_NAME}: fetch route ${API_BASE}/${endpoint} failed: ${err && err.message ? err.message : String(err)}`,
              'error',
            )
          }
        }
        return () => {
          for (const d of disposes) {
            try {
              if (typeof d === 'function') d()
            } catch {}
          }
        }
      },
      `${PLUGIN_NAME}: fetch routes`,
    )

    // --- transport 2: the private channel (connection.rpc.handle).
    try {
      const disposeChannel = connection.rpc.handle(CHANNEL, (endpoint, payload) => handler(endpoint, payload))
      ctx.effect(
        () => (typeof disposeChannel === 'function' ? disposeChannel : undefined),
        `${PLUGIN_NAME}: ${CHANNEL} channel`,
      )
    } catch (err) {
      say(
        `[X] ${PLUGIN_NAME}: rpc.handle(${CHANNEL}) threw - /api routes stay up: ${err && err.message ? err.message : String(err)}`,
        'error',
      )
    }

    try {
      const led = loadLedger()
      say(
        `[A] ${PLUGIN_NAME} loaded: ledger=${LEDGER_FILE} records=${led.records.length} ` +
          `sessions=${led.sessions.length}${led.error ? ` (${led.error})` : ''} ` +
          `transports=${API_BASE}+${CHANNEL} endpoints=${ENDPOINTS.join(',')}`,
      )
    } catch (err) {
      say(`[X] ${PLUGIN_NAME}: initial ledger read failed: ${err && err.message ? err.message : String(err)}`, 'error')
    }
  },
}
