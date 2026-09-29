// model-switch: host-plane plugin for the `web` profile. Two jobs:
//
//  1. The model-facing tools that let the agent change its OWN model mid-session
//     (unchanged contract, see below): `switch_model` and `switch_model_escalate`.
//  2. A CONTEXT-WINDOW FIT GUARD around every route change, because on this
//     deployment the local models top out far below the cloud route and a
//     careless downward switch strands the session.
//
// ---------------------------------------------------------------------------
// WHY THE GUARD EXISTS (the real incident, 2026-09-28)
// ---------------------------------------------------------------------------
// Session session-933aa928 was working on deepseek-flash (window 1,048,576).
// The user switched to local-ai-machine/big-moe (window 262,144) and sent one
// message. Turn 15 step 1 then went:
//
//   attempt 1 -> "Request timed out."                       (TIMEOUT, retried)
//   attempt 2 -> 400 litellm.ContextWindowExceededError:
//                request (420948 tokens) exceeds the available context size
//                (262144 tokens)
//   compaction/start  <- dsh DID classify it and started overflow recovery
//   compaction/end    <- error: the SAME 400, at 421,300 tokens
//   retry -> same 400 -> turn/end error surfaced to the user
//
// Two independent harness behaviours combined to make that unrecoverable, and
// both are why a guard has to run BEFORE the route changes:
//
//   a) The automatic pre-step pressure gate resolves its target from
//      `session.requestHeader()?.config` (dsh-compaction-basic, routedTarget),
//      i.e. the last MINTED request envelope. At the first step after a switch
//      that is still the OLD model, so the threshold it compares against is the
//      old model's (0.8 x 1,048,576 = 838k here) and nothing compacts. The first
//      request on the new, smaller route is structurally unguarded.
//
//   b) When overflow recovery does fire, `dsh-compaction-basic` summarizes with
//      the "latest routed request target" by default - the same model that just
//      overflowed. The rescue call therefore had to push 421k tokens through a
//      262k model. It cannot ever win.
//
// A local model cannot summarize a conversation larger than its own window (it
// has to READ it), so this is a hard physical ceiling, not a tuning problem:
// with local roles at 65,536/262,144 and the only big window on the cloud route,
// the ONLY moment a 421k session can be condensed is while a big-window model is
// still routed. Hence: compact to fit BEFORE switching, and refuse the switch
// (with actionable numbers) when even that is impossible.
//
// The automatic agent path goes through this guard. The interactive path cannot
// - the composer's own picker calls sessionController.selectModel directly - so
// the Client half (client.mjs) warns with the same numbers and offers a
// one-click repair through the `state`/`fix` endpoints below.
//
// ---------------------------------------------------------------------------
// MECHANISM (all pre-existing services, verified against the live runtime)
// ---------------------------------------------------------------------------
//   ctx.llm.resolveModelInfo(provider, model, signal) -> LlmResolvedModelInfo
//       `.context.contextWindow` is the adapter-owned capacity. Hand-declared
//       routes on this deployment declare it explicitly (see settings.yaml's
//       long contextWindow notes) - it is the same number compaction uses.
//   ctx.tokenMeter.measure(session) -> { totalTokens, nodes[] }
//       Replay-based, no model calls. `totalTokens` is request-and-response
//       pressure; `nodes[]` carries one entry per surface node with `seq` and
//       `tokens`, in surface order, which is what region selection needs.
//   ctx.compaction.compactRegion(start, end, agent, signal)
//       The caller-selected-range operation. Unlike compactNow it does NOT
//       require an idle agent - it runs inside the open turn, which is exactly
//       what overflow recovery itself uses, so a tool call may use it too.
//   ctx.compaction.compactNow(agent, signal)
//       Idle-only (it reserves the next-turn admission via agent.runMaintenance),
//       so it is unusable from a tool call and is used only by the Client's
//       `fix` endpoint, which runs between turns.
//   sessionController.selectModel({ sessionId, provider, model })
//       The same in-process method the browser picker calls: validates through
//       llm.resolveCallConfig, appends the durable `model/selection` event,
//       installs the live per-agent selection, persists the deployment default.
//
// NOTE ON ACCURACY: token-meter's heuristic prices text at ~4 chars/token and
// under-prices CJK and dense JSON (its own README says so), which is the most
// likely reason the pre-step gate in (a) also missed. Every judgement here is
// therefore made against a FRACTION of the destination window (fitRatio, default
// 0.8) rather than the whole thing, and the guard errs toward compacting.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const PLUGIN_NAME = 'model-switch'

const DEFAULT_ESCALATION = { provider: 'local-ai-machine', model: 'medium-dense' }

// The big-window route the interactive repair (`fix`) switches to before
// compacting when the session is already stranded on a small model. It must be
// a route whose window can hold the whole conversation; the only such route on
// this deployment is the cloud one. Configure it if that ever changes.
const DEFAULT_READER = { provider: 'local-ai-machine-cloud', model: 'deepseek-flash' }

// Upper bound for the interactive repair's compaction call.
const COMPACTION_TIMEOUT_MS = 20 * 60 * 1000

const DEFAULT_CONFIG = {
  // Judgement is made against this fraction of the destination window, leaving
  // headroom for the heuristic's known under-pricing and the reply itself.
  fitRatio: 0.8,
  // Room the replacement summary checkpoint will occupy. compaction-basic's own
  // default maxTokens is 8192; the framing text is small, this is deliberately
  // generous.
  summaryReserveTokens: 10000,
  // Bounded retries when a chosen region boundary is rejected by the service.
  maxRegionAttempts: 8,
  // Outer attempts: if one compaction did not free enough, shrink the retained
  // tail and try again.
  maxCompactionAttempts: 3
}

