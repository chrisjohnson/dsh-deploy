// question-flow: dsh-kanban's per-ticket Questions decision, end to end (KAN-32).
//
// Scenario 1 (the guardrail): an *autonomous* ticket whose body requires the
// build session to call `ask_user_question` with a multiple-choice question
// before writing anything. The engine must answer that ask itself — first
// (recommended) option — record a `question_answered_autonomously` event, and
// carry the ticket through plan -> implement -> review -> approval without a
// human ever being asked. If the auto-answer is not wired, this ticket stalls
// on the question and never reaches the approval park, which is exactly the
// KAN-29 symptom the ticket was filed for.
//
// Scenario 2 (reload-safe drafts): the same ticket set to *interactive*, so its
// build-phase question must reach the human. The card is opened in the browser,
// an option is chosen but not submitted, the page is reloaded, and the selection
// must come back — on the card and in core's persisted draft store under the
// `question:<sessionId>:<callId>` key the tolerant tool passes. Then the answer
// is submitted and the turn must resume. This scenario depends on a model
// actually asking, so it reports SKIP (never a false PASS, and never a FAIL for
// the model's choice) when no question arrives.
//
// Both scenarios discard their tickets on the way out and write only into their
// own lab workspace; nothing here touches a real project checkout.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { openLab, openSession, readSessionEvents, sessionInfo, Skip, sleep, waitFor } from '../lib.mjs'

export const meta = { needs: ['dsh-kanban'], model: true, timeout: 1_500_000 }

const FIRST_OPTION = 'red (Recommended)'
const SECOND_OPTION = 'blue'
const NEEDLE = 'Which color'

/** The plan both tickets get, so planning itself never stalls on a question. */
const PLAN_INSTRUCTION = [
  'Plan exactly one step: the implementer creates color.txt in the workspace.',
  'The plan must carry one condition: `color-file` — color.txt exists and contains a color name,',
  'verified by `test -f color.txt`. Do not add other conditions.',
].join(' ')

/**
 * The body of a ticket whose *build* turn is required to ask the question.
 *
 * Both scenarios use it, and the difference between them is only the ticket's
 * Questions mode: a plan-phase option batch is auto-decided for every ticket,
 * so the build phase is the one place where `interactive` still means a human
 * is asked and `autonomous` means nobody is.
 */
function buildAskBody() {
  return [
    'Create a file named color.txt in the workspace containing exactly one color name.',
    '',
    'You MUST call the `ask_user_question` tool exactly once before writing the file, with exactly one question:',
    '',
    `- question: "${NEEDLE} should the file contain?"`,
    `- options: [{"label": "${FIRST_OPTION}"}, {"label": "${SECOND_OPTION}"}]`,
    '',
    'Do not skip that call and do not answer it yourself. After the tool returns, write the chosen color into color.txt.',
    'Do not create, edit or delete any other file.',
    '',
    PLAN_INSTRUCTION,
  ].join('\n')
}

// ------------------------------------------------------------------- plumbing --

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

/** Read one dsh session's durable event log out of the lab's DSH_HOME. */
function sessionEvents(env, sessionId) {
  const root = join(env.dshHome, 'sessions')
  if (!existsSync(root)) return []
  for (const ws of readdirSync(root)) {
    for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
      const file = join(root, ws, sessionId, name)
      if (existsSync(file)) return readSessionEvents(file)
    }
  }
  return []
}

/** The session a ticket's later phases ran in — its build session, newest first. */
function buildSession(detail) {
  const rows = (detail.sessions ?? []).filter((row) => (row.purpose ?? 'build') === 'build')
  const row = rows[rows.length - 1] ?? (detail.sessions ?? [])[0]
  if (row === undefined) return null
  return row.dshSessionId ?? row.sessionId ?? null
}

/**
 * Drive a ticket to a park, sampling every two seconds so a stall on a human
 * question is distinguishable from a fast unattended pass.
 */
async function driveUntilParked(rpc, ticketId, { timeoutMs }) {
  const samples = []
  const deadline = Date.now() + timeoutMs
  let detail = null
  for (;;) {
    detail = await rpc('ticket', { id: ticketId })
    samples.push({
      at: new Date().toISOString(),
      column: detail.ticket.column,
      phase: detail.ticket.phase,
      parked: detail.ticket.needsAttentionReason ?? null,
      awaitingQuestion: detail.awaitingQuestion === true,
    })
    if (detail.ticket.needsAttentionReason || detail.ticket.column === 'done' || detail.ticket.column === 'discarded') break
    if (Date.now() > deadline) {
      throw new Error(`ticket ${detail.ticket.key} never parked in ${Math.round(timeoutMs / 60000)} min (last: ${detail.ticket.column}/${detail.ticket.phase})`)
    }
    await sleep(2000)
  }
  const events = await rpc('events', { id: ticketId, limit: 500 })
  return { key: detail.ticket.key, ticket: detail.ticket, detail, events, samples }
}

