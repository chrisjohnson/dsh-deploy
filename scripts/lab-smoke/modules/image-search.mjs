// image-search: the model's image_search tool returns results through the lab's
// SearXNG. The tool's markdown image links render inline when the host allows
// hotlinking and degrade to alt text when it does not; either is a pass, an
// error or an empty result is not.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Skip, completedTurns, ensureWorkspace, newSession, openLab, send, transcript, waitTurn } from '../lib.mjs'

export const meta = { needs: ['dsh-image-search-searxng'], timeout: 300_000 }

export async function run(ctx) {
  const { env } = ctx
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-scratch')
    await ctx.check('SearXNG answers an image query', async () => {
      const pid = readFileSync(join(env.meta, 'pid'), 'utf8').trim()
      const kv = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith('SEARXNG_BASE_URL='))
      if (!kv) throw new Skip('the lab has no SEARXNG_BASE_URL')
      const response = await fetch(`${kv.slice('SEARXNG_BASE_URL='.length)}/search?q=red+panda&categories=images&format=json`, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`SearXNG answered HTTP ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body.results) || body.results.length === 0) throw new Error('SearXNG returned no image results')
      return `${body.results.length} image results`
    })

    await ctx.check('image_search is called and returns results', async () => {
      ctx.needModel()
      await newSession(page, 'lab-scratch')
      const before = await completedTurns(page)
      await send(page, 'Use the image_search tool to find pictures of a red panda, then tell me how many results it returned.')
      await waitTurn(page, before, { timeout: 270_000 })
      const text = await transcript(page)
      await s.shot('image-search')
      if (!/image_search|Image search/i.test(text)) throw new Error('no image_search tool call is visible in the transcript')
      if (/INVALID_TOOL_OUTPUT|tool (call )?failed|tool error/i.test(text)) throw new Error('the transcript shows a tool error')
      const images = await page.locator('main img, [class*=message] img').count()
      return images > 0 ? `${images} inline image(s) rendered` : 'results returned as text (hotlinks blocked or degraded to alt text)'
    })
  } finally {
    await s.close()
  }
}
