// loop-watchdog: the Loop evals panel renders a copied session's evaluations,
// and a real tool-using turn gets evaluated observe-only: the ledger gains rows
// for the session, a row carries the real tool-result text (not "[object
// Object]" or "undefined"), and the watchdog never steers (the lab runs it
// with intervention off).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Skip,
  bodyText,
  completedTurns,
  ensureWorkspace,
  newSession,
  openLab,
  openSession,
  send,
  sessionInfo,
  sleep,
  waitFor,
  waitTurn
} from '../lib.mjs'

export const meta = { needs: ['dsh-loop-watchdog'], timeout: 420_000 }

export async function run(ctx) {
  const { env } = ctx
  const ledger = join(env.dshHome, 'storages/semantic-loop-kicker/evaluations.jsonl')
  const rows = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const marker = `wd-${Date.now().toString(36)}`
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  const openPanel = async () => {
    await page.getByRole('button', { name: 'Open right sidebar' }).click().catch(() => {})
    await sleep(1000)
    await page.getByText('Loop evals', { exact: true }).filter({ visible: true }).first().click()
    await waitFor(async () => /Loop watchdog evaluations/.test(await bodyText(page)), { timeout: 20_000, what: 'the Loop evals panel' })
  }
  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-scratch')

    await ctx.check('the Loop evals panel renders a copied session with its evaluations', async () => {
      // The copied ledger has rows for real sessions; open the one with the most that the sidebar lists.
      const counts = new Map()
      for (const r of rows()) counts.set(r.sessionId, (counts.get(r.sessionId) ?? 0) + 1)
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => sessionInfo(env, id)).filter(Boolean)
      if (ranked.length === 0) throw new Skip('the lab holds no session that has ledger rows (was it started with --empty-data?)')
      let shown = null
      for (const info of ranked.slice(0, 12)) {
        if (!(await openSession(page, info))) continue
        await openPanel()
        const text = await bodyText(page)
        const match = /session ([0-9a-f]{8}) · (\d+) evaluations/.exec(text)
        if (match && Number(match[2]) > 0) {
          shown = `${match[2]} evaluations for session ${match[1]}`
          break
        }
      }
      await s.shot('loop-watchdog-panel')
      if (shown === null) throw new Skip('no ledgered session is listed in the sidebar')
      if ((await page.locator('[data-slot-error]').count()) > 0) throw new Error('the panel rendered a slot error')
      return shown
    })

    await newSession(page, 'lab-scratch')
    let mine = []
    await ctx.check('a tool-using turn appends rows to the evaluation ledger', async () => {
      ctx.needModel()
      const baseline = rows().length
      const before = await completedTurns(page)
      await send(page, `Run this exact shell command with the bash tool and then tell me what it printed: echo ${marker}`)
      await waitTurn(page, before, { timeout: 300_000 })
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
      ctx.needModel()
      const withWindow = mine.filter((r) => typeof r.window === 'string' && r.window.length > 0)
      if (withWindow.length === 0) throw new Error('no new row has a window (the watchdog skipped every step)')
      if (withWindow.some((r) => /\[object Object\]|\bundefined\b/.test(r.window))) throw new Error('a window holds an unrendered value')
      if (!withWindow.some((r) => r.window.includes(marker))) throw new Error(`no window contains the echoed marker ${marker}`)
      return 'the echoed marker appears in a window'
    })

    await ctx.check('the watchdog observed and did not steer', async () => {
      ctx.needModel()
      const steered = mine.filter((r) => r.outcome === 'intervened' || r.mode === 'act')
      if (steered.length > 0) throw new Error(`${steered.length} row(s) intervened or ran in act mode`)
      return `modes: ${[...new Set(mine.map((r) => r.mode))].join(', ')}; outcomes: ${[...new Set(mine.map((r) => r.outcome))].join(', ')}`
    })
  } finally {
    await s.close()
  }
}
