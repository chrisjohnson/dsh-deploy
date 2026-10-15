// sessions: copied production sessions reopen, before and after a lab restart.
// This is the gate for the session-format migration: sessions that exist only
// in the old format are converted when opened, and a session written by a plugin
// (for example a continue-kicker message) must still load after a restart.
//
// Only sessions whose last turn ended cleanly are opened. A session that looks
// crash-orphaned would make dsh-continue-kicker send "continue" into it, which
// would run an agent turn in a real workspace.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Skip, bodyText, labSh, openLab, readSessionEvents, sidebarWorkspaces, sleep, waitFor } from '../lib.mjs'

export const meta = { timeout: 240_000 }

const LOAD_FAILURE = /failed to (load|open|restore|read)|unsupported (session|format)|could not (load|open) (the )?session|invalid session/i

/** Candidate sessions from the lab's own copy of the data, with what the UI needs to find them. */
function candidates(env) {
  const root = join(env.dshHome, 'sessions')
  const found = []
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws)
    for (const name of readdirSync(wsDir)) {
      if (!name.startsWith('session-')) continue
      const dir = join(wsDir, name)
      const files = readdirSync(dir)
      const v3only = files.includes('session.v3.jsonl.zstd') && !files.includes('session.v4.jsonl.zstd')
      const file = join(dir, v3only ? 'session.v3.jsonl.zstd' : 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const size = statSync(file).size
      if (size < 3000 || size > 400_000) continue
      const events = readSessionEvents(file)
      const end = [...events].reverse().find((e) => e.type === 'turn/end')
      const kind = end?.data?.reason?.kind
      if (kind !== 'completed' && kind !== 'aborted') continue
      const lastAssistant = [...events].reverse().find((e) => e.type === 'assistant/message')
      if (kind === 'completed' && JSON.stringify(lastAssistant ?? {}).length < 400) continue
      const title = [...events].reverse().find((e) => e.type === 'session/title')?.data?.title
      const cwd = events[0]?.cwd
      if (!title || !cwd) continue
      found.push({ id: name, dir, v3only, title, workspace: basename(cwd), size, native: ws.includes('lab-scratch') })
    }
  }
  return found
}

function shortlist(all, workspaces, n) {
  const usable = all.filter((c) => workspaces.includes(c.workspace))
  // A title that appears twice in a workspace cannot be told apart in the sidebar.
  const key = (c) => `${c.workspace}\u0000${c.title}`
  const seen = new Map()
  for (const c of all) seen.set(key(c), (seen.get(key(c)) ?? 0) + 1)
  const unique = usable.filter((c) => seen.get(key(c)) === 1)
  const old = unique.filter((c) => c.v3only).sort((a, b) => a.size - b.size)
  const converted = unique.filter((c) => !c.v3only && !c.native)
  const native = unique.filter((c) => c.native)
  // Order matters: one lab-made, one already-converted, then old-format ones. The
  // sidebar only lists a workspace's recent sessions, so the opener walks this
  // list until it has opened `n`.
  return [...native.slice(0, 1), ...converted.slice(0, Math.max(1, Math.floor(n / 4))), ...old]
}

/** Open one session from the sidebar by workspace and title; resolves once its conversation is showing. */
async function openSession(page, pick) {
  const title = page.getByText(pick.title, { exact: true }).filter({ visible: true })
  const more = page.getByText(/^Show \d+ more sessions?$/).filter({ visible: true })
  for (let attempt = 0; attempt < 3 && (await title.count()) === 0; attempt++) {
    // The group may already be open with the session behind "Show N more".
    for (let i = 0; i < 12 && (await title.count()) === 0 && (await more.count()) > 0; i++) {
      await more.first().click()
      await sleep(400)
    }
    if ((await title.count()) > 0) break
    // Otherwise the group is collapsed: open it (a second pass re-opens it if this closed it).
    await page.getByText(pick.workspace, { exact: true }).filter({ visible: true }).first().click()
    await sleep(700)
  }
  if ((await title.count()) === 0) return false
  await title.first().scrollIntoViewIfNeeded()
  await title.first().click()
  await waitFor(
    async () => {
      const text = await bodyText(page)
      return /Message or run a task/.test(text) && !/Describe what you want to build/.test(text)
    },
    { timeout: 30_000, what: `the session '${pick.title}' to open` }
  )
  return true
}

