// semantic-loop-kicker: a host-plane Cordis plugin for the `web` profile.
//
// "System 1" stuck-signal. Before each agent step it produces a STUCK /
// WORKING verdict with confidence, so the operator (or a future
// model-escalation consumer) can see - from one readable record per check -
// that a session is stuck. Precision over recall: a false positive derails a
// productive session; a false negative costs minutes.
//
// Two layers (mirrored by the offline harness at scratch/wd-tune/wd-tune.mjs):
//   1. DETERMINISTIC FINGERPRINT FAST PATH (no LLM, no GPU): over a wide raw
//      event tail, hash (tool name, normalized args) of every tool call and
//      look for repetition with NO new information (count>=3 with <=1 distinct
//      result, or count>=5 with <=2). That is a stuck signal by definition -
//      it cannot hallucinate confidence.
//   2. LLM ADJUDICATION for everything else: the model judges whether the
//      recent window produced NEW information (a fact, a result that differs,
//      a completed step) or re-ran work that already failed. medium-moe via
//      direct litellm fetch, thinking disabled via chat_template_kwargs.
//
// Every check appends one JSON line to /tmp/semantic-loop-kicker-decisions.jsonl
// carrying verdict, confidence, band, matched fingerprints, and the transcript
// window - the single readable place a future escalation consumer reads.
//
// The optional in-session intervention (off by default) is ONE consumer of
// the signal, not its purpose: it steers the current step (agent.steer,
// next-step) with a non-destructive prompt, only in the "stuck" band, at most
// once per cooldown window.
//
// Intercepts the `agent/pre-step` waterfall (dsh-agent-loop, dispatched before
// every model step - exactly "before text generation").
//
// ================================================================
// DIAGNOSTIC LOGGING GUIDE
// Each stage below logs at a distinct level/tag so you can grep for exactly
// which stage is (or isn't) firing. Look for these markers in the logs:
//
//   [X] "MODULE EVALUATE"        -> top-level module import succeeded
//   [A] "PLUGIN LOADED"          -> Stage A: apply() called
//   [B] "BEFORE-STEP FIRED"      -> Stage B: event listener triggered
//   [C] "SENDING TO MODEL"       -> Stage C: request hit the LLM API
//   [D] "MODEL RESPONSE"         -> Stage D: response came back
//   [E] "DECISION:"              -> Stage E: verdict + action taken
//   [X] "ERROR" / "FATAL"        -> Any error at any stage
// ================================================================

const PLUGIN_NAME = 'semantic-loop-kicker'

