// completion: a new session on the lab's default model answers a trivial
// instruction. Uses the real local models (cheap: one short turn).
import { completedTurns, ensureWorkspace, newSession, openLab, send, transcript, waitFor, waitTurn } from '../lib.mjs'

export const meta = { model: true, timeout: 300_000 }

export async function run(ctx) {
  const { env } = ctx
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-scratch')
    await newSession(page, 'lab-scratch')

    await ctx.check('a new session replies exactly smoke-ok on the default model', async () => {
      const before = await completedTurns(page)
      await send(page, 'Reply with exactly: smoke-ok')
      const ms = await waitTurn(page, before)
      // The user's own message contains "smoke-ok" inside a longer line; the
      // reply is the element whose whole text is exactly it.
      await waitFor(async () => (await page.getByText('smoke-ok', { exact: true }).count()) > 0, { timeout: 15_000, what: 'a reply that is exactly smoke-ok' })
      await s.shot('completion-reply')
      const text = await transcript(page)
      const model = /Select model, current ([^,]+)/.exec(await page.locator('[aria-label^="Select model"]').first().getAttribute('aria-label') ?? '')?.[1]
      if (/Failed|Error/i.test(text.split('Completed')[0] ?? '') && !/smoke-ok/.test(text)) throw new Error('the turn reported an error')
      return `turn completed in ${(ms / 1000).toFixed(0)}s on ${model ?? 'the default model'}`
    })

    await ctx.check('no console errors during the turn', async () => {
      if (s.problems.length > 0) throw new Error(s.problems.slice(0, 3).join(' // '))
    })
  } finally {
    await s.close()
  }
}
