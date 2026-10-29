// continue-kicker: kill the lab server in the middle of a turn, start it again
// and reopen the session. The crash-orphaned turn must be kicked exactly once
// ("Please continue from where you left off."), not zero times and not in a
// loop. This module restarts the lab (SIGKILL, then a normal start).
//
// The session it reopens is identified by on-disk identity, not by its sidebar
// title: the sidebar shows a model-generated title, several runs share the same
// one, and clicking the first match can open an unrelated (or empty) session and
// report a kick that never happened. So the module records which session ids
// exist before it starts, works out which one it just created, and while the
// server is down for the kill it prunes the leftovers of earlier runs. After the
// restart exactly one matching row exists and the check reads that session.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { composer, ensureWorkspace, labSh, newSession, openLab, readSessionEvents, send, sleep, transcript, waitFor } from '../lib.mjs'

export const meta = { needs: ['dsh-continue-kicker'], model: true, timeout: 600_000 }

/** The lab's session directory for the throwaway `lab-scratch` workspace. */
function scratchDir(env) {
  const root = join(env.dshHome, 'sessions')
  if (!existsSync(root)) return null
  const name = readdirSync(root).find((entry) => entry.endsWith('-lab-scratch--'))
  return name === undefined ? null : join(root, name)
}

/** The session's own events, read from the lab's data. */
function sessionEvents(env, sessionId) {
  const file = join(scratchDir(env), sessionId, 'session.v4.jsonl.zstd')
  return existsSync(file) ? readSessionEvents(file) : []
}

/** How many kicks this plugin has written into the session's log. */
function countKicks(env, sessionId) {
  return sessionEvents(env, sessionId).filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'plugin:continue-kicker').length
}

const turnEndKinds = (env, sessionId) => sessionEvents(env, sessionId).map((e) => (e.type === 'turn/end' ? e.data?.reason?.kind : null)).filter(Boolean)

/** The title the sidebar shows for a session: the last one its log carries. */
function sessionTitle(env, sessionId) {
  let title
  for (const event of sessionEvents(env, sessionId)) {
    if (event.type === 'session/title' && event.data?.title) title = event.data.title
  }
  return title
}

/** The first user message text of a session, read straight from the lab's data. */
function firstPrompt(env, sessionId) {
  for (const event of sessionEvents(env, sessionId)) {
    if (event.type === 'user/message') {
      const block = (event.data?.content ?? []).find((item) => item?.type === 'text')
      if (block?.text) return block.text
    }
  }
  return ''
}

/**
 * Drop this module's leftovers from earlier runs so the reopen step has exactly
 * one candidate row. Safe because the server is stopped: nothing holds these
 * files open. The session this run killed is the newest by mtime and is kept;
 * a crashed session may not be flushed to disk until the next boot, so the
 * newest-by-mtime rule is applied only to what is there when the server is down.
 */
function pruneLeftovers(env) {
  const dir = scratchDir(env)
  if (dir === null) return { removed: 0, kept: null }
  const matching = readdirSync(dir)
    .filter((name) => name.startsWith('session-'))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .filter((entry) => {
      const prompt = firstPrompt(env, entry.name)
      return prompt === '' || /^Write the integers from 1/.test(prompt)
    })
    .sort((a, b) => b.mtime - a.mtime)
  const keep = matching.shift() ?? null
  for (const entry of matching) rmSync(join(dir, entry.name), { recursive: true, force: true })
  return { removed: matching.length, kept: keep?.name ?? null }
}