// ================================================================
// SMALL HELPERS
// ================================================================

function routeLabel(route) {
  if (route === undefined || route === null) return 'unknown'
  return `${route.provider}/${route.model}`
}

function sameRoute(a, b) {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model
}

function catalogRouteList(catalog) {
  const routes = []
  for (const group of catalog?.groups ?? []) {
    for (const model of group?.models ?? []) routes.push(`${group.id}/${model.id}`)
  }
  return routes
}

function asRoute(value) {
  if (typeof value !== 'string') return undefined
  const at = value.indexOf('/')
  if (at <= 0 || at === value.length - 1) return undefined
  return { provider: value.slice(0, at), model: value.slice(at + 1) }
}

function asPositiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

// ================================================================
// MEASUREMENT
// ================================================================

/**
 * Adapter-owned context capacity for one exact route, or undefined when the
 * route is unknown or declares none. Never throws: an unresolvable destination
 * degrades to "cannot judge" rather than blocking a switch the harness would
 * itself accept.
 */
/**
 * Resolve one Host/Service by name from the FIRST context that actually has it.
 *
 * This is not defensive padding - it is required, and getting it wrong made the
 * guard's repair path a silent no-op in its first live test ("compacting before
 * the switch did not succeed: no compaction service is mounted").
 *
 * The cause is composition structure. `tokenMeter` and `llm` are HOST-level (the
 * `standard` preset's own comment says the meter deliberately stays on the host),
 * so a profile-plane plugin row reaches them through its own `ctx`. But
 * `compaction` is composed PER AGENT inside the preset's
 * `isolate: { compaction: true }` realm, so `ctx.get('compaction')` from this row
 * is legitimately undefined - only `agent.ctx`, a context inside that agent's
 * isolation realm, can see it.
 *
 * Probe order: the agent's context (narrowest and most correct for anything the
 * agent loop itself uses), then this row's own context, then the root. Each
 * probe is guarded because a lookup can throw in an unrelated scope.
 *
 * @returns {{ service: unknown, from: string | undefined }} the first hit and
 *   the scope that produced it (service undefined when nothing provides it).
 */
function resolveService(ctx, agent, name) {
  const candidates = [
    ['agent', () => agent?.ctx?.get?.(name)],
    ['plugin', () => ctx.get?.(name)],
    ['root', () => ctx.root?.get?.(name)],
  ]
  for (const [from, probe] of candidates) {
    try {
      const service = probe()
      if (service !== undefined && service !== null) return { service, from }
    } catch {
      // an unrelated scope may reject the lookup; try the next candidate
    }
  }
  return { service: undefined, from: undefined }
}

async function resolveWindow(ctx, agent, provider, model, signal) {
  const llm = resolveService(ctx, agent, 'llm').service
  if (llm === undefined) return undefined
  try {
    const info = await llm.resolveModelInfo(provider, model, signal)
    return asPositiveInt(info?.context?.contextWindow)
  } catch {
    return undefined
  }
}

/**
 * A detached, smallest-possible reading of the session's current prompt
 * pressure. Only the two leaf fields region selection needs are copied out of
 * the live measurement; nothing from the session or the meter is retained.
 */
function readPressure(ctx, agent, session) {
  const meter = resolveService(ctx, agent, 'tokenMeter').service
  if (meter === undefined) return undefined
  let measurement
  try {
    measurement = meter.measure(session)
  } catch {
    return undefined
  }
  const totalTokens = typeof measurement?.totalTokens === 'number' ? measurement.totalTokens : undefined
  if (totalTokens === undefined) return undefined
  const nodes = Array.isArray(measurement?.nodes)
    ? measurement.nodes
        .map((node) => ({ seq: node?.seq, tokens: typeof node?.tokens === 'number' ? node.tokens : 0 }))
        .filter((node) => node.seq !== undefined && node.seq !== null)
    : []
  return { totalTokens, nodes }
}

/** Does `tokens` fit a destination window under the configured headroom? */
function fitsWindow(tokens, window, config) {
  if (window === undefined) return undefined
  return tokens <= Math.floor(window * config.fitRatio)
}

// ================================================================
// COMPACT-TO-FIT
// ================================================================

/**
 * Choose the retained-tail boundary that should bring the post-compaction total
 * under `budget`, then walk it BACKWARD until the service accepts the boundary.
 *
 * The walk mirrors dsh-compaction-basic's own selectCompactableRange: moving the
 * boundary earlier retains more and compacts less, which is the safe direction
 * (it never splits a tool call/result pair or the still-open step). A rejected
 * boundary is validated read-only before any durable write, so retrying is safe.
 *
 * @returns {Promise<{ok: true, freed: number} | {ok: false, reason: string}>}
 */
