// Shared helpers for the lab smoke suite. Plain ESM, no build step.
//
// playwright-core is resolved from the LAB's node_modules (dsh-playwright-browser
// depends on it), so the suite adds no dependency to this repo. Chromium is the
// same binary the production service uses (PLAYWRIGHT_CHROME_PATH).
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function labEnv() {
  const labDir = process.env.LAB_DIR
  if (!labDir || !existsSync(join(labDir, '.lab'))) {
    throw new Error('LAB_DIR is not set to a lab directory; run the suite through scripts/lab.sh smoke')
  }
  return {
    labDir,
    name: process.env.LAB_NAME ?? 'default',
    port: Number(process.env.LAB_PORT ?? 3099),
    labSh: process.env.LAB_SH ?? '',
    labRoot: process.env.LAB_ROOT ?? '',
    pluginsDir: process.env.LAB_PLUGINS_DIR ?? '',
    prodHome: process.env.PROD_DSH_HOME ?? '',
    meta: join(labDir, '.lab'),
    dshHome: join(labDir, '.dsh')
  }
}

export function playwright(env) {
  const require = createRequire(join(env.labDir, 'package.json'))
  return require('playwright-core')
}

/** Access URL for the lab (token inside; never print it). */
export function accessUrl(env) {
  return readFileSync(join(env.meta, 'url'), 'utf8').trim()
}

export function redact(text) {
  return String(text).replace(/(token=)[A-Za-z0-9_-]+/g, '$1REDACTED')
}

/** Run lab.sh for another subcommand (restart, kill, ...) against this lab. */
export function labSh(env, args, { timeout = 300_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [env.labSh, ...args],
      { env: { ...process.env, LAB_NAME: env.name, LAB_ROOT: env.labRoot, LAB_PORT: String(env.port) }, timeout },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: redact(stdout), stderr: redact(stderr) })
    )
  })
}

/** Poll `fn` until it returns a truthy value or the timeout passes. */
export async function waitFor(fn, { timeout = 30_000, interval = 500, what = 'condition', fatal = () => false } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try {
      last = await fn()
      if (last) return last
    } catch (error) {
      if (fatal(error)) throw error
      last = error
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${Math.round(timeout / 1000)}s waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`)
    }
    await sleep(interval)
  }
}

/**
 * One browser session against the lab: console and page errors are collected,
 * and screenshots go to <lab>/.lab/smoke/shots.
 */
export async function openLab(env, { viewport = { width: 1500, height: 950 } } = {}) {
  const pw = playwright(env)
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH || undefined
  const browser = await pw.chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const problems = []
  const shots = join(env.meta, 'smoke', 'shots')
  mkdirSync(shots, { recursive: true })
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' || /slot entry crashed|Minified React error/i.test(text)) {
      problems.push(`${message.type()}: ${redact(text).slice(0, 400)}`)
    }
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${redact(String(error)).slice(0, 400)}`))
  const session = {
    browser,
    context,
    page,
    problems,
    shot: async (name) => {
      const path = join(shots, `${name}.png`)
      await page.screenshot({ path }).catch(() => {})
      return path
    },
    /** Run fn; if it throws, leave a screenshot named after `label` before rethrowing. */
    onError: async (label, fn) => {
      try {
        return await fn()
      } catch (error) {
        const path = await session.shot(`FAIL-${label.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 50)}`)
        if (error instanceof Error && !error.message.includes('[screenshot')) error.message += ` [screenshot: ${path}]`
        throw error
      }
    },
    goto: async () => {
      await page.goto(accessUrl(env), { waitUntil: 'domcontentloaded' })
      await dismissWelcome(page)
    },
    close: async () => {
      await browser.close().catch(() => {})
    }
  }
  return session
}

/** The first-run notice has a Continue button; click it if it is showing. */
export async function dismissWelcome(page) {
  const cont = page.getByRole('button', { name: 'Continue' })
  await cont.first().waitFor({ timeout: 6_000 }).then(() => cont.first().click()).catch(() => {})
}

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

/** Thrown inside a check to report SKIP (with the reason) instead of PASS or FAIL. */
export class Skip extends Error {}

/** A turn that ended in "This turn failed ..." (for example the model backend is down). */
export class TurnFailed extends Error {}