// ================================================================
// FILE-BASED LOGGING
// The DSH process redirects stdout/stderr to a Unix domain socket (not the
// journal), so ctx.logger lines are hard to see externally. We write a copy
// of every log line to a file we can tail, in addition to the console.
// ================================================================
import { appendFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
const LOG_FILE = '/tmp/semantic-loop-kicker.log'

function fileLog(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.map(a => String(a)).join(' ')}`
    appendFileSync(LOG_FILE, line + '\n')
  } catch {
    // best effort - if file writing fails we still have the console
  }
}

// Wrapper that logs to BOTH console AND file.
// NOTE: the old version took a single `msg` arg, so multi-arg calls silently
// dropped everything after the first argument in the file log. This version
// accepts ...args and joins them (console.log already handles multiple args).
function logBoth(...args) {
  console.log(...args)
  fileLog(...args)
}

// v3 (harness-tuned 2026-09-25: 30/33, 0 false positives on 11 real-session
// anchors): centered on "did the window produce NEW information", not on
// "do the actions look similar". Similar-looking commands with new results
// are progress; re-run failures with no new results are stuck.
const WATCHDOG_PROMPT =
  "You are a watchdog judging whether an AI agent is stuck. Its recent actions are shown with each tool call's result. The question is not whether the actions look similar, but whether this window produced NEW information: a new file read, a new symbol or error surfaced, a result that differs from earlier ones, or a step completing its purpose. Progress = actions that change what the agent knows or the state of the work, even when the commands look alike. Stuck = re-running work that already failed or returned nothing new: identical searches with the same empty or failing results, the same question re-asked, or steps that add no new fact. " +
  'Reply with EXACTLY one of these two forms, where N is an integer 0-100 for how sure you are: LOOP:N or PROGRESS:N. Example: LOOP:72. Output nothing else.'

// Non-destructive: a false positive here tells a WORKING agent to abandon
// its strategy (the 12-fire history is the reason precision comes first).
// Instead: name the suspected repetition, ask for what has been established,
// and ask for the single cheapest falsifying check.
const INTERVENTION_MESSAGE =
  '[WATCHDOG NOTE]: A pattern check flagged possible repetition in your recent steps (same actions, no new results). Do not treat this as a verdict. In one short paragraph, state what you have established so far, then take the single cheapest check that could falsify your current approach - or tell the operator what is blocking you.'

// One JSON line per check: verdict, confidence, band, matched fingerprints,
// transcript window, latency, outcome. The single readable place for future
// consumers (model escalation, UI indicator, re-plan prompt).
const DECISIONS_FILE = '/tmp/semantic-loop-kicker-decisions.jsonl'

function logDecision(record) {
  try {
    appendFileSync(DECISIONS_FILE, JSON.stringify(record) + '\n')
  } catch {
    // best effort
  }
}

// Extract a human-readable summary line from a session event for the transcript.
// Session events have the shape { type, data }, where user/assistant messages
// carry data.message with a content block array:
//   { type: 'text', text }, { type: 'reasoning', text },
//   { type: 'tool-call', name, ... }, { type: 'tool-result', ... },
//   { type: 'file', ... }
// (dsh-session stores tool-call blocks with type "tool-call"; a few callers
// also emit "tool_call", so we accept both.)
function summarizeEvent(e) {
  if (!e || typeof e !== 'object') return `[raw] ${String(e)}`

  // Turn-boundary events - show them compactly so we can spot repeating boundaries.
  if (e.type === 'turn/start') return `[turn/start #${e.data?.turn ?? '?'}]`
  if (e.type === 'turn/end') return `[turn/end reason=${e.data?.reason?.kind ?? '?'}]`

  // Extract the message payload (session envelope: data.message).
  const msg = e.data?.message ?? e
  let role = e.role ?? msg?.role ?? e.type ?? 'unknown'
  // Normalize from event type when role is not yet set.
  if (role === 'unknown') {
    if (e.type === 'user/message') role = 'user'
    else if (e.type === 'assistant/message') role = 'assistant'
    else if (e.type === 'tool/message') role = 'tool'
    else role = String(e.type)
  }

  let text = ''
  const content = msg?.content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (!block) continue
      if (block.type === 'text') parts.push(String(block.text ?? ''))
      else if (block.type === 'reasoning') {
        const len = String(block.text ?? '').length
        parts.push(`[reasoning ${len} chars]`)
      } else if (block.type === 'tool-call' || block.type === 'tool_call') {
        const name = block.name ?? block.toolName ?? 'unknown'
        const args = block.arguments ?? block.args ?? ''
        parts.push(`${name}(${String(args).slice(0, 80)})`)
      } else if (block.type === 'tool-result') {
        // Real shape: {type:'tool-result', content: string | [{type:'text',text}]}
        const c = block.content ?? block.output ?? block.result ?? ''
        const out = Array.isArray(c)
          ? c.map((x) => (typeof x === 'string' ? x : String(x?.text ?? ''))).join(' ')
          : String(c)
        parts.push(`[tool result: ${out.slice(0, 80)}]`)
      } else if (block.type === 'file') {
        parts.push(`[file: ${block.name ?? block.path ?? '?'}]`)
      } else {
        parts.push(`[${block.type}]`)
      }
    }
    text = parts.join(' ')
  } else if (typeof content === 'string') {
    text = content
  } else if (content != null) {
    text = String(content)
  }

  if (text.length > 300) text = text.slice(0, 300) + '...'
  return `[Role: ${role}] ${text || '[non-text event]'}`
}