async function compactToFit(ctx, agent, budget, config, signal, log) {
  const compaction = resolveService(ctx, agent, 'compaction').service
  if (compaction === undefined) return { ok: false, reason: `no compaction service is reachable (tried the agent, plugin and root scopes)` }

  const session = agent.session
  let lastReason = 'no compactable history yet'

  for (let attempt = 0; attempt < config.maxCompactionAttempts; attempt += 1) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' }
    const pressure = readPressure(ctx, agent, session)
    if (pressure === undefined) return { ok: false, reason: 'no token measurement is available' }
    if (pressure.totalTokens <= budget) return { ok: true, freed: 0 }

    const nodes = pressure.nodes
    if (nodes.length < 3) return { ok: false, reason: 'no compactable history yet' }

    // Node 0 is the system prompt, which compaction never shadows. Leave it.
    const startIdx = 1
    // Never let the region reach the last node: it belongs to the step that is
    // still open (this very tool call), and the service rejects it anyway.
    const lastRegionIdx = nodes.length - 2
    if (lastRegionIdx < startIdx) return { ok: false, reason: 'no compactable history yet' }

    let head = 0
    for (let i = 0; i < startIdx; i += 1) head += nodes[i].tokens

    // Shrink the tail on each outer attempt: less retained means more freed.
    const tailBudget = Math.max(
      0,
      Math.floor((budget - head - config.summaryReserveTokens) * Math.pow(0.6, attempt)),
    )

    // `keepIdx` is the first node of the retained tail; the region ends just
    // before it. Walk backward from the end until the tail is budgeted, exactly
    // as the service's own selection does.
    let keepIdx = nodes.length
    let accumulated = 0
    for (let i = nodes.length - 1; i >= startIdx; i -= 1) {
      accumulated += nodes[i].tokens
      keepIdx = i
      if (accumulated >= tailBudget) break
    }

    let placed = false
    for (let tries = 0; tries < config.maxRegionAttempts && keepIdx - 1 >= startIdx; tries += 1) {
      const endIdx = keepIdx - 1
      const before = pressure.totalTokens
      try {
        await compaction.compactRegion(nodes[startIdx].seq, nodes[endIdx].seq, agent, signal)
      } catch (error) {
        const text = message(error)
        // Boundary/surface validation failures are read-only and retryable by
        // moving the boundary earlier (retaining more, compacting less, which is
        // the safe direction). Anything else - a summarization failure, a busy
        // compaction, cancellation - is terminal for this attempt.
        if (/compactRegion:/.test(text) && /balanced boundary|not found in surface|after end seq/.test(text)) {
          lastReason = text
          keepIdx -= 1
          continue
        }
        return { ok: false, reason: text }
      }
      const after = readPressure(ctx, agent, session)
      log?.info(
        'fit-guard: compacted %d -> %d tokens (~%d freed)',
        before,
        after?.totalTokens ?? -1,
        before - (after?.totalTokens ?? before),
      )
      if (after !== undefined && after.totalTokens <= budget) {
        return { ok: true, freed: before - after.totalTokens }
      }
      placed = true
      break
    }
    if (!placed) {
      // Every candidate boundary in this pass was rejected; a smaller tail may
      // still find a valid one.
      lastReason = lastReason === 'no compactable history yet' ? 'no valid compaction boundary was found' : lastReason
    }
  }

  return { ok: false, reason: `compaction did not free enough context (${lastReason})` }
}

// ================================================================
// THE GUARD
// ================================================================

/**
 * Decide whether one route change is safe, and make it safe when it is not.
 *
 * @returns {Promise<{allowed: boolean, reason?: string, note?: string,
 *   tokens?: number, window?: number, compacted?: boolean, freed?: number}>}
 */
async function guardRouteChange(ctx, agent, provider, model, config, signal, log) {
  const tokens = readPressure(ctx, agent, agent.session)?.totalTokens
  if (tokens === undefined) {
    return { allowed: true, note: 'no token measurement available; the fit check was skipped' }
  }
  const window = await resolveWindow(ctx, agent, provider, model, signal)
  if (window === undefined) {
    return { allowed: true, note: `no declared context window for ${provider}/${model}; the fit check was skipped`, tokens }
  }
  if (fitsWindow(tokens, window, config)) {
    return { allowed: true, tokens, window }
  }

  const budget = Math.floor(window * config.fitRatio)
  const shortfall = tokens - budget
  const routed = agent.session.requestHeader()?.config
  const currentWindow = await resolveWindow(ctx, agent, routed?.provider, routed?.model, signal)

  // Can the route we are on right now even READ the conversation? If not, no
  // amount of retrying will compact it, and switching would only move the
  // failure. Say so with numbers instead of switching.
  if (currentWindow === undefined || tokens > Math.floor(currentWindow * config.fitRatio)) {
    return {
      allowed: false,
      tokens,
      window,
      reason:
        `context is ~${tokens} tokens and ${provider}/${model} has a ${window}-token window. ` +
        `It cannot be compacted from the current route (${routeLabel(routed)}, ` +
        `${currentWindow === undefined ? 'no declared window' : `${currentWindow} tokens`}) because a model must read a ` +
        `conversation in order to summarize it. Delegate this work to a local subagent instead ` +
        `(the \`subagent\` tool accepts provider/model), or switch to a route with a larger window.`
    }
  }

  if (config.autoCompact !== true) {
    return {
      allowed: false,
      tokens,
      window,
      reason:
        `context is ~${tokens} tokens and ${provider}/${model} has a ${window}-token window ` +
        `(~${shortfall} over the ${budget}-token budget). Automatic fit compaction is disabled ` +
        `(autoCompact: false); compact with /compact first, or delegate to a subagent.`
    }
  }

  log?.info(
    'fit-guard: %s -> %s needs ~%d tokens vs window %d; compacting first',
    routeLabel(routed),
    `${provider}/${model}`,
    tokens,
    window,
  )
  const result = await compactToFit(ctx, agent, budget, config, signal, log)
  if (!result.ok) {
    return {
      allowed: false,
      tokens,
      window,
      reason:
        `context is ~${tokens} tokens and ${provider}/${model} has a ${window}-token window. ` +
        `It could not be compacted automatically before the switch: ${result.reason}. ` +
        `That is a structural limit, not a tuning problem - compaction is composed per agent ` +
        `inside a private realm, so a mid-turn tool cannot reach it (only /compact can, and only ` +
        `while the session is idle). Three ways forward: (1) delegate this work to a local ` +
        `subagent instead of switching - the \`subagent\` tool takes provider/model and the child ` +
        `starts with a fresh, small context; (2) ask the user to use the composer's ` +
        `"Compact and stay" repair, or /compact, and then switch; (3) switch to a route with a ` +
        `larger window.`
    }
  }

  const after = readPressure(ctx, agent, agent.session)?.totalTokens
  if (after !== undefined && !fitsWindow(after, window, config)) {
    return {
      allowed: false,
      tokens: after,
      window,
      reason:
        `compaction freed ~${result.freed} tokens but the context is still ~${after} against ` +
        `${provider}/${model}'s ${window}-token window (~${budget} usable). Delegate to a local ` +
        `subagent instead, or switch to a larger-window route.`
    }
  }

  return {
    allowed: true,
    tokens: after ?? tokens,
    window,
    compacted: result.freed > 0,
    freed: result.freed
  }
}

