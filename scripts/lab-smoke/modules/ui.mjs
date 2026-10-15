// ui: the web UI loads, the sidebar and the plugin pages render, every right-
// sidebar tool opens, and nothing logs `slot entry crashed` or a React error.
import { bodyText, ensureWorkspace, newSession, openLab, sleep, waitFor } from '../lib.mjs'

export const meta = { timeout: 90_000 }

const SIDEBAR = ['New Session', 'Plugins', 'Automation tasks', 'Context Insights', 'Workspaces', 'Settings']

// Pages reachable from the sidebar and a string that only that page renders.
const PAGES = [
  { link: 'Context Insights', marker: /Tokens Used|Active Sessions/ },
  { link: 'Automation tasks', marker: /No tasks yet|New automation task/ }
]

// Right-sidebar tools this deployment ships (dsh-better-sidebar, dsh-context,
// dsh-loop-watchdog, dsh-better-git-worktree). A tool whose plugin is not
// mounted is skipped, not failed.
const TOOLS = [
  { tab: 'Files', needs: 'dsh-better-sidebar' },
  { tab: 'Context', needs: 'dsh-context' },
  { tab: 'Changes', needs: 'dsh-better-sidebar' },
  { tab: 'Tasks', needs: 'dsh-better-sidebar' },
  { tab: 'Worktree branch', needs: 'dsh-better-git-worktree' },
  { tab: 'Loop evals', needs: 'dsh-loop-watchdog' }
]

export async function run(ctx) {
  const { env } = ctx
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  try {
    await ctx.check('the app loads and the sidebar renders', async () => {
      await s.goto()
      await waitFor(async () => (await bodyText(page)).includes('Workspaces'), { timeout: 30_000, what: 'the sidebar' })
      const text = await bodyText(page)
      const missing = SIDEBAR.filter((t) => !text.includes(t))
      if (missing.length > 0) throw new Error(`sidebar is missing: ${missing.join(', ')}`)
      await s.shot('ui-home')
      return 'sidebar entries present'
    })

    await ctx.check('Plugins page lists every installed bundle', async () => {
      await page.getByText('Plugins', { exact: true }).first().click()
      // The two base bundles are not "installed plugins"; the rest are.
      const expected = ctx.bundles.filter((b) => b !== '@deepseek-ai/dsh-base' && b !== '@deepseek-ai/dsh-web-app').length
      await waitFor(async () => /Installed\s*\n?\s*\d+/.test(await bodyText(page)), { timeout: 20_000, what: 'the Installed list' })
      const shown = Number(/Installed\s*\n?\s*(\d+)/.exec(await bodyText(page))[1])
      await s.shot('ui-plugins')
      if (shown !== expected) throw new Error(`page says ${shown} installed, the profile lists ${expected}`)
      return `${shown} installed`
    })

    for (const { link, marker } of PAGES) {
      await ctx.check(`${link} page renders`, async () => {
        await page.getByText(link, { exact: true }).first().click()
        await waitFor(async () => marker.test(await bodyText(page)), { timeout: 20_000, what: `the ${link} page` })
        return 'rendered'
      })
    }

    await ctx.check('right-sidebar tools open without errors', async () => {
      await ensureWorkspace(env, page, 'lab-scratch')
      await newSession(page, 'lab-scratch')
      const toggle = page.getByRole('button', { name: 'Open right sidebar' })
      await waitFor(async () => (await toggle.count()) > 0, { timeout: 15_000, what: 'the right-sidebar toggle' })
      await toggle.click()
      await waitFor(async () => (await page.getByText('Start', { exact: true }).count()) > 0, { timeout: 15_000, what: 'the right sidebar' })
      const results = []
      // Each tool opens as its own tab; "New tab" gives a fresh Start page of tool cards.
      const visible = (text) => page.getByText(text, { exact: true }).filter({ visible: true })
      let first = true
      for (const tool of TOOLS) {
        if (!ctx.bundles.includes(tool.needs)) {
          results.push(`${tool.tab}: skipped (${tool.needs} not mounted)`)
          continue
        }
        if (!first) await page.getByRole('button', { name: 'New tab' }).click()
        first = false
        const card = visible(tool.tab).first()
        await waitFor(async () => (await card.count()) > 0, { timeout: 10_000, what: `the '${tool.tab}' tool card` })
        await card.click()
        await sleep(1500)
        if ((await page.locator('[data-slot-error]').count()) > 0) throw new Error(`'${tool.tab}' rendered a slot error`)
        await s.shot(`ui-tool-${tool.tab.replace(/ /g, '_')}`)
        results.push(`${tool.tab}: ok`)
      }
      return results.join('; ')
    })

    await ctx.check('no `slot entry crashed` or React errors in the console', async () => {
      const bad = s.problems.filter((p) => /slot entry crashed|Minified React error|pageerror/i.test(p))
      if (bad.length > 0) throw new Error(bad.slice(0, 3).join(' // '))
      return s.problems.length === 0 ? 'console clean' : `no crashes; ${s.problems.length} other console error(s): ${s.problems.slice(0, 2).join(' // ')}`
    })
  } finally {
    await s.close()
  }
}
