// ui: the web UI loads, the sidebar and the plugin pages render, every right-
// sidebar tool opens, and nothing logs `slot entry crashed` or a React error.
//
// The static checks above prove the page composes. The dynamic pass at the bottom
// (KAN-70) is the one that guards the regression a whole-page whiteout is: a
// plugin's slot entry that throws during render is caught by the renderer's
// SlotErrorBoundary, which logs `slot entry crashed in '<slotKey>'` and leaves an
// invisible empty <div> where the region was — and when the crash escapes every
// boundary the React root unmounts and the page goes white. That only shows up
// under real re-render pressure, so this pass puts some on: reopen a real session
// that carries workspace/changes events, cycle between sessions, and push a
// kanban board update, then assert the root is still rendered and nothing crashed.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { Skip, bodyText, ensureWorkspace, newSession, openLab, openSession, readSessionEvents, sidebarWorkspaces, sleep, waitFor } from '../lib.mjs'

export const meta = { timeout: 240_000 }

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

/**
 * Sessions in the lab's own copy of the data that are safe and useful to reopen:
 * the last turn ended cleanly (an interrupted one would make dsh-continue-kicker
 * run a fresh turn in that session's real workspace), and the transcript carries
 * at least one `workspace/changes` event, which is the reopen path that exercises
 * the file/changes panels. Titles must be unique in their workspace, or the
 * sidebar cannot be asked to open one.
 */
function reopenCandidates(env) {
  const root = join(env.dshHome, 'sessions')
  if (!existsSync(root)) return []
  const found = []
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws)
    if (!statSync(wsDir).isDirectory()) continue
    for (const name of readdirSync(wsDir)) {
      if (!name.startsWith('session-')) continue
      const file = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd'].map((f) => join(wsDir, name, f)).find((f) => existsSync(f))
      if (!file) continue
      const size = statSync(file).size
      if (size < 3000 || size > 600_000) continue
      let events
      try {
        events = readSessionEvents(file)
      } catch {
        continue
      }
      const end = [...events].reverse().find((e) => e.type === 'turn/end')
      const kind = end?.data?.reason?.kind
      if (kind !== 'completed' && kind !== 'aborted') continue
      if (!events.some((e) => e.type === 'workspace/changes')) continue
      const title = [...events].reverse().find((e) => e.type === 'session/title')?.data?.title
      const cwd = events[0]?.cwd
      if (!title || !cwd) continue
      found.push({ title, workspace: basename(cwd), mtime: statSync(file).mtimeMs })
    }
  }
  const key = (c) => `${c.workspace}\u0000${c.title}`
  const counts = new Map()
  for (const c of found) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1)
  return found.filter((c) => counts.get(key(c)) === 1).sort((a, b) => b.mtime - a.mtime)
}

/** The root must still be a rendered app: children present and text on screen. */
async function rootRendered(page) {
  return page.evaluate(() => {
    const root = document.getElementById('root')
    if (!root) return { ok: false, why: 'no #root element' }
    const text = (root.innerText || '').trim()
    if (root.childElementCount === 0) return { ok: false, why: '#root has no children' }
    if (text.length < 60) return { ok: false, why: `#root renders ${text.length} characters of text` }
    return { ok: true, why: `${root.childElementCount} child(ren), ${text.length} characters` }
  })
}

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

    await ctx.check('dynamic stress: real reopens, session cycling and a board update keep the root rendered', async () => {
      await s.goto()
      await waitFor(async () => (await sidebarWorkspaces(page)).length > 0, { timeout: 30_000, what: 'the sidebar' })
      const listed = await sidebarWorkspaces(page)
      const picks = reopenCandidates(env).filter((c) => listed.includes(c.workspace)).slice(0, 3)
      if (picks.length < 2) {
        throw new Skip(`only ${picks.length} clean session(s) with workspace/changes events in a listed workspace; nothing to cycle`)
      }
      const notes = []
      // 1. Reopen each one, checking the root after every load.
      for (const pick of picks) {
        const opened = await s.onError(`stress-${pick.title.slice(0, 20)}`, () => openSession(page, pick))
        if (!opened) {
          notes.push(`'${pick.title.slice(0, 24)}' not listed, skipped`)
          continue
        }
        await sleep(600)
        const after = await rootRendered(page)
        if (!after.ok) throw new Error(`the root went blank reopening '${pick.title}': ${after.why}`)
        notes.push(`reopened '${pick.title.slice(0, 24)}'`)
      }
      // 2. Cycle between them: the re-render pressure a hook-count change needs.
      for (let i = 0; i < 3; i++) {
        for (const pick of picks.slice(0, 2)) {
          await openSession(page, pick).catch(() => page.keyboard.press('Escape'))
          await sleep(300)
        }
      }
      notes.push('3 A/B cycles')
      // 3. Push a board update. Refresh re-reads and re-renders the live board
      // stream; creating a ticket is not safe here — with the kanban orchestrator
      // configured it would dispatch a real session off a smoke-test card.
      if (ctx.bundles.includes('dsh-kanban')) {
        await page.getByText('Kanban', { exact: true }).first().click()
        await waitFor(async () => (await bodyText(page)).includes('Board'), { timeout: 20_000, what: 'the board' })
        const refresh = page.getByRole('button', { name: 'Refresh' }).first()
        if ((await refresh.count()) > 0) {
          await refresh.click()
          await sleep(1500)
          notes.push('board refreshed')
        } else {
          notes.push('board had no Refresh button')
        }
      } else {
        notes.push('kanban not mounted, board step skipped')
      }
      const bad = s.problems.filter((p) => /slot entry crashed|Minified React error|slot factory occurrence crashed/i.test(p))
      if (bad.length > 0) throw new Error(`stress produced crash output: ${bad.slice(0, 2).join(' // ').slice(0, 300)}`)
      if ((await page.locator('[data-slot-error]').count()) > 0) throw new Error('a [data-slot-error] crash face is in the DOM')
      const final = await rootRendered(page)
      if (!final.ok) throw new Error(`the root is not rendered after the stress pass: ${final.why}`)
      await s.shot('ui-stress')
      return `${notes.join('; ')}; root ok (${final.why})`
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
