// continue-kicker: kill the lab server in the middle of a turn, start it again
// and reopen the session. The crash-orphaned turn must be kicked exactly once
// ("Please continue from where you left off."), not zero times and not in a
// loop. This module restarts the lab (SIGKILL, then a normal start).
import { composer, ensureWorkspace, labSh, newSession, openLab, send, sleep, transcript, waitFor } from '../lib.mjs'

export const meta = { needs: ['dsh-continue-kicker'], model: true, timeout: 600_000 }

const KICK = /continue from where you left off/gi
const kicks = async (page) => ((await transcript(page)).match(KICK) ?? []).length

export async function run(ctx) {
  const { env } = ctx
  let titleStart = 'Write the integers from 1'

  {
    const s = await openLab(env)
    ctx.attach(s)
    try {
      await s.goto()
      await ensureWorkspace(env, s.page, 'lab-scratch')
      await ctx.check('start a long turn and kill the server in the middle of it', async () => {
        await newSession(s.page, 'lab-scratch')
        await send(s.page, `${titleStart} to 4000, one per line, with no other text.`)
        // Streaming has started once a run of numbers is on screen.
        await waitFor(async () => /\b14\b[\s\S]*\b22\b/.test(await transcript(s.page)), { timeout: 180_000, what: 'the model to start streaming' })
        await s.shot('continue-kicker-streaming')
        if (/Completed in \d/.test(await transcript(s.page))) throw new Error('the turn finished before it could be interrupted; pick a longer task')
        const killed = await labSh(env, ['kill'])
        if (killed.code !== 0) throw new Error(`lab.sh kill exited ${killed.code}: ${killed.stderr || killed.stdout}`)
        return 'SIGKILL mid-stream'
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
        const row = s.page.getByText(new RegExp(`^${titleStart}`)).filter({ visible: true })
        if ((await row.count()) === 0) await s.page.getByText('lab-scratch', { exact: true }).filter({ visible: true }).first().click()
        await row.first().click()
        await waitFor(async () => (await kicks(s.page)) >= 1, { timeout: 90_000, what: 'the continue-kicker message' })
        await s.shot('continue-kicker-kicked')
        // The plugin's cooldown is 60 s: a second kick would show up inside this window.
        await sleep(75_000)
        const count = await kicks(s.page)
        if (count !== 1) throw new Error(`${count} kick messages in the transcript, expected exactly 1`)
        return 'one kick after the restart, none in the next 75 s'
      })
      // Stop the resumed generation so the lab is idle again.
      await s.page.locator('button[aria-label*="Stop" i], button[title*="Stop" i]').first().click({ timeout: 5000 }).catch(() => {})
      await composer(s.page).waitFor({ timeout: 5000 }).catch(() => {})
    } finally {
      await s.close()
    }
  }
}
