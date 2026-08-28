// continue-kicker: a host-plane Cordis plugin for the `web` profile.
//
// DSH equivalent of local-ai-machine's pi-web-session-watcher, but
// in-process rather than an external poller, since dsh's session/agent
// registries are directly reachable from host-plane plugin code.
//
// Two triggers feed one shared decision function:
//
//   - agent/created: inspects the tail including seed/replayed events for
//     an unresolved halt. Covers crash recovery (interrupted markers only
//     ever exist in seeds - dsh-session-persistence-jsonl's crash-recovery
//     repair synthesizes them during LOAD and they never publish live) and
//     reopen-after-the-fact cases.
//   - Live watcher: per-agent subscription on agent.ctx 'session/event'
//     (the same firehose dsh-agent-loop itself consumes). Subscribed at
//     agent/created, unsubscribed at agent/disposed. Needed because an
//     unattended halt has no reopening event to invoke the agent/created
//     path at all - 'max-tokens' IS a real streamed finish reason that
//     lands on the live firehose (unlike 'interrupted', which is a
//     load-time-only synthesis). On a live turn/end it schedules a
//     DELAYED re-analysis rather than acting on the event alone: the
//     delay (liveKickDelayMs) lets a fast manual recovery land first,
//     sidesteps any publish-vs-persist ordering races, and re-runs the
//     exact same analyzeTail guards as the agent/created path. One
//     decision function, two doors. The live watcher re-analyzes on
//     EVERY turn/end, not just kickable ones, so a completed turn also
//     reaches maybeKick and clears the runaway-guard counter promptly -
//     if it only fired on kickable kinds, the counter would track "kicks
//     since dsh last restarted" rather than "consecutive kicks with no
//     success in between," since nothing else routes a completed turn
//     through the reset path outside of a session reopen.
//
// Tail classification (analyzeTail):
//
//   kick 'interrupted' - unresolved crash-recovery marker
//   kick 'max-tokens'  - output budget exhausted on this boundary, full
//                        stop. No content-shape check on the final
//                        message: kind === 'max-tokens' is the API
//                        reporting that THIS generation was cut off by
//                        the token budget, never a model-chosen stop, so
//                        it is never evidence of a deliberately complete
//                        turn (a message can contain reasoning plus a
//                        short trailing text block and still be an
//                        unfinished, budget-cut halt). A genuine
//                        long-answer-that-happens-to-land-on-the-cap
//                        coincidence is real but rare, and costs less
//                        than the false negative it avoids: an unwanted
//                        kick self-resolves in one round trip (the model
//                        says so and the next turn/end is 'completed',
//                        which resets the runaway counter); a missed kick
//                        leaves a session silently stuck with no signal.
//   none               - completed / aborted / error boundaries (auto-
//                        continuing over an explicit Stop fights the
//                        user; blind retry on error loops against broken
//                        backends), tails already followed by a
//                        user/assistant message (recovered manually or
//                        otherwise), empty sessions, disabled flavors,
//                        and any other/unrecognized reason kind (logged,
//                        never guessed at).
//
// Runaway guard: a max-tokens kick can itself produce another max-tokens
// halt (model re-thinks into the same wall). Per-session consecutive-kick
// counting: after maxConsecutiveKicks (default 3) with no completed turn
// or genuine (non-plugin) user message in between, the plugin stops
// kicking and logs loudly - surfacing the failure instead of silently
// burning GPU-hours against a task genuinely too big for its budget.
// Counters reset whenever a completed turn or genuine user message is
// observed at the tail.
//
// Scope guard: sessions with origin 'subagent' (or delegationDepth > 0)
// are skipped by default (includeSubagents=false). Auto-kicking a
// delegated child fights the parent orchestrator's own delegation/retry
// flow.
//
// Reason-aware prompts: an 'interrupted' kick asks the model to continue
// from where it left off (it never got going). A 'max-tokens' kick
// explicitly forbids re-deriving the lost reasoning, demands immediate
// concrete action, and asks for succinctness, because a naive "please
// continue" invites another long think-cycle straight back into the wall.
//
// Every decision - kicks AND skips - is logged with its reason, so the
// next "why didn't the plugin fire" question is answerable from
// `docker logs dsh | grep continue-kicker` instead of session-file
// archaeology.
//
// Config:
//   cooldownMs           (default 60000) - min time between kicks for
//                         the same session id.
//   liveKickDelayMs      (default 3000)  - delay between a live kickable
//                         turn/end and the tail re-analysis/kick.
//   maxConsecutiveKicks  (default 3)     - runaway guard, see above.
//   kickOnInterrupted    (default true)
//   kickOnMaxTokens      (default true)
//   includeSubagents     (default false) - see scope guard above.

