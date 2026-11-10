// worktree: dsh-better-git-worktree against a throwaway repository the harness
// makes under the lab's own HOME. Registered working copies of production are
// real directories shared with production: this module never creates, converts
// or removes anything but the copies it makes itself, and refuses to act on a
// path outside the lab.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bodyText, completedTurns, ensureWorkspace, newSession, openLab, send, sidebarWorkspaces, sleep, waitFor, waitTurn } from '../lib.mjs'

export const meta = { needs: ['dsh-better-git-worktree'], timeout: 180_000 }

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

export async function run(ctx) {
  const { env } = ctx
  const labHome = realpathSync(join(env.meta, 'home'))
  const repo = join(labHome, 'lab-wt-repo')

  /** Every path this module writes or removes must be inside the lab's throwaway HOME. */
  const assertInLab = (path) => {
    const real = realpathSync(path)
    if (!real.startsWith(`${labHome}/`)) throw new Error(`refusing to touch ${real}: it is outside the lab (${labHome})`)
    return real
  }

  mkdirSync(repo, { recursive: true })
  if (!existsSync(join(repo, '.git'))) {
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.name', 'Lab')
    git(repo, 'config', 'user.email', 'lab@example.invalid')
    writeFileSync(join(repo, 'README.md'), '# lab scratch repository\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
  }

  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  const rpc = (endpoint, body) =>
    page.evaluate(
      async ([e, b]) => {
        // A bounded fetch: without it a call that never answers just eats the
        // whole check timeout and the failure says nothing about which one.
        const response = await fetch(`/betterGitWorktree/${e}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(b),
          signal: AbortSignal.timeout(60_000)
        })
        return response.json()
      },
      [endpoint, body]
    )
  const snapshot = async () => (await rpc('snapshot', {})).value.worktrees
  let copy = null // { sessionId, managedRoot, petName }

  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-wt-repo')

    await ctx.check('the composer Worktree switch creates a working copy of the scratch repo', async () => {
      const before = await snapshot()
      const foreign = before.filter((w) => !w.managedRoot.startsWith(`${labHome}/`))
      await newSession(page, 'lab-wt-repo')
      await page.getByRole('switch', { name: 'Worktree' }).click()
      await page.locator('[role=dialog] button', { hasText: 'Create worktree and switch' }).click()
      const created = await waitFor(
        async () => (await snapshot()).find((w) => !before.some((b) => b.sessionId === w.sessionId)),
        { timeout: 30_000, what: 'the new working copy to appear in the registry' }
      )
      copy = created
      const root = assertInLab(created.managedRoot)
      if (!root.startsWith(`${realpathSync(repo)}/.dsh-worktrees/`)) throw new Error(`copy at ${root} is not under the scratch repo's .dsh-worktrees`)
      if (git(root, 'rev-parse', '--show-toplevel') !== root) throw new Error('the copy is not a repository of its own')
      if (git(root, 'rev-parse', '--abbrev-ref', 'HEAD') !== `dsh/${created.petName}`) throw new Error('the copy is not on its own dsh/<name> branch')
      await s.shot('worktree-created')
      return `${created.petName} at ${root}${foreign.length ? `; NOTE the registry also holds ${foreign.length} copies outside the lab (--with-worktrees): untouched` : '; the registry held only lab-made copies'}`
    })
    if (copy === null) return

    await ctx.check('the copy is listed as a workspace in the sidebar', async () => {
      await waitFor(async () => (await sidebarWorkspaces(page)).includes(copy.petName), { timeout: 20_000, what: `${copy.petName} in the sidebar` })
      return copy.petName
    })

    await ctx.check('a dirty copy: the host counts the work and refuses to remove it', async () => {
      const root = assertInLab(copy.managedRoot)
      writeFileSync(join(root, 'dirty.txt'), 'uncommitted\n')
      const status = (await rpc('status', { sessionId: copy.sessionId, force: true })).value.status
      if (!(status.archive.dirty >= 1)) throw new Error(`status reports ${status.archive.dirty} uncommitted path(s) for a copy with an untracked file`)
      const plain = await rpc('remove', { sessionId: copy.sessionId })
      if (plain.ok !== false || plain.error?.code !== 'unsaved-work') throw new Error(`an unconfirmed remove of a dirty copy answered ${JSON.stringify(plain).slice(0, 200)}`)
      const stale = await rpc('remove', { sessionId: copy.sessionId, confirmedPlan: { dirty: 0, unpushed: 0, stashes: 0 } })
      if (stale.ok !== false) throw new Error('a remove confirming the wrong plan was accepted')
      if (!existsSync(join(root, 'dirty.txt'))) throw new Error('the dirty file is gone although the remove was refused')
      return `refused with ${plain.error.code}; ${status.archive.dirty} uncommitted path(s) kept`
    })

    await ctx.check('the archive dialog warns about uncommitted work and offers Remove / Keep / Cancel', async () => {
      ctx.needModel()
      // The archive action lives on a session row, and a row needs a first turn. The
      // page is still on the blank session the Worktree switch opened inside the copy.
      const before = await completedTurns(page)
      await send(page, 'Reply with exactly: wt-ok')
      await waitTurn(page, before)
      // The row's archive action is revealed on hover and clicked by event, like the
      // other hover-only row buttons; it is the plugin's shadow of the official one.
      const row = page.getByText('Reply with exactly: wt-ok', { exact: true }).filter({ visible: true }).first()
      await row.hover()
      const archive = row.locator('xpath=ancestor::*[.//button[@aria-label="Archive session"]][1]').locator('[aria-label="Archive session"]').first()
      await archive.dispatchEvent('click')
      const dialog = page.locator('[role=dialog], [role=alertdialog]').first()
      await dialog.waitFor({ timeout: 15_000 })
      const text = await dialog.innerText()
      await s.shot('worktree-archive-dialog')
      if (!/uncommitted/i.test(text)) throw new Error(`the dialog does not warn about uncommitted work: ${text.replace(/\n+/g, ' | ').slice(0, 300)}`)
      for (const label of ['Remove', 'Keep', 'Cancel']) {
        if (!(await dialog.getByRole('button', { name: label, exact: true }).count())) throw new Error(`the dialog has no ${label} button`)
      }
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).first().click()
      if (!existsSync(copy.managedRoot)) throw new Error('Cancel removed the copy')
      return 'warned, three choices, Cancel kept the copy'
    })

    await ctx.check('a clean copy is removed by the host; nothing else changes', async () => {
      const root = assertInLab(copy.managedRoot)
      rmSync(join(root, 'dirty.txt'), { force: true })
      const siblings = readdirSync(join(realpathSync(repo), '.dsh-worktrees')).filter((n) => n !== copy.petName)
      const result = await rpc('remove', { sessionId: copy.sessionId })
      if (result.ok !== true || result.value?.removed !== true) throw new Error(`remove answered ${JSON.stringify(result).slice(0, 300)}`)
      if (existsSync(root)) throw new Error('the copy directory is still there')
      if ((await snapshot()).some((w) => w.sessionId === copy.sessionId)) throw new Error('the registry still lists the copy')
      const after = readdirSync(join(realpathSync(repo), '.dsh-worktrees'))
      if (JSON.stringify(after.sort()) !== JSON.stringify(siblings.sort())) throw new Error(`other copies changed: ${after} vs ${siblings}`)
      if (git(repo, 'status', '--porcelain') !== '') throw new Error('the scratch checkout is no longer clean')
      return 'removed; siblings and the scratch checkout untouched'
    })

    await ctx.check('worktree_convert moves a session and its uncommitted work into a copy; Remove needs the confirmed plan', async () => {
      ctx.needModel()
      await page.keyboard.press('Escape') // a dialog left open by an earlier check must not eat the next one
      const knownSessions = new Set(sessionDirs(env, repo))
      await newSession(page, 'lab-wt-repo')
      // Read the turn count only once the fresh session is actually on screen: the
      // previous session's transcript is still rendered for a moment, and counting
      // its completed turn as the baseline makes the wait below unsatisfiable.
      await waitFor(async () => (await bodyText(page)).includes('Into the Unknown'), { timeout: 20_000, what: 'the empty new session' })
      const before = await completedTurns(page)
      await send(page, 'Reply with exactly: convert-ok')
      await waitTurn(page, before, { timeout: 150_000 })
      // Identify the session by what the turn added, not by directory mtime: a
      // copy converted by an earlier run keeps its directory hot, so an mtime
      // sort can hand back an already-converted session.
      const [source] = sessionDirs(env, repo).filter((d) => !knownSessions.has(d))
      if (!source) throw new Error('no new session directory appeared for the scratch repo')
      writeFileSync(join(repo, 'moved.txt'), 'uncommitted work\n')
      const known = await snapshot()
      const converted = await rpc('convert', { sessionId: source })
      if (converted.ok !== true) throw new Error(`convert answered ${JSON.stringify(converted).slice(0, 300)}`)
      const record = (await snapshot()).find((w) => !known.some((k) => k.sessionId === w.sessionId))
      if (!record) throw new Error('no new registry record after convert')
      const root = assertInLab(record.managedRoot)
      if (!existsSync(join(root, 'moved.txt'))) throw new Error('the uncommitted file did not move into the copy')
      if (existsSync(join(repo, 'moved.txt'))) throw new Error('the uncommitted file is still in the source checkout')
      if (converted.value.conversationCarried !== true) throw new Error('the conversation was not carried into the new session')
      const refused = await rpc('remove', { sessionId: record.sessionId })
      if (refused.ok !== false || refused.error?.code !== 'unsaved-work') throw new Error(`a remove of the copy holding moved work answered ${JSON.stringify(refused).slice(0, 200)}`)
      const confirmed = await rpc('remove', { sessionId: record.sessionId, confirmedPlan: refused.error.details.plan })
      if (confirmed.ok !== true || existsSync(root)) throw new Error(`a remove confirming the shown plan answered ${JSON.stringify(confirmed).slice(0, 200)}`)
      return `moved 1 file, carried the conversation, refused unconfirmed, removed on the shown plan`
    })

    await ctx.check('no console errors', async () => {
      if (s.problems.length > 0) throw new Error(s.problems.slice(0, 3).join(' // '))
    })
  } finally {
    // Leave nothing of ours behind if a check stopped early; only ever our own copy.
    try {
      if (copy !== null && existsSync(copy.managedRoot)) {
        const root = assertInLab(copy.managedRoot)
        rmSync(join(root, 'dirty.txt'), { force: true })
        await rpc('remove', { sessionId: copy.sessionId }).catch(() => {})
      }
    } catch {
      /* best effort */
    }
    await s.close()
  }
}

/** The session directories the lab holds for the scratch repo's workspace. */
function sessionDirs(env, repo) {
  const root = join(env.dshHome, 'sessions')
  const slug = readdirSync(root).find((d) => d === `--${repo.replace(/^\//, '').replace(/\//g, '-')}--`)
  if (!slug) throw new Error(`no session directory for ${repo}`)
  return readdirSync(join(root, slug)).filter((n) => n.startsWith('session-'))
}