/** The most recent ask_user_question call in a session carrying `needle`. */
function askedBatch(env, sessionId, needle) {
  for (const event of sessionEvents(env, sessionId).reverse()) {
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name ?? event.data?.call?.name
    if (name !== 'ask_user_question') continue
    let args = event.data?.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        continue
      }
    }
    const questions = Array.isArray(args?.questions) ? args.questions : []
    if (questions.some((q) => String(q?.question ?? '').includes(needle))) {
      return { callId: event.data?.callId ?? null, questions }
    }
  }
  return null
}

// ------------------------------------------------------------------ scenario 1 --

async function autonomousRunsUnattended(ctx, env, rpc, workspace) {
  const created = await rpc('create', {
    title: 'KAN-32 probe: an autonomous ticket answers its own option question',
    body: buildAskBody(),
    acceptance: ['color.txt exists in the workspace'],
    workspaceCwd: workspace,
    planTiming: 'now',
    planQuestions: 'autonomous',
    column: 'working',
  })
  const ticketId = created.ticket.id
  try {
    const run = await driveUntilParked(rpc, ticketId, { timeoutMs: 900_000 })

    await ctx.check('the autonomous ticket reached the approval park without ever waiting on a question', async () => {
      const reason = run.ticket.needsAttentionReason ?? ''
      if (!/Awaiting human approval/.test(reason)) {
        throw new Error(`parked as '${reason}' in ${run.ticket.column}/${run.ticket.phase}; expected the approval park`)
      }
      const waited = run.samples.filter((sample) => sample.awaitingQuestion)
      if (waited.length > 0) {
        throw new Error(`${waited.length} sample(s) showed the session waiting on a human question (first at ${waited[0].at}, phase ${waited[0].phase})`)
      }
      return `${run.key} parked '${reason}' over ${run.samples.length} samples, none waiting on a question`
    })

    await ctx.check('the engine answered the option batch with the first option and logged it', async () => {
      const answered = run.events.filter((e) => e.kind === 'question_answered_autonomously')
      if (answered.length === 0) {
        throw new Error(`no question_answered_autonomously event; kinds seen: ${[...new Set(run.events.map((e) => e.kind))].join(', ')}`)
      }
      const mine = answered.find((e) => JSON.stringify(e.payload?.answers ?? []).includes(FIRST_OPTION))
      if (mine === undefined) throw new Error(`no auto-answer selected '${FIRST_OPTION}': ${JSON.stringify(answered.map((e) => e.payload))}`)
      const answer = mine.payload.answers.find((a) => a.selected?.includes(FIRST_OPTION))
      if (answer.selected.length !== 1) throw new Error(`expected exactly one selected option, got ${JSON.stringify(answer.selected)}`)
      if (!('callId' in mine.payload)) throw new Error('the event carries no callId field')
      return `event ${mine.at} (phase ${mine.phaseFrom}): ${answer.id} -> ${JSON.stringify(answer.selected)}, callId ${mine.payload.callId}`
    })

    await ctx.check('the ask came from the session and the engine answered that very call', async () => {
      const sessionId = buildSession(run.detail)
      if (sessionId === null) throw new Error(`no session recorded for ${run.key}`)
      const batch = askedBatch(env, sessionId, NEEDLE)
      if (batch === null) throw new Error(`no ask_user_question call in session ${sessionId}`)
      const first = batch.questions[0]?.options?.[0]?.label
      if (first !== FIRST_OPTION) throw new Error(`the ask's first option was '${first}', not the recommended one`)
      const matched = run.events.filter((e) => e.kind === 'question_answered_autonomously' && e.payload?.callId === batch.callId)
      if (matched.length === 0) throw new Error(`the ask (callId ${batch.callId}) was not the one auto-answered`)
      return `session ${sessionId} offered [${batch.questions[0].options.map((o) => o.label).join(', ')}] and the engine answered its own call`
    })

    await ctx.check('the model carried on with the answer it was given', async () => {
      const file = join(workspace, 'color.txt')
      if (!existsSync(file)) throw new Error(`color.txt was never written (workspace ${workspace})`)
      const text = readFileSync(file, 'utf8').trim().toLowerCase()
      if (!text.includes('red')) throw new Error(`color.txt says '${text}', not the recommended red`)
      return `color.txt contains '${text}'`
    })
  } finally {
    await rpc('move', { id: ticketId, column: 'discarded', reason: 'question-flow smoke cleanup' }).catch(() => {})
  }
}

// ------------------------------------------------------------------ scenario 2 --