/**
 * Open sessions from `list` until `target` have opened (null = all of them);
 * returns { opened, notes }. A session the sidebar does not list is skipped.
 */
async function reopenAll(ctx, label, list, target) {
  const s = await openLab(ctx.env)
  const { page } = s
  ctx.attach(s)
  try {
    await s.goto()
    await waitFor(async () => (await sidebarWorkspaces(page)).length > 0, { timeout: 30_000, what: 'the sidebar' })
    const opened = []
    const notes = []
    let skipped = 0
    for (const pick of list) {
      if (target !== null && opened.length >= target) break
      const before = s.problems.length
      const listed = await s.onError(`sessions-${label}-${pick.id.slice(8, 16)}`, () => openSession(page, pick))
      if (!listed) {
        skipped++
        continue
      }
      await sleep(1500)
      const text = await bodyText(page)
      if (LOAD_FAILURE.test(text)) throw new Error(`'${pick.title}' (${pick.id}) shows a load failure: ${text.match(LOAD_FAILURE)[0]}`)
      if (s.problems.length > before) throw new Error(`'${pick.title}' (${pick.id}) logged: ${s.problems.slice(before, before + 2).join(' // ')}`)
      if (pick.v3only) {
        await waitFor(async () => existsSync(join(pick.dir, 'session.v4.jsonl.zstd')), { timeout: 20_000, what: `${pick.id} to be converted to the new format on disk` })
      }
      await s.shot(`sessions-${label}-${opened.length}`)
      opened.push(pick)
      notes.push(`${pick.v3only ? 'old->new' : pick.native ? 'lab-made' : 'already converted'} '${pick.title.slice(0, 30)}'`)
    }
    if (target !== null && opened.length < target) throw new Error(`only ${opened.length} of ${target} candidate sessions are listed in the sidebar (${skipped} not listed)`)
    return { opened, notes: `${notes.join('; ')}${skipped ? ` (${skipped} candidates not listed in the sidebar, skipped)` : ''}` }
  } finally {
    await s.close()
  }
}

export async function run(ctx) {
  const wanted = ctx.args.sessions
  let list = []
  let picks = []
  await ctx.check('find cleanly-ended copied sessions', async () => {
    const probe = await openLab(ctx.env)
    let workspaces
    try {
      await probe.goto()
      await waitFor(async () => (await sidebarWorkspaces(probe.page)).length > 0, { timeout: 30_000, what: 'the sidebar' })
      workspaces = await sidebarWorkspaces(probe.page)
    } finally {
      await probe.close()
    }
    list = shortlist(candidates(ctx.env), workspaces, wanted)
    if (list.length === 0) {
      const mode = existsSync(join(ctx.env.meta, 'data-mode')) ? readFileSync(join(ctx.env.meta, 'data-mode'), 'utf8').trim() : ''
      // A lab seeded with --empty-data or only the newest N sessions may hold nothing suitable.
      if (mode === 'empty' || mode.startsWith('sessions=')) throw new Skip(`the lab's data is '${mode}': no copied session qualifies; start without --sessions for this check`)
      throw new Error('no copied session qualifies: none ended its last turn cleanly in a workspace the sidebar lists')
    }
    return `${list.length} candidates (${list.filter((p) => p.v3only).length} still in the old format)`
  })
  if (list.length === 0) return

  await ctx.check(
    `reopen ${wanted} of them (old-format ones convert on disk)`,
    async () => {
      const r = await reopenAll(ctx, 'before', list, wanted)
      picks = r.opened
      return r.notes
    },
    { timeout: 200_000 }
  )
  if (picks.length === 0) return

  await ctx.check('restart the lab', async () => {
    const r = await labSh(ctx.env, ['restart'])
    if (r.code !== 0) throw new Error(`lab.sh restart exited ${r.code}: ${r.stdout.split('\n').slice(-6).join(' / ')}`)
    return 'restarted, boot verification clean'
  })

  await ctx.check('reopen the same sessions after the restart', async () => (await reopenAll(ctx, 'after', picks, null)).notes, { timeout: 200_000 })
}
