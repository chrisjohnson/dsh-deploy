// semantic-loop-kicker: a host-plane Cordis plugin for the `web` profile.
//
// "System 1" semantic loop watchdog. Before each agent turn, it snapshots the
// recent conversation trajectory and asks the main orchestrator model
// (medium-moe on local-ai-machine) to classify it in a single non-autoregressive
// pass as either PROGRESS or LOOP.
//
// ================================================================
// DIAGNOSTIC LOGGING GUIDE
// Each stage below logs at a distinct level/tag so you can grep for exactly
// which stage is (or isn't) firing. Look for these markers in the logs:
//
//   [X] "MODULE EVALUATE"        -> top-level module import succeeded
//   [A] "PLUGIN LOADED"          -> Stage A: apply() called
//   [B] "BEFORE-TURN FIRED"      -> Stage B: event listener triggered
//   [C] "SENDING TO MODEL"       -> Stage C: request hit the LLM API
//   [D] "MODEL RESPONSE"         -> Stage D: response came back
//   [E] "DECISION:"              -> Stage E: verdict + action taken
//   [X] "ERROR" / "FATAL"        -> Any error at any stage
// ================================================================

const PLUGIN_NAME = 'semantic-loop-kicker'

// ================================================================
// FILE-BASED LOGGING
// The DSH process redirects stdout/stderr to a Unix domain socket
// (not the journal), so logBoth/ctx.logger are hard to see.
// We write a copy of every log line to a file we can tail.
// ================================================================
import { appendFileSync } from 'node:fs'
const LOG_FILE = '/tmp/semantic-loop-kicker.log'
function fileLog(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}`
    appendFileSync(LOG_FILE, line + '\n')
  } catch {
    // best effort - if file writing fails, we still have console
  }
}

// Wrapper that logs to BOTH console AND file
function logBoth(msg) {
  console.log(msg)
  fileLog(msg)
}

const WATCHDOG_PROMPT =
  'You are a watchdog observing an AI agent. Analyze the last few actions. Is the agent making forward progress, or is it stuck in a semantic loop (repeating the same failed logic/tool calls with minor variations)? Reply ONLY with the exact word "PROGRESS" or "LOOP".'

const INTERVENTION_MESSAGE =
  '[WATCHDOG INTERVENTION]: You are stuck in a semantic loop. You have repeatedly tried this approach without success. YOU MUST ABANDON THIS STRATEGY entirely. Maybe choose a completely different tool or ask the user for clarification.'

// Extract a human-readable summary line from an event for the transcript.
function summarizeEvent(e) {
  const role = e.role ?? 'unknown'
  let content = e.content ?? ''
  // If the event has tool calls, append a compact representation.
  if (e.toolCalls && Array.isArray(e.toolCalls) && e.toolCalls.length > 0) {
    const toolSummary = e.toolCalls
      .map((t) => {
        if (typeof t === 'string') return t
        if (t && typeof t === 'object') {
          const name = t.name ?? t.toolName ?? 'unknown'
          const args = t.arguments ?? t.args ?? ''
          return `${name}(${typeof args === 'string' ? args.slice(0, 80) : JSON.stringify(args).slice(0, 80)})`
        }
        return String(t)
      })
      .join(' | ')
    content = content ? `${content} [tools: ${toolSummary}]` : `[tools: ${toolSummary}]`
  }
  // Truncate very long content to keep the prompt tight.
  if (content.length > 300) {
    content = content.slice(0, 300) + '...'
  }
  return `[Role: ${role}] ${content}`
}

// ================================================================
// TOP-LEVEL MODULE GUARD
// If this file fails to evaluate at all, Cordis logs 'import' errors.
// We also log here so file-based logging works even before ctx.logger.
// ================================================================
logBoth('[X] MODULE EVALUATE: semantic-loop-kicker.mjs loaded by import()')

export default {
  // Hard dependencies: Cordis will NOT call apply() until both 'llm' and
  // 'sessions' services are available in this context. The loader fiber
  // stays INACTIVE until they appear, so apply() only runs after the
  // services are registered.
  inject: ['llm', 'sessions'],

  apply(ctx, config = {}) {
    // ================================================================
    // STAGE A: PLUGIN LOADED
    // Wrap the ENTIRE body in try/catch so a silent throw is still logged.
    // ================================================================
    try {
      // NOTE: config is the 2nd arg from Cordis (EntryOptions.config).
      const cooldownMs = config?.cooldownMs ?? 30000
      const maxTranscriptLines = config?.maxTranscriptLines ?? 6
      const includeSubagents = config?.includeSubagents ?? false
      const interventionEnabled = config?.interventionEnabled ?? true
      const log = ctx.logger(PLUGIN_NAME)

      logBoth(
        '[A] PLUGIN LOADED: semantic-loop-kicker applied. config=',
        JSON.stringify({ cooldownMs, maxTranscriptLines, includeSubagents, interventionEnabled }),
        'ctx keys=',
        Object.keys(ctx),
      )
      log.info(
        '[A] PLUGIN LOADED: semantic-loop-kicker applied. config=%j (cooldownMs=%d, maxTranscriptLines=%d, includeSubagents=%s, interventionEnabled=%s)',
        { cooldownMs, maxTranscriptLines, includeSubagents, interventionEnabled },
        cooldownMs,
        maxTranscriptLines,
        includeSubagents,
        interventionEnabled,
      )

      // Verify the services we depend on are actually available.
      const llmService = ctx.get('llm')
      const sessionsService = ctx.get('sessions')
      if (!llmService) {
        const errorMsg = '[X] PLUGIN FAILED: ctx.get(\'llm\') returned undefined - the llm service is not available in this context!'
        logBoth(errorMsg)
        log.error(errorMsg)
        // Don't throw - let the plugin gracefully degrade rather than crash boot.
      } else {
        logBoth('[A] llm service found:', typeof llmService.chat)
        log.info('[A] llm service found: chat=%s', typeof llmService.chat)
      }
      if (!sessionsService) {
        const errorMsg = '[X] PLUGIN FAILED: ctx.get(\'sessions\') returned undefined - the sessions service is not available in this context!'
        logBoth(errorMsg)
        log.error(errorMsg)
      } else {
        logBoth('[A] sessions service found:', typeof sessionsService.sendMessage)
        log.info('[A] sessions service found: sendMessage=%s', typeof sessionsService.sendMessage)
      }

      const lastCheck = new Map() // sessionId -> timestamp of last watchdog check

      function isSubagent(session) {
        if (includeSubagents) return false
        const hdr = session?.header ?? {}
        return hdr.origin === 'subagent' || (hdr.delegationDepth ?? 0) > 0
      }

      async function checkLoop(session) {
        // ================================================================
        // STAGE B: PLUGIN FIRING CHECK
        // Log every single time the listener fires, regardless of cooldown.
        // ================================================================
        logBoth(
          '[B] BEFORE-TURN FIRED for session:',
          session?.id,
          '| typeof session=',
          typeof session,
          '| session.getEvents typeof=',
          typeof session?.getEvents,
        )
        log.info(
          '[B] BEFORE-TURN FIRED: session.id=%s (typeof session=%s, getEvents=%s)',
          session?.id,
          typeof session,
          typeof session?.getEvents,
        )

        try {
          // Scope guard: skip subagent sessions.
          if (isSubagent(session)) {
            logBoth('[B] skip %s - subagent session excluded (includeSubagents=%s)', session.id, includeSubagents)
            log.info('[B] skip %s - subagent session excluded (includeSubagents=%s)', session.id, includeSubagents)
            return
          }

          // Cooldown guard: don't check every turn in fast conversations.
          // Log the cooldown check explicitly so we know when we're skipping due to cooldown.
          const now = Date.now()
          const last = lastCheck.get(session.id) ?? 0
          const elapsed = now - last
          if (elapsed < cooldownMs) {
            logBoth('[B] skip %s - within cooldown (%dms elapsed < %dms cooldown, %dms remaining)', session.id, elapsed, cooldownMs, cooldownMs - elapsed)
            log.info('[B] skip %s - within cooldown (%dms elapsed < %dms cooldown, %dms remaining)', session.id, elapsed, cooldownMs, cooldownMs - elapsed)
            return
          }
          lastCheck.set(session.id, now)
          logBoth('[B] cooldown passed for %s (%dms elapsed >= %dms cooldown) - proceeding to model check', session.id, elapsed, cooldownMs)
          log.info('[B] cooldown passed for %s (%dms elapsed >= %dms cooldown) - proceeding to model check', session.id, elapsed, cooldownMs)

          // 1. Extract recent context (last N events to keep the prompt tight).
          const getEventsResult = session.getEvents?.()
          logBoth('[B] session.getEvents() returned:', getEventsResult ? `${getEventsResult.length} events` : 'null/undefined')
          log.info('[B] session.getEvents() returned %d events', getEventsResult?.length ?? 0)

          const recentEvents = (getEventsResult ?? []).slice(-maxTranscriptLines)
          const transcript = recentEvents.map(summarizeEvent).join('\n')

          if (!transcript) {
            logBoth('[B] skip %s - no events to analyze (transcript is empty)', session.id)
            log.info('[B] skip %s - no events to analyze (transcript is empty)', session.id)
            return
          }

          // ================================================================
          // STAGE C: CHECKS MAKING IT TO THE MODEL
          // Log the full request payload before sending it.
          // ================================================================
          logBoth('[C] SENDING TO MODEL - session:', session.id)
          logBoth('[C] MODEL REQUEST PAYLOAD:')
          logBoth('[C]   provider: local-ai-machine')
          logBoth('[C]   model: medium-moe')
          logBoth('[C]   maxTokens: 1')
          logBoth('[C]   temperature: 0.0')
          logBoth('[C]   system prompt:', WATCHDOG_PROMPT)
          logBoth('[C]   transcript (%d chars, %d lines):', transcript.length, transcript.split('\n').length)
          logBoth('[C]   --- TRANSCRIPT START ---')
          logBoth(transcript)
          logBoth('[C]   --- TRANSCRIPT END ---')
          log.info(
            '[C] SENDING TO MODEL: session=%s provider=local-ai-machine model=medium-moe maxTokens=1 temperature=0.0 transcriptLength=%d transcriptLines=%d',
            session.id,
            transcript.length,
            transcript.split('\n').length,
          )

          // 2. Query the MoE model in non-autoregressive mode.
          //    maxTokens: 1 + temperature: 0.0 forces a single-pass categorical
          //    decision (prefill-only classification), avoiding autoregressive
          //    generation overhead.
          const llmService = ctx.get('llm')
          if (!llmService) {
            throw new Error('[X] ctx.get(\'llm\') is undefined - cannot proceed with model check')
          }
          if (typeof llmService.chat !== 'function') {
            throw new Error('[X] ctx.get(\'llm\').chat is not a function (type=' + typeof llmService.chat + ') - cannot proceed with model check')
          }

          const chatStartTime = Date.now()
          const response = await llmService.chat({
            provider: 'local-ai-machine',
            model: 'medium-moe',
            messages: [
              { role: 'system', content: WATCHDOG_PROMPT },
              { role: 'user', content: transcript },
            ],
            maxTokens: 1,
            temperature: 0.0,
          })
          const chatElapsed = Date.now() - chatStartTime

          // ================================================================
          // STAGE D: CHECKS COMING BACK
          // Log the raw response from the model.
          // ================================================================
          logBoth(
            '[D] MODEL RESPONSE RECEIVED for session %s (took %dms):',
            session.id,
            chatElapsed,
          )
          logBoth('[D]   raw response structure:', response ? Object.keys(response) : 'null')
          if (response && response.choices) {
            logBoth('[D]   choices.length:', response.choices.length)
            if (response.choices[0]) {
              logBoth('[D]   choices[0].keys:', Object.keys(response.choices[0]))
              logBoth('[D]   choices[0].message:', JSON.stringify(response.choices[0].message))
            }
          }
          log.info(
            '[D] MODEL RESPONSE RECEIVED: session=%s took=%dms choices.length=%s',
            session.id,
            chatElapsed,
            response?.choices?.length,
          )

          const decision = response?.choices?.[0]?.message?.content?.trim()
          logBoth('[D] extracted decision:', JSON.stringify(decision))
          log.info('[D] extracted decision: %s', JSON.stringify(decision))

          // ================================================================
          // STAGE E: PLUGIN RESPONDING APPROPRIATELY
          // Log the decision and the action taken.
          // ================================================================
          if (decision === 'LOOP' && interventionEnabled) {
            logBoth('[E] DECISION: LOOP - injecting correction message into session %s', session.id)
            log.warn('[E] DECISION: LOOP - injecting correction message into session %s', session.id)
            const sessionsService = ctx.get('sessions')
            if (!sessionsService) {
              logBoth('[E] ERROR: ctx.get(\'sessions\') is undefined - cannot inject correction message')
              log.error('[E] ERROR: ctx.get(\'sessions\') is undefined - cannot inject correction message')
            } else if (typeof sessionsService.sendMessage !== 'function') {
              logBoth('[E] ERROR: ctx.get(\'sessions\').sendMessage is not a function (type=%s)', typeof sessionsService.sendMessage)
              log.error('[E] ERROR: ctx.get(\'sessions\').sendMessage is not a function (type=%s)', typeof sessionsService.sendMessage)
            } else {
              await sessionsService.sendMessage(session.id, {
                role: 'developer',
                content: INTERVENTION_MESSAGE,
              })
              logBoth('[E] DECISION: LOOP - correction message injected successfully into session %s', session.id)
              log.info('[E] DECISION: LOOP - correction message injected successfully into session %s', session.id)
            }
          } else if (decision === 'PROGRESS') {
            logBoth('[E] DECISION: PROGRESS - no action needed for session %s', session.id)
            log.info('[E] DECISION: PROGRESS - no action needed for session %s', session.id)
          } else {
            logBoth('[E] DECISION: unexpected verdict=%s (not PROGRESS or LOOP) - not acting for session %s', decision, session.id)
            log.info('[E] DECISION: unexpected verdict=%s (not PROGRESS or LOOP) - not acting for session %s', decision, session.id)
          }
        } catch (err) {
          // Fail open: log a warning and let the main session turn proceed natively.
          logBoth('[X] ERROR in checkLoop for session %s: %s', session?.id, err?.stack ?? err)
          log.error('[X] ERROR in checkLoop for session %s: %s', session?.id, err?.stack ?? err)
        }
      }

      // Listen for the agent/before-turn event.
      // Use ctx.on so the listener is automatically cleaned up when the plugin stops.
      ctx.on('agent/before-turn', (session) => {
        // Run asynchronously - don't block the turn.
        checkLoop(session).catch((err) => {
          logBoth('[X] Unhandled error in agent/before-turn handler for %s: %s', session?.id, err?.stack ?? err)
          log.error('[X] Unhandled error in agent/before-turn handler for %s: %s', session?.id, err?.stack ?? err)
        })
      })

      // Also log the event listener registration so we can confirm it's attached.
      logBoth('[A] Registered agent/before-turn event listener')
      log.info('[A] Registered agent/before-turn event listener')
    } catch (err) {
      // If the whole apply() body throws, we MUST log to the file because
      // ctx.logger may not be wired yet and console goes to the journal socket.
      const errLine = `[X] FATAL: apply() body threw: ${err?.stack ?? err}`
      try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${errLine}\n`) } catch {}
      console.error(errLine)
      throw err // re-throw so Cordis can report it via 'apply' error path
    }
  }
}