// Harness lifecycle events that carry no agent decision-making. They are
// emitted by turn boundaries, process restarts (synthetic `turn/end
// reason=interrupted`), and inbox splices (continue-kicker and any other
// kicker's injections). When they dominate the last-N window they read to
// the classifier as a repeating pattern - the main source of false LOOP
// verdicts - so they are filtered out before the transcript is built.
const NOISE_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'session/end-seed',
  'agent/inbox/spliced',
  'request/header',
  'system/message',
  'llm/retry',
  'llm/retry-started',
])

function isSubstantive(e) {
  if (!e || typeof e !== 'object') return false
  if (NOISE_EVENT_TYPES.has(e.type)) return false
  const msg = e.data?.message ?? e
  const content = msg?.content
  if (Array.isArray(content)) {
    return content.some((b) => {
      if (!b) return false
      if (b.type === 'tool-call' || b.type === 'tool_call' || b.type === 'tool-result' || b.type === 'file') return true
      if (b.type === 'text' && String(b.text ?? '').trim().length > 0) return true
      return false
    })
  }
  return typeof content === 'string' && content.trim().length > 0
}

// ================================================================
// DETERMINISTIC FINGERPRINT FAST PATH (no LLM, no GPU)
// The discriminating axis is failure + lack of new information, NOT
// repetition. Hash (tool name, normalized args) over a wide raw tail and
// flag repetition that carries no new information:
//   count >= 3 and <= 1 distinct result (includes all-empty), or
//   count >= 5 and <= 2 distinct results.
// This cannot hallucinate confidence, and it is the primary trigger: the
// LLM only adjudicates windows the fast path did not settle.
// Mirrored by scratch/wd-tune/wd-tune.mjs (keep in sync).
// ================================================================
function normArgs(a) {
  return String(a ?? '').replace(/\s+/g, ' ').trim()
}

// Extract {name, args, result} per tool call from RAW events. tool/call
// events are the canonical per-call records (callId, name, arguments);
// tool/result events carry toolCallId + content. Match by id.
function extractCalls(events) {
  const calls = []
  const byId = new Map()
  for (const e of events) {
    if (e.type === 'tool/call') {
      const c = { id: e.data?.callId, name: e.data?.name ?? 'unknown', args: normArgs(e.data?.arguments ?? ''), result: '' }
      calls.push(c)
      if (c.id) byId.set(c.id, c)
    }
  }
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    const c0 = e.data?.message?.content?.[0]
    const cid = c0?.toolCallId
    const raw = Array.isArray(c0?.content)
      ? c0.content.map((x) => (typeof x === 'string' ? x : String(x?.text ?? ''))).join(' ')
      : String(c0?.content ?? c0?.output ?? c0?.text ?? '')
    const target = cid ? byId.get(cid) : undefined
    if (target) target.result = raw.trim().slice(0, 200)
  }
  for (const c of calls) c.result = (c.result ?? '').slice(0, 200)
  return calls
}

function fingerprintReport(events) {
  const groups = new Map()
  for (const c of extractCalls(events)) {
    const fp = `${c.name}|${c.args.slice(0, 120)}`
    if (!groups.has(fp)) groups.set(fp, { fp, count: 0, results: new Set() })
    const g = groups.get(fp)
    g.count++
    g.results.add(c.result || '(empty)')
  }
  const stuck = []
  for (const g of groups.values()) {
    const d = g.results.size
    if ((g.count >= 3 && d <= 1) || (g.count >= 5 && d <= 2)) {
      stuck.push({ fp: g.fp, count: g.count, distinctResults: d })
    }
  }
  return { stuck }
}

