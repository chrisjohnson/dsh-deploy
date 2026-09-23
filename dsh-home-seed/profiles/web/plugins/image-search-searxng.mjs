// image-search-searxng: a model-facing `image_search` tool over the same
// self-hosted SearXNG instance dsh-web-search-searxng already uses for text
// search (SEARXNG_BASE_URL), but querying its `images` category instead of
// the default `general` one.
//
// This is a standalone tool, not an extension of the shared `web_search`
// tool/dsh-web seam: that seam's WebSearchRequest/WebSearchSource types
// (upstream @deepseek-ai/dsh-web) have no category or image-field concept at
// all, and extending them would mean patching multiple upstream packages
// that every future dsh upgrade would need re-verifying. A standalone tool
// with its own schema avoids all of that, matching the existing
// dsh-image-gen/dsh-web-search-searxng pattern of a package (or, here, a
// local plugin file) that inserts itself via a `cordis.patch.yml`/profile
// patch `insert:` row - which reaches every agent preset automatically, so
// no agent.cordis.yml customization is needed even now that this deployment
// runs 100% upstream presets.
//
// Deliberately markdown-links-only, not real image attachments: the model
// never downloads, attaches, or "sees" a result image - it gets titles,
// source pages, and `img_src`/thumbnail URLs as plain text, which it can
// render as markdown image links for the chat UI to display inline. Real
// attachments would mean downloading and validating arbitrary third-party
// images through the same attachment/vision pipeline that caused a real
// production incident (M-151, a WebP image DSH's own vision pipeline could
// not send to llama-server) - out of scope for what's really just "let the
// user see search results," and meaningfully lower-risk without it.
//
// ctx.tools requires an explicit ctx.inject(['tools'], ...) - unlike
// ctx.logger/ctx.effect, which are always-present base context methods,
// `tools` is a cordis-injected SERVICE and accessing it directly throws
// "cannot get property \"tools\" without inject" at plugin construction
// time, crashing the whole profile (confirmed live 2026-09-23).

import { defineTool } from '@deepseek-ai/dsh-tools'

const PLUGIN_NAME = 'image-search-searxng'
const DEFAULT_BASE_URL = 'http://localhost:8888'
const DEFAULT_MAX_RESULTS = 8
const USER_AGENT = 'dsh-image-search-searxng/0.1.0'

function formatResults(results) {
  if (results.length === 0) return 'No image results found.'
  return results
    .map((r, i) => {
      const title = r.title ?? `Image ${i + 1}`
      const lines = [`${i + 1}. **${title}**`, `   ![${title}](${r.imgSrc})`, `   Source: ${r.sourceUrl}`]
      if (r.resolution) lines.push(`   Resolution: ${r.resolution}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

export default function imageSearchSearxng(ctx, config = {}) {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  const defaultMaxResults = config.maxResults ?? DEFAULT_MAX_RESULTS
  const apiKey = config.apiKey
  const log = ctx.logger(PLUGIN_NAME)

  ctx.inject(['tools'], (ctx) => {
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          name: 'image_search',
          description:
            'Search the web for images via a self-hosted SearXNG instance. Returns '
            + 'titles, source pages, and markdown image links so results render '
            + 'inline in chat for the user to see. You do not receive image pixels '
            + 'or a visual attachment - you cannot describe, compare, or analyze what '
            + 'is actually depicted. Cite results only by title, source, and '
            + 'resolution; never claim to see the image content itself.',
          parameters: {
            query: {
              type: 'string',
              required: true,
              description: 'The image search query.',
            },
            maxResults: {
              type: 'integer',
              description: `Maximum results to return, 1-30 (default ${defaultMaxResults}).`,
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                results: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string' },
                      imgSrc: { type: 'string', required: true },
                      sourceUrl: { type: 'string', required: true },
                      resolution: { type: 'string' },
                    },
                  },
                },
              },
            },
            render(_args, value) {
              return [{ type: 'text', text: formatResults(value.results) }]
            },
          },
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            const requested = args.maxResults ?? defaultMaxResults
            const capped = Math.max(1, Math.min(30, Math.trunc(requested)))

            const endpoint = new URL('/search', baseURL)
            endpoint.searchParams.set('q', args.query)
            endpoint.searchParams.set('categories', 'images')
            endpoint.searchParams.set('format', 'json')
            if (apiKey != null && apiKey.length > 0) {
              endpoint.searchParams.set('preference[api_key]', apiKey)
            }

            let response
            try {
              response = await fetch(endpoint, {
                method: 'GET',
                redirect: 'error',
                headers: { accept: 'application/json', 'user-agent': USER_AGENT },
                signal: exec.signal,
              })
            } catch (error) {
              throw new Error(`SearXNG image search request failed: ${String(error)}`)
            }
            if (!response.ok) {
              throw new Error(`SearXNG image search failed: HTTP ${response.status}`)
            }

            const payload = await response.json()
            const results = (payload.results ?? [])
              .filter((r) => r.img_src != null && r.img_src.length > 0)
              .slice(0, capped)
              .map((r) => ({
                ...(r.title != null && r.title.length > 0 ? { title: r.title } : {}),
                imgSrc: r.img_src,
                sourceUrl: r.url != null && r.url.length > 0 ? r.url : r.img_src,
                ...(r.resolution != null && r.resolution.length > 0 ? { resolution: r.resolution } : {}),
              }))

            log.info('image_search %j -> %d results', args.query, results.length)
            return { results }
          },
        }),
      ),
    )
  })

  log.info('image-search-searxng active (baseURL=%s, maxResults=%d)', baseURL, defaultMaxResults)
}