// ================================================================
// SWITCH
// ================================================================

/**
 * Validate + install a model selection for one agent, then queue the
 * agent-authored first message for the new model's next turn.
 * Returns { ok, from, to, alreadyOnRoute } or { ok: false, error }.
 */
async function switchAgentModel(ctx, log, config, agent, provider, model, text, noticeSummary, signal) {
  const controller = resolveService(ctx, agent, 'sessionController').service
  if (controller === undefined) {
    return {
      ok: false,
      error: 'model switching is unavailable in this profile (no sessionController service).'
    }
  }

  const from = agent.session.requestHeader()?.config

  let guard
  try {
    guard = await guardRouteChange(ctx, agent, provider, model, config, signal, log)
  } catch (error) {
    return { ok: false, error: `context fit check failed: ${message(error)}` }
  }
  if (!guard.allowed) {
    log?.warn('switch to %s/%s refused by fit guard: %s', provider, model, guard.reason)
    return { ok: false, error: `model switch refused: ${guard.reason}` }
  }

  let to
  try {
    to = (await controller.selectModel({ sessionId: agent.id, provider, model })).selected
  } catch (error) {
    let hint = ''
    try {
      const routes = catalogRouteList(await controller.modelCatalog())
      if (routes.length > 0) hint = ` Available routes: ${routes.join(', ')}.`
    } catch {
      // catalog is a convenience; never mask the real error with it
    }
    log?.warn('switch to %s/%s failed: %s', provider, model, message(error))
    return { ok: false, error: `model switch failed: ${message(error)}${hint}` }
  }

  const fitNote =
    guard.compacted === true
      ? ` The conversation was compacted first (~${guard.freed} tokens freed) so it fits ${provider}/${model};`
      : ''
  agent.steer(
    createUserMessage({
      content: [{ type: 'text', text: fitNote.length > 0 ? `${fitNote} ${text}` : text }],
      source: {
        kind: 'plugin',
        plugin: PLUGIN_NAME,
        form: 'notice',
        summary: noticeSummary
      }
    }),
  )

  const alreadyOnRoute = sameRoute(from, to)
  log?.info(
    'session %s: model %s -> %s (%s)',
    agent.id,
    routeLabel(from),
    routeLabel(to),
    alreadyOnRoute ? 'already on route, message queued only' : 'switched',
  )
  return {
    ok: true,
    from: routeLabel(from),
    to: routeLabel(to),
    alreadyOnRoute,
    compacted: guard.compacted === true,
    freed: guard.freed,
    tokens: guard.tokens,
    window: guard.window
  }
}

function noAgent() {
  return {
    ok: false,
    error:
      'no agent context for this tool call; model switching only works from a model turn of the session itself.'
  }
}

function switchOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        from: { type: 'string' },
        to: { type: 'string' },
        alreadyOnRoute: { type: 'boolean' },
        compacted: { type: 'boolean' },
        freed: { type: 'number' },
        tokens: { type: 'number' },
        window: { type: 'number' },
        error: { type: 'string' }
      }
    },
    render(_args, value) {
      if (!value.ok) return [{ type: 'text', text: value.error }]
      if (value.alreadyOnRoute) {
        return [
          {
            type: 'text',
            text: `Session is already on ${value.to}; the notice was steered to the current turn.`
          }
        ]
      }
      const fit =
        value.compacted === true
          ? ` The conversation was compacted to fit first (~${value.freed} tokens freed; now ~${value.tokens} against a ${value.window}-token window).`
          : ''
      return [
        {
          type: 'text',
          text: `Session switched to ${value.to} (was ${value.from}).${fit} A notice explaining the switch was steered to the new model; a durable "model changed" notice marks the boundary in the transcript.`
        }
      ]
    }
  }
}

// ================================================================
// CLIENT-FACING STATE + REPAIR
// ================================================================