// ================================================================
// LENIENT VERDICT PARSER
// The model (and the old prompt) have produced "LOOP:72", "VERDICT:LOOP",
// "LOOP 72", "LOOP" (no number), and {"verdict","confidence"} JSON. Parse
// all of them; a bare verdict gets confidence null (band 'noise').
// Mirrored by scratch/wd-tune/wd-tune.mjs (keep in sync).
// ================================================================
function parseVerdict(raw) {
  if (!raw) return { verdict: null, confidence: null, inferred: false }
  const t = String(raw).trim()
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t)
      const v = String(o.verdict ?? o.label ?? '').toUpperCase()
      const c = Number(o.confidence ?? o.score ?? NaN)
      if (v === 'PROGRESS' || v === 'LOOP') {
        return { verdict: v, confidence: Number.isFinite(c) ? Math.min(100, Math.max(0, c)) : null, inferred: !Number.isFinite(c) }
      }
    } catch {
      // fall through to token scan
    }
  }
  const vm = t.match(/(PROGRESS|LOOP)/i)
  if (!vm) return { verdict: null, confidence: null, inferred: false }
  const verdict = vm[1].toUpperCase()
  const cm = t.slice(vm.index + vm[0].length).match(/[:=\s]*(\d{1,3})/)
  if (cm) return { verdict, confidence: Math.min(100, parseInt(cm[1], 10)), inferred: false }
  return { verdict, confidence: null, inferred: true }
}

// ================================================================
// TOP-LEVEL MODULE GUARD
// If this file fails to evaluate at all, Cordis logs 'import' errors.
// We also log here so file-based logging works even before ctx.logger.
// ================================================================
logBoth('[X] MODULE EVALUATE: semantic-loop-kicker.mjs loaded by import()')