async function interactiveQuestionSurvivesReload(ctx, env, s, rpc, workspace) {
  const created = await rpc('create', {
    title: 'KAN-32 probe: an interactive ticket asks a human, and a draft survives a reload',
    body: buildAskBody(),
    acceptance: ['color.txt exists in the workspace'],
    workspaceCwd: workspace,
    planTiming: 'now',
    planQuestions: 'interactive',
    column: 'working',
  })
  const ticketId = created.ticket.id
  try {
    // Wait for a session of the ticket to sit on an unanswered ask. A model that
    // decides not to ask is not a defect, so this is a SKIP, never a FAIL.
    let detail = null
    try {
      detail = await waitFor(
        async () => {
          const d = await rpc('ticket', { id: ticketId })
          return d.awaitingQuestion === true ? d : null
        },
        { timeout: 420_000, interval: 2000, what: 'the interactive ticket to wait on a human question' }
      )
    } catch (error) {
      const now = await rpc('ticket', { id: ticketId })
      throw new Skip(
        `the interactive ticket never put a question in front of a human (${error.message}); ` +
          `it is at ${now.ticket.column}/${now.ticket.phase} '${now.ticket.needsAttentionReason ?? ''}'`
      )
    }

    const sessionId = buildSession(detail)
    if (sessionId === null) throw new Skip('the ticket waits on a question but records no session to open')
    const info = sessionInfo(env, sessionId)
    if (info === null) throw new Skip(`session ${sessionId} is not in the lab's data; cannot open its question card`)

    const opened = await openSession(s.page, { title: info.title, workspace: info.workspace })
    if (!opened) throw new Skip(`could not reopen session ${sessionId} ('${info.title}') from the sidebar`)

    const card = s.page.locator('[data-question-key]').first()
    await card.waitFor({ timeout: 30_000 })
    const key = await card.getAttribute('data-question-key')
    if (key === null || !key.startsWith(`question:${sessionId}:`)) {
      throw new Error(`the question card is keyed '${key}', not 'question:${sessionId}:<callId>' — the ask did not carry its call id`)
    }
    if ((await card.locator('[role="radio"], [role="checkbox"]').count()) === 0) {
      throw new Skip(`the question the model put in front of the human carries no options (${key}); nothing to select for the draft check`)
    }

    await ctx.check('choosing an option persists a draft under the call-keyed store entry', async () => {
      await card.locator('[role="radio"]').first().click()
      await waitFor(
        async () => {
          const raw = await s.page.evaluate(() => localStorage.getItem('dsh.user-questions.drafts.v1'))
          if (raw === null) return null
          const progress = JSON.parse(raw)?.progressByRequest?.[key]
          return progress !== undefined && JSON.stringify(progress).includes('red') ? progress : null
        },
        { timeout: 15_000, what: 'the draft store to record the selection' }
      )
      return `draft persisted under ${key}`
    })

    await ctx.check('a page reload restores the half-answered question', async () => {
      await s.page.reload({ waitUntil: 'domcontentloaded' })
      const again = s.page.locator(`[data-question-key="${key}"]`).first()
      await again.waitFor({ timeout: 30_000 })
      const checked = await again.locator('[role="radio"]').first().getAttribute('aria-checked')
      if (checked !== 'true') throw new Error(`after a reload the chosen option is not selected (aria-checked=${checked})`)
      const raw = await s.page.evaluate(() => localStorage.getItem('dsh.user-questions.drafts.v1'))
      if (raw === null || !raw.includes(key)) throw new Error('the draft store no longer names this question')
      return `the selection came back on the card and in localStorage for ${key}`
    })

    await ctx.check('submitting the answer resumes the turn', async () => {
      await s.page.getByRole('button', { name: 'Submit', exact: true }).last().click()
      await waitFor(
        async () => {
          const d = await rpc('ticket', { id: ticketId })
          return d.awaitingQuestion !== true ? d : null
        },
        { timeout: 60_000, what: 'the question to clear after the answer was submitted' }
      )
      return 'the ask was answered from the card and the session moved on'
    })
  } finally {
    await rpc('move', { id: ticketId, column: 'discarded', reason: 'question-flow smoke cleanup' }).catch(() => {})
  }
}

// ------------------------------------------------------------------------ run --

export async function run(ctx) {
  const { env } = ctx
  ctx.needModel()

  // The module proves the KAN-32 decision module, so the plugin under test has
  // to carry it: linked to a checkout that has it, or pinned at 0.18.0 or later.
  const installed = join(env.labDir, 'node_modules/dsh-kanban')
  if (!existsSync(join(installed, 'src/questions.mjs'))) {
    throw new Skip(`the lab's dsh-kanban has no src/questions.mjs — link or pin 0.18.0+ before running this module`)
  }
  const version = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version

  // Each scenario gets its own workspace: scenario 1 writes color.txt, and
  // scenario 2 must not pass on a file the first one left behind.
  const first = join(env.meta, 'home', 'lab-question-flow')
  const second = join(env.meta, 'home', 'lab-question-flow-interactive')
  mkdirSync(first, { recursive: true })
  mkdirSync(second, { recursive: true })

  {
    const s = await openLab(env)
    ctx.attach(s)
    try {
      await s.goto()
      const rpc = makeRpc(s.page)
      await ctx.check(`the lab runs dsh-kanban ${version} with the questions module`, async () => {
        const caps = await rpc('capabilities')
        if (caps === undefined || caps === null) throw new Error('capabilities returned nothing')
        return `dsh-kanban ${version}, board reachable over /api/kanban`
      })
      await autonomousRunsUnattended(ctx, env, rpc, first)
    } finally {
      await s.close()
    }
  }

  {
    const s = await openLab(env)
    ctx.attach(s)
    try {
      await s.goto()
      await interactiveQuestionSurvivesReload(ctx, env, s, makeRpc(s.page), second)
    } finally {
      await s.close()
    }
  }
}