// Every model's declared capacity, cached across calls. `sessionController
// .modelCatalog()` carries NO contextWindow (only id/name/reasoning), so the
// only way to know each route's capacity is one `llm.resolveModelInfo` per
// route - and for a hand-declared pi-ai provider that call can be slow. Building
// the table is therefore kept OFF the interactive path entirely: `state` returns
// immediately from whatever is cached and refreshes in the background for the
// next read. A cold cache only means the badge cannot yet name alternative
// routes; the fit verdict for the ROUTED route never depends on it.
const ROUTE_CAPACITY_TTL_MS = 10 * 60 * 1000
const routeCapacity = { at: 0, routes: [], inflight: false }

function refreshRouteCapacities(ctx, log) {
  if (routeCapacity.inflight) return
  routeCapacity.inflight = true
  const controller = resolveService(ctx, undefined, 'sessionController').service
  if (controller === undefined) {
    routeCapacity.inflight = false
    return
  }
  Promise.resolve()
    .then(() => controller.modelCatalog())
    .then(async (catalog) => {
      const routes = []
      for (const group of catalog?.groups ?? []) {
        for (const model of group?.models ?? []) {
          const window = await resolveWindow(ctx, undefined, group.id, model.id)
          if (window !== undefined) {
            routes.push({ provider: group.id, model: model.id, contextWindow: window })
          }
        }
      }
      routeCapacity.routes = routes
      routeCapacity.at = Date.now()
      routeCapacity.inflight = false
    })
    .catch((error) => {
      routeCapacity.inflight = false
      log?.warn('route capacity table refresh failed: %s', message(error))
    })
}

/**
 * The route to recommend when the current one cannot hold the conversation.
 *
 * Smallest-fitting-window is the intuitive rule and it is the WRONG one here:
 * three `deepseek-official/*` routes declare 1,000,000 and sit just under the
 * cloud proxy route at 1,048,576, so "smallest that still fits" lands on a
 * different provider than the operator's actual big model - and shares its
 * model id, which made the button ambiguous too. `preferredRoutes` (configured
 * `provider/model` pairs, defaulting to the reader route) is therefore tried
 * in order first, and the smallest window is only the fallback.
 */
function pickSuggestion(routes, tokens, config, exclude) {
  const skip = (exclude ?? []).filter((route) => route !== undefined && route !== null)
  const usable = (routes ?? []).filter(
    (route) =>
      !skip.some((other) => sameRoute(other, route)) &&
      tokens <= Math.floor(route.contextWindow * config.fitRatio)
  )
  if (usable.length === 0) return undefined
  for (const wanted of config.preferredRoutes ?? []) {
    const hit = usable.find((route) => sameRoute(route, wanted))
    if (hit !== undefined) return { ...hit, preferred: true }
  }
  return [...usable].sort((a, b) => a.contextWindow - b.contextWindow)[0]
}

/** The cached capacity table, refreshed in the background when stale. */
function routeCapacities(ctx, log) {
  if (Date.now() - routeCapacity.at > ROUTE_CAPACITY_TTL_MS) refreshRouteCapacities(ctx, log)
  return routeCapacity.routes
}

/**
 * One compact, JSON-safe reading of the current session's fit, for the Client
 * half. Only leaf numbers and small owned objects cross this boundary, and the
 * call is deliberately non-blocking: it awaits ONE window lookup for the routed
 * route (the same lookup compaction itself performs each step) and nothing else.
 */
async function currentState(ctx, sessionId, intended, config, log) {
  const agents = resolveService(ctx, undefined, 'agents').service
  const agent = agents !== undefined && sessionId !== undefined ? agents.get(sessionId) : undefined
  const sessions = resolveService(ctx, undefined, 'sessions').service
  const session =
    agent?.session ?? (sessions !== undefined && sessionId !== undefined ? sessions.get(sessionId) : undefined)
  if (session === undefined) return { available: false, reason: 'no live session for this id' }

  const routed = session.requestHeader()?.config
  const tokens = readPressure(ctx, agent, session)?.totalTokens
  if (routed === undefined || tokens === undefined) {
    return { available: false, reason: 'no routed request and token measurement yet' }
  }

  // Which route the verdict is about. The client names the PENDING selection when
  // a switch is queued in the picker but no message has been sent yet; the
  // projection (and `requestHeader`) can only ever describe the LAST request, so
  // without this the badge kept reporting the old model's window and nothing
  // moved until a message was sent - the whole point of switching in the picker
  // is to find out BEFORE sending.
  const destination = intended ?? { provider: routed.provider, model: routed.model }
  const window = await resolveWindow(ctx, agent, destination.provider, destination.model)
  const budget = window === undefined ? undefined : Math.floor(window * config.fitRatio)
  const fits = budget === undefined ? true : tokens <= budget
  // Two very different states hide behind `fits === false` and the Client must
  // not describe them the same way:
  //   budget < tokens <= window  -> ADVISORY. fitRatio is deliberately the same
  //     0.8 dsh-compaction-basic compacts at (types.d.ts: "Compact at this
  //     fraction of the model's context window. Defaults to 0.8"), so the next
  //     request neither fails nor strands anything - the harness compacts it
  //     first, on this route, which can still read it. The honest offer is "do
  //     it now, where you choose, or lose the tail to an automatic summary".
  //   tokens > window            -> HARD failure. The request 400s and overflow
  //     recovery summarises with the route that just overflowed, so it 400s too.
  //     That is the stranding incident in the header comment.
  const exceedsWindow = window === undefined ? undefined : tokens > window
  const capacities = routeCapacities(ctx, log)
  const models = capacities.map((route) => ({
    provider: route.provider,
    model: route.model,
    contextWindow: route.contextWindow,
    fits: budget === undefined ? undefined : tokens <= Math.floor(route.contextWindow * config.fitRatio)
  }))
  const suggest = fits === false ? pickSuggestion(capacities, tokens, config, [destination, routed]) : undefined

  // The repair only needs the configured reader route, which it resolves when it
  // runs - so the primary action never depends on the capacity table.
  // Reachable by either route (see `repair`): the service directly, or the
  // `/compact` command whose handler lives inside the agent's compaction realm.
  const canCompact =
    resolveService(ctx, agent, 'compaction').service !== undefined ||
    resolveService(ctx, agent, 'commands').service !== undefined
  const canFix = fits === false && canCompact

  return {
    available: true,
    sessionId,
    tokens,
    route: {
      provider: destination.provider,
      model: destination.model,
      contextWindow: window,
      pending: intended !== undefined
    },
    routed: { provider: routed.provider, model: routed.model },
    budget,
    fits,
    currentWindowKnown: window !== undefined,
    exceedsWindow,
    canFix,
    reader: config.reader,
    suggest,
    models
  }
}

