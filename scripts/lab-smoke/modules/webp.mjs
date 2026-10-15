// webp: a WebP attachment reaches the model. The vision backends are llama-server
// builds that cannot decode WebP, so dsh-attachment-local is patched to send
// JPEG; without the patch the turn fails with a 400 "Failed to load image".
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bodyText, completedTurns, ensureWorkspace, newSession, openLab, send, transcript, turnFailure, waitFor, waitTurn } from '../lib.mjs'

export const meta = { model: true, timeout: 300_000 }

export async function run(ctx) {
  const { env } = ctx
  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-scratch')
    await ctx.check('a solid red WebP attachment is described as red', async () => {
      await newSession(page, 'lab-scratch')
      // Chromium encodes the WebP, so the fixture needs no image tooling on the box.
      const encoded = await page.evaluate(async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 96
        canvas.height = 96
        const g = canvas.getContext('2d')
        g.fillStyle = '#e00000'
        g.fillRect(0, 0, 96, 96)
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9))
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        for (const b of bytes) binary += String.fromCharCode(b)
        return { type: blob.type, base64: btoa(binary) }
      })
      if (encoded.type !== 'image/webp') throw new Error(`the browser encoded ${encoded.type}, not WebP; the fixture is invalid`)
      const file = join(env.meta, 'smoke', 'red.webp')
      mkdirSync(join(env.meta, 'smoke'), { recursive: true })
      writeFileSync(file, Buffer.from(encoded.base64, 'base64'))
      await page.locator('input[type=file]').first().setInputFiles(file)
      await waitFor(async () => /red\.webp/.test(await bodyText(page)), { timeout: 20_000, what: 'the attachment chip' })
      const before = await completedTurns(page)
      await send(page, 'What single color fills the attached image? Answer with one word.')
      try {
        await waitTurn(page, before, { timeout: 270_000 })
      } catch (error) {
        const failure = await turnFailure(page)
        throw new Error(failure && /webp|image|decode/i.test(failure) ? `the backend rejected the image (is the WebP patch applied?): ${failure}` : error.message)
      }
      const text = await transcript(page)
      await s.shot('webp')
      const reply = text.slice(text.lastIndexOf('red.webp'))
      if (!/red/i.test(reply.split('What single color')[1] ?? reply)) throw new Error(`the reply does not say red: ${reply.replace(/\s+/g, ' ').slice(0, 200)}`)
      return 'attached, converted, described as red'
    })
  } finally {
    await s.close()
  }
}