import { createUserMessage } from '@deepseek-ai/dsh-llm'

const PLUGIN_NAME = 'continue-kicker'

const CONTINUE_TEXTS = {
  interrupted:
    'The previous turn was interrupted before producing a response. Please continue from where you left off.',
  'max-tokens':
    'Your previous response hit the output token limit before finishing. Do NOT re-derive your thinking from scratch: briefly state your conclusion, then immediately take your next concrete action (make the tool call or give the answer). Be succinct - long reasoning is what hit the limit last time.',
}

const KICKABLE_KINDS = ['interrupted', 'max-tokens']

// Classifies the tail of a session's event array. Returns
// { action: 'kick', flavor } or { action: 'none', why }, plus optional
// signals the caller uses for bookkeeping:
//   completedTurn       - tail boundary is a completed turn (reset signal)
//   genuineUserActivity - a non-plugin-sourced user message sits at the
//                         tail (reset signal; also the "already
//                         recovered" exclusion)
function analyzeTail(events, config) {
  if (!events || events.length === 0) return { action: 'none', why: 'empty session' }

  let boundary = null
  let boundaryIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'user/message') {
      const src = e.data?.message?.source ?? {}
      const genuine = !(src.kind === 'plugin' && src.plugin === PLUGIN_NAME)
      return {
        action: 'none',
        why: genuine ? 'tail has a genuine user message (recovered or active)' : 'tail has a plugin kick awaiting its result',
        genuineUserActivity: genuine,
      }
    }
    if (e.type === 'assistant/message') {
      // An assistant message after the last boundary we haven't reached
      // yet: mid-turn activity or an unusual replay shape. Not our job.
      return { action: 'none', why: 'tail has an assistant message after the last turn/end' }
    }
    if (e.type === 'turn/end') {
      boundary = e
      boundaryIdx = i
      break
    }
  }
  if (!boundary) return { action: 'none', why: 'no turn/end found' }

  const kind = boundary.data?.reason?.kind
  if (kind === 'completed') return { action: 'none', why: 'last turn completed', completedTurn: true }
  if (kind === 'aborted') return { action: 'none', why: 'last turn aborted by user' }
  if (kind === 'error') return { action: 'none', why: 'last turn errored' }
  if (!KICKABLE_KINDS.includes(kind)) return { action: 'none', why: `unhandled reason kind '${kind}'` }

  if (kind === 'interrupted') {
    if (!config.kickOnInterrupted) return { action: 'none', why: 'kickOnInterrupted disabled' }
    return { action: 'kick', flavor: 'interrupted' }
  }

  // kind === 'max-tokens': the API is reporting this generation was cut
  // off by the output budget, never a model-chosen stop, so no
  // content-shape check on the final message is needed (see header).
  if (!config.kickOnMaxTokens) return { action: 'none', why: 'kickOnMaxTokens disabled' }
  return { action: 'kick', flavor: 'max-tokens' }
}