export async function run(ctx) {
  const { env } = ctx
  const titleStart = 'Write the integers from 1'

  {
    const s = await openLab(env)
    ctx.attach(s)
    try {
      await s.goto()
      await ensureWorkspace(env, s.page, 'lab-scratch')
      await ctx.check('start a long turn and kill the server in the middle of it', async () => {
        await newSession(s.page, 'lab-scratch')
        // The task has to keep generating INTO THE CHAT: a model that solves it
        // with one tool call and a short summary finishes long before the kill
        // lands, and then there is no interrupted turn to recover.
        await send(s.page, `${titleStart} to 4000, one per line, typed directly in your reply as the only text. Do not use any tool and do not write a file.`)
        // Streaming has started once a run of numbers is on screen.
        await waitFor(async () => /\b14\b[\s\S]*\b22\b/.test(await transcript(s.page)), { timeout: 180_000, what: 'the model to start streaming' })
        await s.shot('continue-kicker-streaming')
        if (/Completed in \d/.test(await transcript(s.page))) throw new Error('the turn finished before it could be interrupted; pick a longer task')
        const killed = await labSh(env, ['kill'])
        if (killed.code !== 0) throw new Error(`lab.sh kill exited ${killed.code}: ${killed.stderr || killed.stdout}`)
        // The server is down: clear the older same-titled leftovers so the reopen
        // step has exactly one row to click. The session just killed is the newest
        // on disk and is kept (if it is on disk yet at all).
        const pruned = pruneLeftovers(env)
        ctx.state.kickedSession = pruned.kept
        return `SIGKILL mid-stream; kept ${pruned.kept?.slice(0, 16) ?? 'the crashed session (not flushed yet)'}, pruned ${pruned.removed} leftover session(s) from earlier runs`
      })
    } finally {
      await s.close()
    }
  }

  await ctx.check('start the lab again', async () => {
    const r = await labSh(env, ['up'])
    if (r.code !== 0) throw new Error(`lab.sh up exited ${r.code}: ${(r.stderr || r.stdout).split('\n').slice(-6).join(' / ')}`)
    return 'running again, boot verification clean'
  })

  {
    const s = await openLab(env)
    ctx.attach(s)
    try {
      await s.goto()
      await ctx.check('reopening the session sends exactly one kick, and no more', async () => {
        const sessionId = ctx.state.kickedSession
        if (sessionId === null || sessionId === undefined) throw new Error('the kill step did not record which session it crashed')
        // Open the crashed session by the title its own log carries, so a sidebar
        // full of same-titled leftovers from other runs cannot be mistaken for it.
        const title = sessionTitle(env, sessionId)
        const rows = title === undefined
          ? s.page.getByText(/^Write (the )?integers/).filter({ visible: true })
          : s.page.getByText(title, { exact: true }).filter({ visible: true })
        if ((await rows.count()) === 0) {
          await s.page.getByText('lab-scratch', { exact: true }).filter({ visible: true }).first().click()
          await waitFor(async () => (await rows.count()) > 0, { timeout: 20_000, what: 'the killed session in the lab-scratch list' })
        }
        await rows.first().click()
        // Count from the session's own event log, not from the page: the
        // transcript is thousands of streamed numbers, the kick renders as a
        // collapsed notice, and scraping innerText made this check time out on a
        // session the plugin had demonstrably kicked.
        const kickCount = () => countKicks(env, sessionId)
        await waitFor(async () => kickCount() >= 1, { timeout: 120_000, what: 'the continue-kicker message in the session log' })
        await s.shot('continue-kicker-kicked')
        // The plugin's cooldown is 60 s: a second kick would show up inside this window.
        await sleep(75_000)
        const total = kickCount()
        if (total !== 1) throw new Error(`${total} kick messages in the session log, expected exactly 1`)
        return `exactly 1 kick in ${sessionId.slice(0, 16)}… (turn ends: ${turnEndKinds(env, sessionId).join(', ')}), none in the next 75 s`
      })
      // Stop the resumed generation so the lab is idle again.
      await s.page.locator('button[aria-label*="Stop" i], button[title*="Stop" i]').first().click({ timeout: 5000 }).catch(() => {})
      await composer(s.page).waitFor({ timeout: 5000 }).catch(() => {})
    } finally {
      await s.close()
    }
  }
}
