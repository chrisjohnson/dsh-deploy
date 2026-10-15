// scheduled-queue: a message scheduled in session A stays in A. It is not listed
// in session B, and when it falls due it is delivered into A (and only A).
// The lab never copies production's queue, so nothing real can be delivered.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bodyText, completedTurns, composer, ensureWorkspace, newSession, openLab, send, sleep, transcript, waitFor, waitTurn } from '../lib.mjs'

export const meta = { needs: ['dsh-scheduled-queue'], model: true, timeout: 420_000 }

export async function run(ctx) {
  const { env } = ctx
  const queueFile = join(env.dshHome, 'storages', 'scheduled-queue.json')
  const marker = `sq-marker-${Date.now().toString(36)}`
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-scratch')

    // Session A needs to exist on the server, so give it a first turn.
    await newSession(page, 'lab-scratch')
    const first = await completedTurns(page)
    await send(page, 'Reply with exactly: queue-A')
    await waitTurn(page, first)

    await ctx.check('scheduling in session A records the item', async () => {
      await composer(page).click()
      await page.keyboard.type(marker)
      await page.locator('button[title="Schedule this message"]').click()
      const dialog = page.locator('[role=dialog]').filter({ hasText: 'Schedule message' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.locator('input[type=number]').fill('1')
      await dialog.getByRole('button', { name: 'Schedule' }).click()
      await waitFor(() => existsSync(queueFile) && readFileSync(queueFile, 'utf8').includes(marker), { timeout: 20_000, what: 'the item in scheduled-queue.json' })
      await s.shot('scheduled-queue-a')
      return 'queued for 1 minute'
    })

    await ctx.check('the item is not listed in another session', async () => {
      await newSession(page, 'lab-scratch')
      await sleep(2500)
      await composer(page).click()
      if ((await bodyText(page)).includes(marker)) throw new Error('session B shows the item scheduled in session A')
      await s.shot('scheduled-queue-b')
      return 'session B shows nothing queued'
    })

    await ctx.check('the item fires into session A, not B', async () => {
      // Back to A, then wait for the delivery as a user message in its transcript.
      const bBefore = (await bodyText(page)).includes(marker)
      await page.getByText(/^Reply with exactly: queue-A/).filter({ visible: true }).first().click()
      await waitFor(
        async () => {
          const text = await transcript(page)
          return text.split(marker).length > 1 && /Completed in/.test(text.slice(text.indexOf(marker)))
        },
        { timeout: 240_000, interval: 2000, what: 'the scheduled message to arrive in session A and its turn to finish' }
      )
      await s.shot('scheduled-queue-fired')
      if (bBefore) throw new Error('the item had appeared in session B')
      const left = existsSync(queueFile) ? readFileSync(queueFile, 'utf8') : ''
      if (left.includes(marker)) throw new Error('the item was delivered but is still in the queue file')
      return 'delivered into A; queue file no longer holds it'
    })
  } finally {
    await s.close()
  }
}