// ---------------------------------------------------------------------------
// UI helpers. Selectors prefer aria-labels and visible text; the few that are
// positional say so.
// ---------------------------------------------------------------------------
export const bodyText = (page) => page.locator('body').innerText()

/** Workspace names in the sidebar, read from the per-workspace action buttons. */
export async function sidebarWorkspaces(page) {
  const labels = await page.locator('[aria-label^="Workspace actions for "]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  return labels.map((l) => l.replace('Workspace actions for ', ''))
}

/**
 * Make `dirName` (a directory directly under the lab's throwaway HOME) a
 * workspace in the sidebar. The folder picker is rooted at HOME, which is why
 * every lab workspace lives there and never anywhere near production.
 */
export async function ensureWorkspace(env, page, dirName) {
  mkdirSync(join(env.meta, 'home', dirName), { recursive: true })
  const have = await sidebarWorkspaces(page)
  if (have.includes(dirName)) return
  await page.getByRole('button', { name: 'Add workspace' }).click()
  const dialog = page.locator('[role=dialog]')
  await dialog.locator('button', { hasText: dirName }).first().click()
  await dialog.locator('button', { hasText: 'Open' }).last().click()
  await waitFor(async () => (await sidebarWorkspaces(page)).includes(dirName), { timeout: 20_000, what: `workspace ${dirName} in the sidebar` })
}

export const composer = (page) => page.locator('[contenteditable=true], textarea').last()

/** Start a fresh session in `ws` (the hover-only "New session in" button, clicked by event). */
export async function newSession(page, ws) {
  await page.locator(`[aria-label="New session in ${ws}"]`).dispatchEvent('click')
  await composer(page).waitFor({ timeout: 15_000 })
}

export async function send(page, text) {
  const box = composer(page)
  await box.click()
  if (text.length > 200) await page.keyboard.insertText(text)
  else await page.keyboard.type(text)
  await sleep(200)
  await page.keyboard.press('Enter')
}

/** Number of finished turns shown in the open session ("Completed in 11s"). */
export async function completedTurns(page) {
  return ((await bodyText(page)).match(/Completed in \d/g) ?? []).length
}

/** Text of a failed turn ("This turn failed 500: ..."), if the open session shows one. */
export async function turnFailure(page) {
  const text = await bodyText(page)
  const at = text.lastIndexOf('This turn failed')
  return at === -1 ? null : text.slice(at, at + 400).replace(/\s+/g, ' ')
}

/**
 * Wait for one more finished turn than `before`; resolves with the turn's wall
 * time in ms. A failed turn (for example the model backend is down) throws at
 * once with the server's message instead of waiting out the timeout.
 */
export async function waitTurn(page, before, { timeout = 240_000 } = {}) {
  const t0 = Date.now()
  const failedBefore = ((await bodyText(page)).match(/This turn failed/g) ?? []).length
  await waitFor(
    async () => {
      const text = await bodyText(page)
      if ((text.match(/This turn failed/g) ?? []).length > failedBefore) {
        throw new TurnFailed(`the turn failed: ${(await turnFailure(page)) ?? 'no detail'}`)
      }
      return ((text.match(/Completed in \d/g) ?? []).length) > before
    },
    { timeout, interval: 1000, what: 'the turn to complete', fatal: (e) => e instanceof TurnFailed }
  )
  return Date.now() - t0
}

/** Text of the whole conversation area, for content checks. */
export async function transcript(page) {
  const text = await bodyText(page)
  return text.slice(text.indexOf('Settings') + 8)
}

export function counts(text, needle) {
  return text.split(needle).length - 1
}

// ---------------------------------------------------------------------------
// Session files: zstd, one frame appended per write.
// ---------------------------------------------------------------------------
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode a session.vN.jsonl.zstd file into its event objects (unparseable lines become {}). */
export function readSessionEvents(path) {
  const buf = readFileSync(path)
  const starts = []
  for (let i = buf.indexOf(ZSTD_MAGIC); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 1)) starts.push(i)
  const parts = []
  let from = 0
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(from, end)))
      from = end
    } catch {
      // the magic bytes occurred inside a frame: extend the slice to the next candidate
    }
  }
  return Buffer.concat(parts)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return {}
      }
    })
}