/**
 * The interactive repair: get onto a route that can READ the conversation,
 * compact there, then land on the requested route. This is exactly the manual
 * sequence "switch back, compact, switch again", automated.
 *
 * Only valid while the agent is idle - which is the case for a click in the
 * composer - because compaction.compactNow reserves the next-turn admission.
 */
async function repair(ctx, log, config, payload, signal) {
  const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined
  const target = { provider: payload?.provider, model: payload?.model }
  if (sessionId === undefined) return { ok: false, error: 'fix requires a sessionId' }
  if (typeof target.provider !== 'string' || typeof target.model !== 'string') {
    return { ok: false, error: 'fix requires an exact provider and model' }
  }

  const agents = resolveService(ctx, undefined, 'agents').service
  const agent = agents?.get(sessionId)
  if (agent === undefined) return { ok: false, error: 'this session is not live in the host' }
  const controller = resolveService(ctx, agent, 'sessionController').service
  if (controller === undefined) return { ok: false, error: 'no sessionController service' }
  // Compaction is reachable here by TWO routes, and only one of them works from
  // a profile-plane plugin row:
  //
  //   - `ctx.compaction` directly. Unreachable in practice: the `standard` preset
  //     composes compaction-basic inside an entry-local
  //     `isolate: { compaction: true, toolResultPruner: true }` realm, so the
  //     service is invisible to every context above it - agent, plugin and root
  //     alike (verified live: all three scopes returned undefined).
  //   - the `/compact` COMMAND, whose handler row (`command-compact`) sits INSIDE
  //     that realm and therefore reaches the service. Dispatching it through the
  //     host `commands` registry is a supported way in from outside.
  //
  // The command route is what makes the interactive repair work at all, and it is
  // only valid at idle (compactNow reserves the next-turn admission) - which is
  // exactly the interactive case, a click between turns.
  const compaction = resolveService(ctx, agent, 'compaction').service
  const commands = resolveService(ctx, agent, 'commands').service
  // This endpoint has no caller signal of its own, but BOTH compaction routes
  // require a real AbortSignal - `compactNow` calls `signal.throwIfAborted()`
  // immediately and `commands.execute` takes one as a required argument. A
  // concrete scope with a generous cap (the deployment's own notes describe
  // 200s+ prefills and 15-minute stream idle budgets) beats passing undefined.
  const compactionSignal = signal ?? AbortSignal.timeout(COMPACTION_TIMEOUT_MS)
  if (compaction === undefined && commands === undefined) {
    return { ok: false, error: 'no compaction service or command registry is reachable from this plugin' }
  }

  const steps = []
  const routed = agent.session.requestHeader()?.config
  const tokens = readPressure(ctx, agent, agent.session)?.totalTokens
  if (routed === undefined || tokens === undefined) {
    return { ok: false, error: 'no routed request and token measurement yet' }
  }
  const targetWindow = await resolveWindow(ctx, agent, target.provider, target.model, signal)
  if (fitsWindow(tokens, targetWindow, config) === true) {
    // The destination already holds this conversation, so no compaction is
    // needed - this is the banner's "move to <smallest fitting route>" action.
    const alreadyThere = sameRoute(routed, target)
    if (!alreadyThere) {
      try {
        await controller.selectModel({ sessionId, provider: target.provider, model: target.model })
        steps.push(`switched to ${routeLabel(target)}`)
      } catch (error) {
        return { ok: false, steps, error: `could not switch to ${routeLabel(target)}: ${message(error)}` }
      }
      log?.info('fit-guard: moved %s to %s (no compaction needed)', sessionId, routeLabel(target))
    }
    return { ok: true, steps, alreadyFits: true, switched: !alreadyThere, tokens }
  }

  // 1. Move to a route that can read the conversation, when the current one
  //    cannot. The reader is the configured big-window route.
  const currentWindow = await resolveWindow(ctx, agent, routed.provider, routed.model, signal)
  // "Can this route summarise the conversation" is the ROUTE'S OWN WINDOW, not
  // the fit margin: fitRatio is the headroom for deciding whether to compact at
  // all, while reading the transcript is a physical yes/no. With the margin here
  // a conversation at 80.3% of its window - comfortably readable, and the state
  // the Client now labels advisory - was needlessly migrated to the cloud reader
  // and back for a compaction the current route could have done itself.
  const canReadHere = currentWindow !== undefined && tokens <= currentWindow
  const reader = config.reader
  if (!canReadHere) {
    if (reader.provider === routed.provider && reader.model === routed.model) {
      return {
        ok: false,
        error:
          `the configured reader route ${routeLabel(reader)} is the current route and cannot hold ` +
          `${tokens} tokens; configure a reader with a larger window`
      }
    }
    try {
      await controller.selectModel({ sessionId, provider: reader.provider, model: reader.model })
      steps.push(`switched to reader ${routeLabel(reader)}`)
    } catch (error) {
      return { ok: false, error: `could not switch to the reader route ${routeLabel(reader)}: ${message(error)}` }
    }
  }

  // 2. Compact while that big window is routed. Success is judged by RE-MEASURING,
  //    not by the callee's return shape, so both routes report the same way.
  const beforeCompact = readPressure(ctx, agent, agent.session)?.totalTokens
  let compacted = false
  if (compaction !== undefined) {
    try {
      const result = await compaction.compactNow(agent, compactionSignal)
      if (result !== null) compacted = true
    } catch (error) {
      log?.warn('fit-guard: direct compactNow failed (%s); falling back to /compact', message(error))
    }
  }
  if (!compacted && commands !== undefined) {
    // The dispatch is also how a session with no reachable service compacts:
    // `command-compact` runs inside the realm and owns the real service.
    try {
      const execution = await commands.execute(agent, '/compact', [], compactionSignal)
      if (execution === undefined) {
        return { ok: false, steps, error: 'the /compact command is not available in this session' }
      }
      const result = execution.result
      if (result !== undefined && result.kind === 'error') {
        return { ok: false, steps, error: `compaction failed: ${result.text}` }
      }
      if (typeof result?.text === 'string' && result.text.length > 0) steps.push(result.text)
    } catch (error) {
      return {
        ok: false,
        steps,
        error: `${message(error)} (compaction needs an idle session; retry when the current turn finishes)`
      }
    }
  }
  const afterCompact = readPressure(ctx, agent, agent.session)?.totalTokens
  if (beforeCompact !== undefined && afterCompact !== undefined && afterCompact >= beforeCompact) {
    return {
      ok: false,
      steps,
      error: `compaction did not reduce the conversation (still ~${afterCompact} tokens)`
    }
  }
  steps.push('compacted')

  // 3. Land on the requested route.
  try {
    await controller.selectModel({ sessionId, provider: target.provider, model: target.model })
    steps.push(`switched to ${routeLabel(target)}`)
  } catch (error) {
    return { ok: false, steps, error: `compaction succeeded but the switch failed: ${message(error)}` }
  }

  const after = readPressure(ctx, agent, agent.session)?.totalTokens
  log?.info('fit-guard: repaired %s -> %s via %s (%s tokens)', sessionId, routeLabel(target), routeLabel(reader), after)
  return { ok: true, steps, tokens, tokensAfter: after, fits: fitsWindow(after, targetWindow, config) !== false }
}