export default {
  // Hard dependencies: Cordis will NOT call apply() until 'sessions' is
  // available in this context. The loader fiber stays INACTIVE until it
  // appears. We no longer depend on 'llm' (we call litellm directly via
  // fetch with reasoning: false to disable the thinking phase).
  inject: ['sessions'],

  apply(ctx, config = {}) {
    // Wrap the ENTIRE body in try/catch so a silent throw is still logged.
    try {
      // Config (EntryOptions.config - validated by the loader before arrival).
      const cooldownMs = config?.cooldownMs ?? 30000
      const maxTranscriptLines = config?.maxTranscriptLines ?? 6
      const includeSubagents = config?.includeSubagents ?? false
      // Default LOG-ONLY: intervention is opt-in while we tune the
      // classifier. Verdicts + confidence are always logged to the file log.
      const interventionEnabled = config?.interventionEnabled ?? false
      const watchdogTimeoutMs = config?.watchdogTimeoutMs ?? 25000
      // Raw-tail size for the fingerprint fast path. A 6-line LLM window is
      // too small for an alternating loop to reach N=3; ~60 raw events cover
      // ~15 tool calls. The fast path is deterministic (no GPU), so the
      // wider window costs nothing.
      const fpWindowEvents = config?.fpWindowEvents ?? 60
      // Busy-yield: if the previous LLM check for this session took longer
      // than this, the backend is saturated by the session's own work - a
      // supervisor that competes with the thing it supervises is a net loss.
      // Skip (with a distinguishable log line) instead of queueing.
      const busyYieldMs = config?.busyYieldMs ?? 15000
      // Confidence bands: >= stuck -> actionable; >= watch -> gentle band;
      // below watch -> log only. (A bare verdict with no confidence lands in
      // 'noise'.)
      const bandStuck = config?.bandStuck ?? 90
      const bandWatch = config?.bandWatch ?? 70
      const log = ctx.logger(PLUGIN_NAME)

      function bandOf(confidence) {
        if (confidence == null) return 'noise'
        if (confidence >= bandStuck) return 'stuck'
        if (confidence >= bandWatch) return 'watch'
        return 'noise'
      }

      const cfgSummary = { cooldownMs, maxTranscriptLines, includeSubagents, interventionEnabled, watchdogTimeoutMs, fpWindowEvents, busyYieldMs, bandStuck, bandWatch }
      logBoth('[A] PLUGIN LOADED: semantic-loop-kicker applied. config=', JSON.stringify(cfgSummary))
      log.info('[A] PLUGIN LOADED: semantic-loop-kicker applied. config=%j', cfgSummary)

      // Verify the service we depend on is actually available.
      const sessionsService = ctx.get('sessions')
      if (!sessionsService) {
        const errorMsg = '[X] PLUGIN FAILED: ctx.get(\'sessions\') returned undefined - the sessions service is not available in this context!'
        logBoth(errorMsg)
        log.error(errorMsg)
      } else {
        logBoth('[A] sessions service found; snapshotEvents=', typeof sessionsService.prototype?.snapshotEvents, ' sendMessage=', typeof sessionsService.sendMessage)
        log.info('[A] sessions service found: snapshotEvents=%s sendMessage=%s', typeof sessionsService.prototype?.snapshotEvents, typeof sessionsService.sendMessage)
      }

      // Last watchdog-check timestamp per session id (cooldown gate).
      const lastCheck = new Map()
      // Last LLM-check latency per session id (busy-yield gate).
      const lastLlmLatency = new Map()

      // Scope guard: skip subagent sessions unless includeSubagents is true.
      // (dsh-scope: subagent sessions carry header.origin === 'subagent' or
      //  header.delegationDepth > 0; same check used by continue-kicker.)
      function isSubagent(session) {
        if (includeSubagents) return false
        const hdr = session?.header ?? {}
        return hdr.origin === 'subagent' || (hdr.delegationDepth ?? 0) > 0
      }

      // Classify the trajectory with medium-moe in non-autoregressive mode.
      //
      // medium-moe is a thinking model (enable_thinking ON by default,
      // controlled via chat_template kwargs). The dsh-llm `llm.stream()`
      // pipeline CANNOT disable thinking on this backend:
      //   - `reasoningEffort: 'off'` → chat-template path → `!!'off'` = true
      //     → enable_thinking: true (thinking stays ON).
      //   - `reasoning: false` → ignored by pi-ai's buildParams (it only
      //     reads reasoningEffort, not reasoning).
      // The only working wire field is `chat_template_kwargs:
      // {enable_thinking: false}` sent directly to litellm. So we call
      // litellm directly via fetch for this classification call.
      async function classifyTrajectory(transcript) {
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort()
          logBoth('[C] watchdog classification timed out after', watchdogTimeoutMs, 'ms')
        }, watchdogTimeoutMs)
        const start = Date.now()

        // Build the OpenAI chat-completions payload that litellm expects.
        const body = {
          model: 'medium-moe',
          max_tokens: 128,
          temperature: 0.0,
          // medium-moe's thinking is controlled by the chat_template
          // `enable_thinking` toggle (NOT the `reasoning`/`reasoning_effort`
          // fields, which this backend ignores).
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: 'system', content: WATCHDOG_PROMPT },
            { role: 'user', content: transcript },
          ],
        }

        logBoth('[C] SENDING TO MODEL - session:', ctx?.fiber?.name ?? '?')
        logBoth('[C] MODEL REQUEST PAYLOAD:')
        logBoth('[C]   endpoint: http://127.0.0.1:4000/v1/chat/completions (litellm direct)')
        logBoth('[C]   model: medium-moe')
        logBoth('[C]   maxTokens: 128')
        logBoth('[C]   temperature: 0.0')
        logBoth('[C]   chat_template_kwargs: {enable_thinking: false} (disables thinking phase)')
        logBoth('[C]   system prompt:', WATCHDOG_PROMPT)
        logBoth('[C]   transcript (%d chars, %d lines):', transcript.length, transcript.split('\n').length)
        logBoth('[C]   --- TRANSCRIPT START ---')
        logBoth(transcript)
        logBoth('[C]   --- TRANSCRIPT END ---')
        log.info(
          '[C] SENDING TO MODEL: endpoint=litellm-direct model=medium-moe transcriptLength=%d transcriptLines=%d',
          transcript.length,
          transcript.split('\n').length,
        )

        let text = ''
        try {
          const res = await fetch('http://127.0.0.1:4000/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.LOCAL_AI_MACHINE_API_KEY ?? ''}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          })

          if (!res.ok) {
            const errBody = await res.text().catch(() => '(no body)')
            throw new Error(`litellm HTTP ${res.status}: ${errBody.slice(0, 300)}`)
          }

          const json = await res.json()
          const choice = json?.choices?.[0]
          text = choice?.message?.content ?? ''
          const reasoning = choice?.message?.reasoning_content
          logBoth(
            '[D] MODEL RESPONSE RECEIVED (took %dms, raw=%j, has_reasoning=%s):',
            Date.now() - start,
            text.trim(),
            reasoning !== undefined,
          )
          log.info(
            '[D] MODEL RESPONSE RECEIVED: took=%dms raw=%j has_reasoning=%s decision=%j',
            Date.now() - start,
            text.trim(),
            reasoning !== undefined,
            (text.trim().split(/[\s]/)[0] ?? '').toUpperCase(),
          )
        } catch (err) {
          // Fail open: log and return empty (decision will be 'unexpected').
          logBoth('[X] ERROR in classifyTrajectory: %s', err?.stack ?? err)
          log.error('[X] ERROR in classifyTrajectory: %s', err?.stack ?? err)
        } finally {
          clearTimeout(timer)
        }

        // Lenient parse (VERDICT:CONFIDENCE, VERDICT prefix, bare token, JSON).
        // Fail-open: a parse failure yields verdict null -> band 'noise',
        // logged distinctly as PARSE_FAIL, and the turn proceeds natively.
        const { verdict, confidence, inferred } = parseVerdict(text)
        if (verdict === null) {
          logBoth('[D] PARSE_FAIL - could not extract a verdict from raw=%j', text.trim())
          log.warn('[D] PARSE_FAIL: raw=%j', text.trim())
        }
        return { verdict, confidence, inferred, raw: text.trim(), latencyMs: Date.now() - start }
      }

      // Core watchdog check for one session.
      async function checkLoop(agent) {
        const session = agent?.session
        const sessionId = agent?.id

        // ================================================================
        // STAGE B: PLUGIN FIRING CHECK
        // Log every single time the listener fires, regardless of cooldown.
        // ================================================================
        logBoth(
          '[B] BEFORE-STEP FIRED for session:',
          sessionId,
          '| typeof agent=',
          typeof agent,
          '| snapshotEvents=',
          typeof session?.snapshotEvents,
        )
        log.info(
          '[B] BEFORE-STEP FIRED: session.id=%s (typeof agent=%s, snapshotEvents=%s)',
          sessionId,
          typeof agent,
          typeof session?.snapshotEvents,
        )

        try {
          // If the turn was already aborted, there is nothing to classify.
          if (session == null) {
            logBoth('[B] skip %s - no session on agent (turn already aborted?)', sessionId)
            log.info('[B] skip %s - no session on agent', sessionId)
            return
          }

          // Scope guard: skip subagent sessions.
          if (isSubagent(session)) {
            logBoth('[B] skip %s - subagent session excluded (includeSubagents=%s)', sessionId, includeSubagents)
            log.info('[B] skip %s - subagent session excluded (includeSubagents=%s)', sessionId, includeSubagents)
            return
          }

          // 1. Extract the recent trajectory. Filter to SUBSTANTIVE events only
          //    (real user/assistant/tool activity); turn-boundary and inbox-splice
          //    noise is excluded so continue-kicker and process restarts don't
          //    pollute the window. Scan the whole tail, keep the last N.
          const getEventsResult = session.snapshotEvents?.() ?? session.getEvents?.()
          const allEvents = Array.isArray(getEventsResult) ? getEventsResult : []
          const substantive = allEvents.filter(isSubstantive)
          const recentEvents = substantive.slice(-maxTranscriptLines)
          logBoth(
            '[B] session snapshot:',
            allEvents.length,
            'events ->',
            substantive.length,
            'substantive, taking last',
            recentEvents.length,
          )
          log.info(
            '[B] session snapshot: %d events -> %d substantive, taking last %d',
            allEvents.length,
            substantive.length,
            recentEvents.length,
          )

          // Not enough real activity to judge: skip WITHOUT consuming the
          // cooldown, so a later step with actual signal still gets checked.
          if (recentEvents.length < 2) {
            logBoth('[B] skip %s - only %d substantive events (need >= 2) - not enough signal', sessionId, recentEvents.length)
            log.info('[B] skip %s - only %d substantive events (need >= 2)', sessionId, recentEvents.length)
            return
          }

          // 2. Cooldown guard: don't check every turn in fast conversations.
          //    Checked AFTER the signal test so low-signal steps don't burn
          //    the cooldown.
          const now = Date.now()
          const last = lastCheck.get(sessionId) ?? 0
          const elapsed = now - last
          if (elapsed < cooldownMs) {
            logBoth('[B] COOLDOWN_SKIP %s (%dms elapsed < %dms cooldown, %dms remaining)', sessionId, elapsed, cooldownMs, cooldownMs - elapsed)
            log.info('[B] COOLDOWN_SKIP %s (%dms < %dms)', sessionId, elapsed, cooldownMs)
            return
          }

          const transcript = recentEvents.map(summarizeEvent).join('\n')

          // 3. DETERMINISTIC FINGERPRINT FAST PATH (no LLM, no GPU).
          //    Repetition with no new information is a stuck signal by
          //    definition - it cannot hallucinate confidence. A busy backend
          //    is no obstacle to a deterministic check, so this runs before
          //    the busy-yield gate.
          const { stuck: matchedFps } = fingerprintReport(allEvents.slice(-fpWindowEvents))

          let decision
          if (matchedFps.length > 0) {
            lastCheck.set(sessionId, now)
            decision = {
              source: 'fingerprint',
              verdict: 'LOOP',
              confidence: 99,
              raw: matchedFps.map((f) => `${f.fp.slice(0, 60)} x${f.count} d${f.distinctResults}`).join('; '),
              latencyMs: 0,
            }
            logBoth('[C] FAST PATH: deterministic stuck, no LLM call -', decision.raw)
            log.info('[C] FAST PATH: %d stuck fingerprints for %s', matchedFps.length, sessionId)
          } else {
            // 4. BUSY-YIELD: if the previous LLM check for this session was
            //    slow, the backend is saturated by the session's own work. A
            //    supervisor that competes with the thing it supervises is a
            //    net loss - skip with a distinguishable log line instead of
            //    queueing behind it. (Does not consume the cooldown.)
            const prevLatency = lastLlmLatency.get(sessionId)
            if (prevLatency != null && prevLatency > busyYieldMs) {
              logBoth('[B] BUSY_SKIP %s - previous LLM check took %dms (> %dms), yielding to backend', sessionId, prevLatency, busyYieldMs)
              log.info('[B] BUSY_SKIP %s (prev %dms > %dms)', sessionId, prevLatency, busyYieldMs)
              return
            }
            lastCheck.set(sessionId, now)

            // 5. LLM ADJUDICATION for genuinely ambiguous windows.
            //    Fail-open: wrapped in try/catch inside; PARSE_FAIL and
            //    TIMEOUT are logged distinctly there.
            const r = await classifyTrajectory(transcript)
            decision = { source: 'llm', ...r }
            lastLlmLatency.set(sessionId, r.latencyMs ?? 0)
          }
          const band = bandOf(decision.confidence)

          // 6. DECISION RECORD: one JSON line per check - verdict,
          //    confidence, band, matched fingerprints, transcript window,
          //    latency, outcome. The single readable place a future
          //    consumer (model escalation, UI indicator, re-plan prompt)
          //    reads from.
          const record = {
            ts: new Date().toISOString(),
            sessionId,
            source: decision.source,
            verdict: decision.verdict,
            confidence: decision.confidence,
            band,
            fingerprints: matchedFps.map((f) => ({ fp: f.fp, count: f.count, distinctResults: f.distinctResults })),
            latencyMs: decision.latencyMs ?? 0,
            window: transcript,
            outcome: 'logged',
          }

          // ================================================================
          // STAGE E: act (or log) on the decision.
          // Intervention (off by default) is ONE consumer of the signal, not
          // its purpose: only in the 'stuck' band, non-destructive text,
          // and the cooldown caps it at one action per cooldownMs per
          // session (the circuit breaker).
          // ================================================================
          if (decision.verdict === 'LOOP' && band === 'stuck' && interventionEnabled) {
            record.outcome = 'intervened'
            logBoth('[E] DECISION LOOP conf=%d band=stuck source=%s - STEERING session %s (fps: %s)', decision.confidence, decision.source, sessionId, decision.raw)
            log.warn('[E] DECISION LOOP conf=%d band=stuck source=%s - steering session %s', decision.confidence, decision.source, sessionId)
            try {
              const message = createUserMessage({
                content: [{ type: 'text', text: INTERVENTION_MESSAGE }],
                source: {
                  kind: 'plugin',
                  plugin: PLUGIN_NAME,
                  form: 'notice',
                  summary: 'Watchdog flagged repeated actions with no new results',
                },
              })
              // steer() splices into the CURRENT TURN's next step and wakes
              // the driver (dsh-agent-loop: send(input, 'next-step', true))
              // - immediate, not queued like followup() ('next-turn').
              agent.steer(message)
            } catch (injectErr) {
              record.outcome = 'intervene-error'
              logBoth('[E] ERROR injecting correction: %s', injectErr?.stack ?? injectErr)
              log.error('[E] ERROR injecting correction: %s', injectErr?.stack ?? injectErr)
            }
          } else {
            // LOG ONLY: the verdict + band + fingerprints are the product.
            const fpsShort = matchedFps.map((f) => `${f.fp.slice(0, 40)} x${f.count}`)
            logBoth(
              '[E] DECISION %s conf=%s band=%s source=%s fps=%j - session %s (intervention %s)',
              decision.verdict ?? 'UNPARSEABLE',
              decision.confidence ?? '-',
              band,
              decision.source,
              fpsShort,
              sessionId,
              interventionEnabled ? 'enabled, not stuck-band' : 'disabled')
            if (decision.verdict === 'LOOP') {
              log.warn('[E] DECISION LOOP conf=%s band=%s session %s', decision.confidence, band, sessionId)
            }
          }

          logDecision(record)
          log.info(
            '[E] decision recorded: %s conf=%s band=%s source=%s outcome=%s session %s',
            record.verdict, record.confidence, band, decision.source, record.outcome, sessionId,
          )
        } catch (err) {
          // Fail open: log a warning and let the main session turn proceed natively.
          logBoth('[X] ERROR in checkLoop for session %s: %s', sessionId, err?.stack ?? err)
          log.error('[X] ERROR in checkLoop for session %s: %s', sessionId, err?.stack ?? err)
        }
      }

      // Listen for the agent/pre-step waterfall (the real "before text generation"
      // hook in dsh-agent-loop). Contract: await next() first, then fire the
      // watchdog check without awaiting it, and return the decision - this never
      // blocks the turn and never breaks the waterfall chain (a listener that
      // does not call next() vetoes the built-in default, which would crash the
      // turn on decision.kind).
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        const decision = await next()
        checkLoop(agent).catch((err) => {
          logBoth('[X] Unhandled error in agent/pre-step handler for %s: %s', agent?.id, err?.stack ?? err)
          log.error('[X] Unhandled error in agent/pre-step handler: %s', err?.stack ?? err)
        })
        return decision
      })

      // Also log the event listener registration so we can confirm it's attached.
      logBoth('[A] Registered agent/pre-step event listener')
      log.info('[A] Registered agent/pre-step event listener')
    } catch (err) {
      // If the whole apply() body throws, we MUST log to the file because
      // ctx.logger may not be wired yet and console goes to the journal socket.
      const errLine = `[X] FATAL: apply() body threw: ${err?.stack ?? err}`
      try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${errLine}\n`) } catch {}
      console.error(errLine)
      throw err // re-throw so Cordis can report it via the 'apply' error path
    }
  }
}
