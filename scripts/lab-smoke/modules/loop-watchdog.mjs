// loop-watchdog: observe-only evaluation of a real tool-using turn. The panel
// renders, the evaluation ledger gains rows for the session, the tool-result
// text in a row is the real output (not "[object Object]" or "undefined"), and
// the watchdog never steers (the lab runs it with intervention off).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { completedTurns, ensureWorkspace, newSession, openLab, send, sleep, waitFor, waitTurn } from '../lib.mjs'

export const meta = { needs: ['dsh-loop-watchdog'], model: true, timeout: 420_000 }

export async function run(ctx) {
  const { env } = ctx
  const ledger = join(env.dshHome, 'storages/semantic-loop-kicker/evaluations.jsonl')
  const rows = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const marker = `wd-${Date.now().toString(36)}`
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-scratch')
    const baseline = rows().length
    await newSession(page, 'lab-scratch')
    const before = await completedTurns(page)
    await send(page, `Run this exact shell command with the bash tool and then tell me what it printed: echo ${marker}`)
    await waitTurn(page, before, { timeout: 300_000 })

    let mine = []
    await ctx.check('the evaluation ledger gains rows for the session', async () => {
      mine = await waitFor(
        () => {
          const fresh = rows().slice(baseline)
          return fresh.length > 0 && fresh
        },
        { timeout: 60_000, what: 'new rows in the evaluation ledger' }
      )
      return `${mine.length} new row(s): ${[...new Set(mine.map((r) => r.outcome))].join(', ')}`
    })

    await ctx.check('a row carries the real tool-result text', async () => {
      const withWindow = mine.filter((r) => typeof r.window === 'string' && r.window.length > 0)
      if (withWindow.length === 0) throw new Error('no new row has a window (the watchdog skipped every step)')
      if (withWindow.some((r) => /\[object Object\]|\bundefined\b/.test(r.window))) throw new Error('a window holds an unrendered value')
      if (!withWindow.some((r) => r.window.includes(marker))) throw new Error(`no window contains the echoed marker ${marker}`)
      return 'the echoed marker appears in a window'
    })

    await ctx.check('the watchdog observed and did not steer', async () => {
      const steered = mine.filter((r) => r.outcome === 'intervened' || r.mode === 'act')
      if (steered.length > 0) throw new Error(`${steered.length} row(s) intervened or ran in act mode`)
      const modes = [...new Set(mine.map((r) => r.mode))]
      return `modes: ${modes.join(', ')}; outcomes: ${[...new Set(mine.map((r) => r.outcome))].join(', ')}`
    })

    await ctx.check('the Loop evals panel renders the session', async () => {
      await page.getByRole('button', { name: 'Open right sidebar' }).click().catch(() => {})
      await sleep(1000)
      await page.getByText('Loop evals', { exact: true }).filter({ visible: true }).first().click()
      await sleep(2500)
      await s.shot('loop-watchdog-panel')
      if ((await page.locator('[data-slot-error]').count()) > 0) throw new Error('the panel rendered a slot error')
      const text = await page.locator('body').innerText()
      if (!/PROGRESS|STUCK|LOOP|logged|evaluation|Eval|verdict/i.test(text.slice(text.indexOf('Loop evals')))) throw new Error('the panel shows no evaluation rows')
      return 'panel rendered with evaluation rows'
    })
  } finally {
    await s.close()
  }
}