// ================================================================
// PLUGIN
// ================================================================

export default function modelSwitch(ctx, config = {}) {
  const log = ctx.logger(PLUGIN_NAME)
  const escalation = {
    provider: config.escalationProvider ?? DEFAULT_ESCALATION.provider,
    model: config.escalationModel ?? DEFAULT_ESCALATION.model
  }
  const reader = {
    provider: config.readerProvider ?? DEFAULT_READER.provider,
    model: config.readerModel ?? DEFAULT_READER.model
  }
  // Recommended destinations when a conversation outgrows its route, in order
  // (`provider/model`). The configured reader route is the default because on
  // this deployment it IS the big-window route the operator actually uses (see
  // DEFAULT_READER) - a bare "smallest window that fits" pick would instead
  // offer one of the three `deepseek-official/*` routes, which share its model
  // id and are not what the picker is meant to move to.
  const preferredRoutes = (Array.isArray(config.preferredRoutes) ? config.preferredRoutes : [])
    .map(asRoute)
    .filter((route) => route !== undefined)
  if (preferredRoutes.length === 0) preferredRoutes.push(reader)

  const settings = {
    ...DEFAULT_CONFIG,
    fitRatio: typeof config.fitRatio === 'number' ? config.fitRatio : DEFAULT_CONFIG.fitRatio,
    summaryReserveTokens:
      typeof config.summaryReserveTokens === 'number'
        ? config.summaryReserveTokens
        : DEFAULT_CONFIG.summaryReserveTokens,
    autoCompact: config.autoCompact !== false,
    reader,
    preferredRoutes
  }

  ctx.inject(['tools'], (toolCtx) => {
    ctx.effect(
      () =>
        toolCtx.tools.register(
          defineTool({
            name: 'switch_model',
            description:
              'Switch the current session\'s model to a different provider/model, sending the given message to the new model immediately. Use when you judge the remaining work is better served by another model - a stronger reasoner for a hard problem, a model with a needed capability, or a cheaper model for mechanical work. The session\'s full history carries over; a durable "model changed" notice marks the boundary, and the selection also becomes the deployment default for new sessions (exactly like switching from the UI). provider and model must be an exact pair from the model catalog - on a bad pair the tool returns the available routes so you can self-correct. message is the first message the new model receives: make it self-contained - where things stand, what you tried, what to do next. The session stays on the new model until switched again. IMPORTANT: switching DOWN to a model with a smaller context window than the conversation can strand the session, because a model must read a conversation in order to compact it. That check runs automatically: if the conversation would not fit, this tool compacts it first (reporting how much was freed) and refuses the switch with actionable numbers when even that is impossible - for example prefer delegating to a local subagent over switching a very large session to a small local model.',
            parameters: {
              provider: {
                type: 'string',
                required: true,
                description: 'Exact provider id from the model catalog, e.g. "local-ai-machine".'
              },
              model: {
                type: 'string',
                required: true,
                description: 'Exact model id under that provider, e.g. "medium-moe".'
              },
              message: {
                type: 'string',
                required: true,
                description:
                  'The first message the new model receives as a user message. Self-contained: where things stand, what was tried, what to do next.'
              }
            },
            output: switchOutput(),
            async execute(args, exec) {
              const agent = exec.agent
              if (agent === undefined) return noAgent()
              return await switchAgentModel(
                ctx,
                log,
                settings,
                agent,
                args.provider,
                args.model,
                args.message,
                `Model switched to ${args.provider}/${args.model}`,
                exec.signal,
              )
            }
          }),
        ),
      'model-switch: register switch_model',
    )
    ctx.effect(
      () =>
        toolCtx.tools.register(
          defineTool({
            name: 'switch_model_escalate',
            description:
              `Escape hatch for being stuck: repeated failures, a loop you cannot break out of, or a judgment call you cannot settle. Hands this session to the escalation model - you do NOT choose it; deployment policy decides (currently ${escalation.provider}/${escalation.model}). The session's full history carries over, the new model inherits the current task and continues anything in-flight, and a durable "model changed" notice marks the boundary. Make a genuine further attempt yourself first; never use this for an ordinary follow-up question. If the conversation would not fit the escalation route, it is compacted first (or the switch is refused with an explanation) rather than stranding the session.`,
            parameters: {},
            output: switchOutput(),
            async execute(_args, exec) {
              const agent = exec.agent
              if (agent === undefined) return noAgent()
              const text = `Switched to ${escalation.provider}/${escalation.model} (escalation route). Continuing with the current task.`
              return await switchAgentModel(
                ctx,
                log,
                settings,
                agent,
                escalation.provider,
                escalation.model,
                text,
                `Escalated to ${escalation.provider}/${escalation.model}`,
                exec.signal,
              )
            }
          }),
        ),
      'model-switch: register switch_model_escalate',
    )
  })

  // --- the Client half's two endpoints, over the same authenticated /api fence
  // the profile's other local plugins use. `state` is a read-only reading of the
  // current session; `fix` performs the repair. Both reuse the tools' own
  // helpers, so the interactive and the agent path can never disagree.
  // --- the Client half's endpoints, over a PLUGIN-OWNED route.
  //
  // NOT `connection.rpc.handle` / the `/api` fence, and the difference is load
  // bearing. That helper reads `owner.webServer` on the Connection service's own
  // context, which this deployment never injects (the service mounts /api from a
  // CHILD scope instead), so every channel registered through it answers 405.
  // That is precisely how the first version of this failed: the pill rendered
  // from the local projection while its host call never arrived, so the badge
  // could not know any route's capacity except the one in the last request.
  // ../dsh-better-git-worktree/host-main.mjs documents the same finding and is
  // the pattern copied here: register a prefix route through `webServer` and
  // reuse the connection trust fence through its public `requestRejection`.
  const RPC_PATH = '/modelSwitch'

  const readJsonBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve(text.length === 0 ? {} : JSON.parse(text))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const handler = async (endpoint, payload) => {
    try {
      const p = payload !== null && typeof payload === 'object' ? payload : {}
      if (endpoint === 'state') {
        const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : undefined
        const intended =
          typeof p.provider === 'string' && p.provider.length > 0 && typeof p.model === 'string' && p.model.length > 0
            ? { provider: p.provider, model: p.model }
            : undefined
        return { ok: true, state: await currentState(ctx, sessionId, intended, settings, log) }
      }
      if (endpoint === 'fix') {
        return await repair(ctx, log, settings, p)
      }
      return { ok: false, error: `unknown endpoint ${String(endpoint)}` }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }

  ctx.inject(['connection', 'webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      log.warn('webServer is unavailable; the fit pill and banner lose their route list and repair action')
      return
    }
    scope.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: RPC_PATH,
          handler: async (req, res) => {
            try {
              const connection = scope.get('connection')
              const rejection =
                connection !== undefined && typeof connection.requestRejection === 'function'
                  ? connection.requestRejection(req)
                  : undefined
              if (rejection !== undefined) {
                res.writeHead(rejection)
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
                return
              }
              if (req.method !== 'POST') {
                res.writeHead(405)
                res.end('method not allowed')
                return
              }
              const url = new URL(req.url ?? '/', 'http://dsh.internal')
              const endpoint = decodeURIComponent(url.pathname.slice(RPC_PATH.length + 1))
              const payload = await readJsonBody(req)
              const result = await handler(endpoint, payload)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(result))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: message(error) }))
            }
          }
        }),
      `${PLUGIN_NAME}: rpc route`,
    )
  })

  log.info(
    'model-switch active (escalation=%s/%s reader=%s/%s fitRatio=%s autoCompact=%s)',
    escalation.provider,
    escalation.model,
    reader.provider,
    reader.model,
    settings.fitRatio,
    settings.autoCompact,
  )
}