export default function continueKicker(ctx, config = {}) {
  const cooldownMs = config.cooldownMs ?? 60000
  const liveKickDelayMs = config.liveKickDelayMs ?? 3000
  const maxConsecutiveKicks = config.maxConsecutiveKicks ?? 3
  const fullConfig = {
    cooldownMs,
    liveKickDelayMs,
    maxConsecutiveKicks,
    kickOnInterrupted: config.kickOnInterrupted ?? true,
    kickOnMaxTokens: config.kickOnMaxTokens ?? true,
    includeSubagents: config.includeSubagents ?? false,
  }
  const log = ctx.logger(PLUGIN_NAME)

  const lastKick = new Map() // sessionId -> timestamp of last kick
  const consecutive = new Map() // sessionId -> consecutive plugin kicks since last reset signal
  const pendingTimers = new Map() // sessionId -> scheduled re-analysis timer
  const scopeSkipped = new Set() // sessionIds already logged as scope-excluded

  function isSubagent(agent) {
    if (fullConfig.includeSubagents) return false
    const hdr = agent.session?.header ?? {}
    return hdr.origin === 'subagent' || (hdr.delegationDepth ?? 0) > 0
  }

  function maybeKick(agent, trigger) {
    try {
      const sessionId = agent.id
      const events = agent.session?.events
      const verdict = analyzeTail(events, fullConfig)

      // Reset signals first, whatever the verdict.
      const st = consecutive.get(sessionId) ?? 0
      if (verdict.completedTurn || verdict.genuineUserActivity) {
        if (st > 0) consecutive.set(sessionId, 0)
      }

      if (isSubagent(agent)) {
        if (!scopeSkipped.has(sessionId)) {
          scopeSkipped.add(sessionId)
          log.info('skip %s (%s) - subagent session excluded (includeSubagents=false)', sessionId, verdict.why)
        }
        return
      }

      if (verdict.action !== 'kick') {
        log.info('%s: no kick on %s - %s', trigger, sessionId, verdict.why)
        return
      }

      if (consecutive.get(sessionId) >= maxConsecutiveKicks) {
        log.error(
          '%s: NOT kicking %s - %d consecutive plugin kicks without progress (runaway guard, maxConsecutiveKicks=%d). This session needs human attention.',
          trigger, sessionId, consecutive.get(sessionId), maxConsecutiveKicks,
        )
        return
      }

      const now = Date.now()
      const last = lastKick.get(sessionId) ?? 0
      if (now - last < cooldownMs) {
        log.info('%s: skip %s - within cooldown (%dms remaining)', trigger, sessionId, cooldownMs - (now - last))
        return
      }
      lastKick.set(sessionId, now)

      const flavor = verdict.flavor
      if (flavor === 'max-tokens') {
        consecutive.set(sessionId, (consecutive.get(sessionId) ?? 0) + 1)
      }

      const message = createUserMessage({
        content: [{ type: 'text', text: CONTINUE_TEXTS[flavor] }],
        source: {
          kind: 'plugin',
          plugin: PLUGIN_NAME,
          form: 'notice',
          summary:
            flavor === 'max-tokens'
              ? `Auto-resumed after a max-tokens halt (${consecutive.get(sessionId)}/${maxConsecutiveKicks})`
              : 'Auto-resumed after an interrupted turn',
        },
      })

      agent.followup(message)
      log.info('%s: kicked session %s (flavor=%s, consecutive=%d)', trigger, sessionId, flavor, consecutive.get(sessionId) ?? 0)
    } catch (err) {
      log.error('%s: failed to kick session %s: %s', trigger, agent?.id, err?.stack ?? err)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      const sessionId = agent.id

      // Live watcher: this agent's own session firehose (same stream
      // dsh-agent-loop consumes). ANY live turn/end schedules one delayed
      // re-analysis (see header: a completed turn/end must reach
      // maybeKick too, or the runaway-guard counter never gets its reset
      // signal); newer events replace the pending timer so a busy session
      // isn't double-kicked mid-activity.
      const onSessionEvent = (_subject, event) => {
        try {
          if (event?.type !== 'turn/end') return
          const existing = pendingTimers.get(sessionId)
          if (existing) clearTimeout(existing)
          const timer = setTimeout(() => {
            pendingTimers.delete(sessionId)
            if (agent.disposed) return
            maybeKick(agent, 'live')
          }, liveKickDelayMs)
          pendingTimers.set(sessionId, timer)
        } catch (err) {
          log.error('live watcher error for %s: %s', sessionId, err?.stack ?? err)
        }
      }
      agent.ctx.on('session/event', onSessionEvent)

      ctx.on('agent/disposed', ({ agent: dead }) => {
        if (dead.id !== sessionId) return
        const timer = pendingTimers.get(sessionId)
        if (timer) clearTimeout(timer)
        pendingTimers.delete(sessionId)
        lastKick.delete(sessionId)
        consecutive.delete(sessionId)
        scopeSkipped.delete(sessionId)
      })

      maybeKick(agent, 'created')
    } catch (err) {
      log.error('agent/created handler failed for %s: %s', agent?.id, err?.stack ?? err)
    }
  })

  log.info(
    'continue-kicker active (cooldownMs=%d, liveKickDelayMs=%d, maxConsecutiveKicks=%d, kickOnInterrupted=%s, kickOnMaxTokens=%s, includeSubagents=%s)',
    cooldownMs, liveKickDelayMs, maxConsecutiveKicks,
    fullConfig.kickOnInterrupted, fullConfig.kickOnMaxTokens, fullConfig.includeSubagents,
  )
}
