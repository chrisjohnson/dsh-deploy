// model-switch: a real switch_model tool call ends in SUCCESS, with no
// INVALID_TOOL_OUTPUT (a tool output the host rejects), and the session carries
// on under the new model. The switch also becomes the lab's default model,
// which is fine in a lab and is why this module runs after the other model ones.
import { completedTurns, ensureWorkspace, newSession, openLab, send, transcript, waitFor, waitTurn } from '../lib.mjs'

export const meta = { needs: ['dsh-model-switch'], model: true, timeout: 400_000 }

const currentModel = async (page) =>
  /Select model, current ([^,]+)/.exec((await page.locator('[aria-label^="Select model"]').first().getAttribute('aria-label')) ?? '')?.[1]

export async function run(ctx) {
  const { env } = ctx
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-scratch')
    await ctx.check('switch_model succeeds and the session continues on the new model', async () => {
      await newSession(page, 'lab-scratch')
      const from = await currentModel(page)
      // Any other model that is up will do; medium-moe is the one the lab expects.
      const to = from === 'medium-moe' ? 'big-moe' : 'medium-moe'
      const before = await completedTurns(page)
      await send(
        page,
        `Call the switch_model tool exactly once with provider "local-ai-machine", model "${to}" and message "Reply with exactly: switched-ok". Do not do anything else first.`
      )
      await waitTurn(page, before, { timeout: 300_000 })
      // The tool hands the message to the new model at once, which is a second turn.
      await waitFor(async () => (await page.getByText('switched-ok', { exact: true }).count()) > 0, { timeout: 240_000, what: 'the new model to answer switched-ok' })
      const text = await transcript(page)
      await s.shot('model-switch')
      if (/INVALID_TOOL_OUTPUT/.test(text)) throw new Error('the switch_model result was rejected as INVALID_TOOL_OUTPUT')
      if (!/switch_model|Switch model|Model switched/i.test(text)) throw new Error('no switch_model call is visible in the transcript')
      if (/Model switched[^\n]*(fail|error|refus)/i.test(text)) throw new Error('the switch reports a failure')
      const now = await currentModel(page)
      if (now !== to) throw new Error(`the session shows model ${now}, expected ${to}`)
      return `${from} -> ${now}, success, no INVALID_TOOL_OUTPUT`
    })
  } finally {
    await s.close()
  }
}
