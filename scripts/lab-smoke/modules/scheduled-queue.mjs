// scheduled-queue: a message scheduled in session A stays in A. It is not listed
// in session B, and when it falls due it is delivered into A (and only A).
// The lab never copies production's queue, so nothing real can be delivered.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bodyText, completedTurns, composer, ensureWorkspace, newSession, openLab, readSessionEvents, send, sessionInfo, sleep, transcript, waitFor, waitTurn } from '../lib.mjs'

export const meta = { needs: ['dsh-scheduled-queue'], model: true, timeout: 420_000 }

export async function run(ctx) {
  const { env } = ctx
  const queueFile = join(env.dshHome, 'storages', 'scheduled-queue.json')
  const queue = () => (existsSync(queueFile) ? JSON.parse(readFileSync(queueFile, 'utf8') || '[]') : [])
  const marker = `sq-marker-${Date.now().toString(36)}`
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  const list = (sessionId) =>
    page.evaluate(
      async (id) => (await fetch('/api/scheduledQueue/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id }) })).json(),
      sessionId
    )
  /**
   * The rail shows a session's generated title, which lands asynchronously after
   * the first turn, so a row cannot be found by the prompt that started it. Read
   * the title back from the session's own log and open it the way the other
   * modules do.
   */
  let sessionA = null
  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-scratch')

    // Session A needs a first turn so it exists on the server and has a sidebar row.
    await newSession(page, 'lab-scratch')
    const first = await completedTurns(page)
    await send(page, 'Reply with exactly: queue-A')
    await waitTurn(page, first)

    await ctx.check('scheduling in session A records the item against A', async () => {
      await composer(page).click()
      await page.keyboard.type(marker)
      await page.locator('button[title="Schedule this message"]').click()
      await page.getByText('Schedule message', { exact: true }).waitFor({ timeout: 10_000 })
      await page.locator('input[type=number]').fill('1')
      await page.getByRole('button', { name: 'Schedule', exact: true }).click()
      const item = await waitFor(() => queue().find((i) => i.text === marker), { timeout: 20_000, what: 'the item in scheduled-queue.json' })
      sessionA = item.sessionId
      await s.shot('scheduled-queue-a')
      const mine = await list(sessionA)
      if (!JSON.stringify(mine).includes(marker)) throw new Error(`the list for session A does not return the item: ${JSON.stringify(mine).slice(0, 200)}`)
      return `queued for 1 minute against ${sessionA}`
    })
    if (sessionA === null) return

    await ctx.check('the item fires into session A', async () => {
      // Session A is still the open session here: the rail labels a row with the
      // title the model generated for it, which lands asynchronously, so coming
      // back to a row by its label is not a reliable way to reopen it.
      const turnsBefore = await completedTurns(page)
      await waitFor(async () => (await transcript(page)).includes(marker), {
        timeout: 240_000,
        interval: 2000,
        what: 'the scheduled message to arrive in session A'
      })
      await waitTurn(page, turnsBefore, { timeout: 240_000 })
      if (queue().some((i) => i.text === marker)) throw new Error('the item was delivered but is still in the queue file')
      const infoA = sessionInfo(env, sessionA)
      const file = infoA && ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd'].map((f) => join(infoA.dir, f)).find((f) => existsSync(f))
      const onDisk = file ? readSessionEvents(file).some((e) => e.type === 'user/message' && JSON.stringify(e).includes(marker)) : false
      if (!onDisk) throw new Error('the delivered message is on screen but not recorded as a user message in A log')
      await s.shot('scheduled-queue-fired')
      return 'delivered into A as a user message and answered; the queue no longer holds it'
    })

    await ctx.check('the item is not listed for another session', async () => {
      // Another real session: any other session directory the lab holds.
      const root = join(env.dshHome, 'sessions')
      const other = readdirSync(root)
        .flatMap((d) => readdirSync(join(root, d)))
        .find((n) => n.startsWith('session-') && n !== sessionA)
      if (!other) throw new Error('the lab holds no other session to ask about')
      const theirs = await list(other)
      if (JSON.stringify(theirs).includes(marker)) throw new Error(`the list for ${other} returned session A's item`)
      const none = await list('')
      if (none.ok !== false) throw new Error('a list call that names no session was answered instead of refused')
      const infoB = sessionInfo(env, other)
      const fileB = infoB && ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd'].map((f) => join(infoB.dir, f)).find((f) => existsSync(f))
      if (fileB && readSessionEvents(fileB).some((e) => e.type === 'user/message' && JSON.stringify(e).includes(marker))) {
        throw new Error(`the item was delivered into ${other} as well as session A`)
      }
      // And the UI: a different session's composer shows no dock entry for it.
      await newSession(page, 'lab-scratch')
      await sleep(2000)
      if ((await page.locator('.sq-dock').filter({ hasText: marker }).count()) > 0) throw new Error('session B shows the item in its scheduled-messages dock')
      await s.shot('scheduled-queue-b')
      return `${other} lists nothing of it, holds no copy of it; a call naming no session is refused; B's dock is empty`
    })
  } finally {
    await s.close()
  }
}
