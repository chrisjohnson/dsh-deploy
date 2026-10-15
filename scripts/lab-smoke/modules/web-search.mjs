// web-search: the model's web_search tool returns real results through the
// lab's SearXNG, rendered without a tool error.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Skip, completedTurns, ensureWorkspace, newSession, openLab, send, transcript, waitTurn } from '../lib.mjs'

export const meta = { needs: ['dsh-web-search-searxng'], timeout: 300_000 }

function searxngUrl(env) {
  const pid = readFileSync(join(env.meta, 'pid'), 'utf8').trim()
  const kv = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith('SEARXNG_BASE_URL='))
  return kv?.slice('SEARXNG_BASE_URL='.length)
}

export async function run(ctx) {
  const { env } = ctx
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-scratch')

    await ctx.check('SearXNG answers a JSON query', async () => {
      const base = searxngUrl(env)
      if (!base) throw new Skip('the lab has no SEARXNG_BASE_URL')
      const response = await fetch(`${base}/search?q=nixos+manual&format=json`, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`SearXNG answered HTTP ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body.results) || body.results.length === 0) throw new Error('SearXNG returned no results')
      return `${body.results.length} results`
    })

    await ctx.check('web_search is called and its results reach the reply', async () => {
      ctx.needModel()
      await newSession(page, 'lab-scratch')
      const before = await completedTurns(page)
      await send(page, 'Use the web_search tool to search for "nixos manual" and list the top 3 result titles with their URLs.')
      await waitTurn(page, before, { timeout: 270_000 })
      const text = await transcript(page)
      await s.shot('web-search')
      if (!/web_search|Web search|Searched/i.test(text)) throw new Error('no web_search tool call is visible in the transcript')
      if (/INVALID_TOOL_OUTPUT|tool (call )?failed|tool error/i.test(text)) throw new Error('the transcript shows a tool error')
      if (!/https?:\/\//.test(text)) throw new Error('the reply lists no URL')
      return 'tool call visible, reply lists URLs'
    })
  } finally {
    await s.close()
  }
}
