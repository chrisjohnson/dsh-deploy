// worktree: dsh-kanban's own working-copy lifecycle (KAN-82), end to end, on a
// scratch repository the harness makes under the lab's own HOME.
//
// Kanban cuts ticket worktrees itself now — a linked `git worktree` in the
// native `<repo>/.agents/worktrees` pool, made from the just-fetched
// `origin/<default>` when planning starts — so this module drives a real ticket
// through the whole board and checks the four things that matter:
//
//   1. the copy exists, is linked, is on `dsh/<name>`, and stands on the commit
//      it was *fetched* from (the clone's own checkout is deliberately behind it);
//   2. the session log carries the Forge panel's `request` + `created` records
//      before its first turn, naming that exact copy;
//   3. the native "Change requests" sidebar tab shows the worktree, so a ticket
//      copy is treated like a panel-made one;
//   4. closing the ticket removes the copy and archives its sessions, and the
//      source checkout is left clean.
//
// Plus the invariant that outranks all of it: a repository whose `git fetch`
// fails parks the plan dispatch and cuts nothing.
//
// Registered working copies of production are real directories shared with
// production: this module only ever touches paths under the lab's throwaway
// HOME, and `assertInLab` refuses anything else.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkspace, openLab, openSession, readSessionEvents, sidebarWorkspaces, sleep, waitFor } from '../lib.mjs'

// A full ticket round — plan, implement (with its own questions), review and the
// approval gate — runs on the deployment's local models, so the budget is the
// whole lifecycle plus the archive step, not one turn.
export const meta = { needs: ['dsh-kanban'], model: true, timeout: 2_400_000 }

const RECORD = 'plugin:client-ui-forge/worktree'
const TASK = {
  title: 'KAN-82 worktree probe: write hello.txt',
  body: 'Create a file named hello.txt in the workspace containing exactly the word hello. Nothing else.',
  acceptance: ['hello.txt exists in the workspace and contains the word hello'],
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const worktreePaths = (repo) => git(repo, 'worktree', 'list').split('\n').filter(Boolean).map((line) => line.split(' ')[0])
const refTip = (repo, ref) => {
  try {
    return git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  } catch {
    return ''
  }
}
/** Whether `commit` is already contained in `ref` — i.e. the branch is safe to delete. */
const isAncestor = (repo, commit, ref) => {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, ref], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** POST one /api/kanban endpoint from inside the authenticated page. */
function makeRpc(page) {
  return async (endpoint, body = {}) => {
    const out = await page.evaluate(
      async ([e, b]) => {
        const res = await fetch(`/api/kanban/${e}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(b),
          signal: AbortSignal.timeout(60_000),
        })
        return { status: res.status, json: await res.json().catch(() => null) }
      },
      [endpoint, body],
    )
    if (out.status !== 200 || out.json === null) throw new Error(`${endpoint} -> HTTP ${out.status}`)
    if (out.json.ok !== true) throw new Error(`${endpoint} -> ${JSON.stringify(out.json.error ?? out.json).slice(0, 300)}`)
    return out.json.value
  }
}

/** A dsh session's own event log, read out of the lab's DSH_HOME. */
function sessionEvents(env, sessionId) {
  const root = join(env.dshHome, 'sessions')
  if (!existsSync(root)) return []
  for (const ws of readdirSync(root)) {
    for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
      const file = join(root, ws, sessionId, name)
      if (existsSync(file)) return readSessionEvents(file)
    }
  }
  return []
}

/** The worktree records of one session, in log order, with their sequence numbers. */
function worktreeRecords(env, sessionId) {
  return sessionEvents(env, sessionId)
    .filter((event) => event.type === RECORD)
    .map((event) => ({ seq: event.seq, data: event.data }))
}

/** The sequence number of a session's first `turn/start`, or null while none has run. */
function firstTurnSeq(env, sessionId) {
  const starts = sessionEvents(env, sessionId).filter((event) => event.type === 'turn/start')
  return starts.length === 0 ? null : Math.min(...starts.map((event) => event.seq))
}

/**
 * Poll the ticket until `until` answers true. A needs-attention park is a
 * failure unless `allowPark` says this park is the state being waited for.
 */
async function watch(rpc, ticketId, { until, what, timeout, allowPark = () => false }) {
  const deadline = Date.now() + timeout
  for (;;) {
    const detail = await rpc('ticket', { id: ticketId })
    if (until(detail)) return detail
    const parked = detail.ticket.needsAttentionReason
    if (parked && !allowPark(detail)) {
      throw new Error(`ticket ${detail.ticket.key} parked as '${parked}' while waiting for ${what}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last ${detail.ticket.column}/${detail.ticket.phase}`)
    }
    await sleep(2000)
  }
}

/** A seed repo plus a clone of it that is one commit behind its own origin. */
function fixture(labHome, assertInLab, name) {
  const seed = join(labHome, `${name}-seed`)
  mkdirSync(seed, { recursive: true })
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'config', 'user.name', 'Lab')
  git(seed, 'config', 'user.email', 'lab@example.invalid')
  writeFileSync(join(seed, 'README.md'), '# lab scratch repository\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'init')
  const repo = join(labHome, name)
  if (existsSync(repo)) rmSync(assertInLab(repo), { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['clone', '-q', seed, assertInLab(repo)], { stdio: 'ignore' })
  git(repo, 'config', 'user.name', 'Lab')
  git(repo, 'config', 'user.email', 'lab@example.invalid')
  // One commit on the seed *after* the clone: a copy cut from the clone's local
  // main is stale, a copy cut from the fetched origin/main is current, and only
  // the second one proves the fetch happened.
  writeFileSync(join(seed, 'later.md'), 'fetched\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'later')
  return { seed, repo, localTip: git(repo, 'rev-parse', 'HEAD'), fetchedTip: git(seed, 'rev-parse', 'main') }
}

export async function run(ctx) {
  const { env } = ctx
  ctx.needModel()

  const labHome = realpathSync(join(env.meta, 'home'))
  /** Every path this module writes or removes must be inside the lab's throwaway HOME. */
  const assertInLab = (path) => {
    const real = existsSync(path) ? realpathSync(path) : realpathSync(join(path, '..'))
    if (!real.startsWith(`${labHome}/`)) throw new Error(`refusing to touch ${real}: it is outside the lab (${labHome})`)
    return real
  }

  const main = fixture(labHome, assertInLab, 'lab-wt-repo')
  const dead = fixture(labHome, assertInLab, 'lab-wt-dead')
  git(dead.repo, 'remote', 'set-url', 'origin', 'file:///nonexistent/kan82-dead-origin.git')

  const s = await openLab(env)
  const { page } = s
  ctx.attach(s)
  const rpc = makeRpc(page)
  let ticketId = null
  /** every ticket this run filed, so the finally can close them all */
  const extraTickets = []
  let copy = null // { path, branch, name } of the lab-made worktree

  try {
    await s.goto()
    await ensureWorkspace(env, page, 'lab-wt-repo')

    await ctx.check('the board offers a worktree because the workspace is a git checkout', async () => {
      const caps = await rpc('capabilities')
      if (caps.worktree !== true) throw new Error(`capabilities.worktree is ${JSON.stringify(caps.worktree)}`)
      if (git(main.repo, 'rev-parse', '--abbrev-ref', 'origin/HEAD') !== 'origin/main') {
        throw new Error('the scratch clone does not name origin/main, so the fetched-default check would prove nothing')
      }
      if (main.localTip === main.fetchedTip) throw new Error('the fixture is not behind its origin; nothing to fetch')
      return `worktree=true; the clone sits on ${main.localTip.slice(0, 8)} while origin/main is ${main.fetchedTip.slice(0, 8)}`
    })

    let planSession = null
    await ctx.check('a ticket filed into the repo plans in a linked worktree cut from the fetched default', async () => {
      // No `worktree` field at all: this is the default-on path, decided by git.
      const created = await rpc('create', {
        title: TASK.title,
        body: TASK.body,
        acceptance: TASK.acceptance,
        workspaceCwd: main.repo,
        writeMode: 'danger-full-access',
        planTiming: 'now',
        planQuestions: 'autonomous',
        column: 'working',
      })
      ticketId = created.ticket.id
      if (created.ticket.worktree !== true) throw new Error(`the ticket recorded worktree=${created.ticket.worktree}`)
      const detail = await watch(rpc, ticketId, {
        until: (d) => d.ticket.workspaceCwd && d.ticket.workspaceCwd.includes('/.agents/worktrees/'),
        what: 'the plan round to cut its worktree',
        timeout: 240_000,
      })
      const path = detail.ticket.workspaceCwd
      const name = path.split('/').pop()
      const root = assertInLab(path)
      if (root !== join(realpathSync(main.repo), '.agents', 'worktrees', name)) {
        throw new Error(`the copy is at ${root}, not under the scratch repo's .agents/worktrees pool`)
      }
      const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD')
      if (branch !== `dsh/${name}`) throw new Error(`the copy is on ${branch}, not dsh/${name}`)
      if (!worktreePaths(main.repo).some((p) => realpathSync(p) === root)) {
        throw new Error(`git does not list ${root} as a worktree of the scratch repo`)
      }
      const head = git(root, 'rev-parse', 'HEAD')
      if (head !== main.fetchedTip) {
        throw new Error(`the copy stands on ${head.slice(0, 8)}; the fetched origin/main is ${main.fetchedTip.slice(0, 8)}`)
      }
      if (git(main.repo, 'status', '--porcelain') !== '') throw new Error('the source checkout is dirty: the pool is not ignored')
      copy = { path: root, branch, name }
      planSession = (detail.sessions.find((row) => row.purpose === 'plan') ?? {}).sessionId ?? null
      await s.shot('worktree-ticket-planning')
      return `${copy.branch} at ${copy.path} on ${head.slice(0, 8)} (fetched), plan session ${planSession ?? 'not yet listed'}`
    })

    await ctx.check('the plan session log carries the forge worktree records before its first turn', async () => {
      if (!planSession) throw new Error('the ticket detail never listed a plan session')
      const records = await waitFor(
        async () => {
          const found = worktreeRecords(env, planSession)
          return found.length >= 2 ? found : null
        },
        { timeout: 120_000, what: 'the request and created worktree records in the plan session log' },
      )
      if (records[0].data.action !== 'request' || records[1].data.action !== 'created') {
        throw new Error(`the records are ${records.map((r) => r.data.action).join(', ')}; they must be request then created`)
      }
      const created = records[1].data.worktree
      assertInLab(created.path)
      for (const [field, want] of [
        ['path', copy.path],
        ['branch', copy.branch],
        ['from', 'main'],
        ['baseCommit', main.fetchedTip],
        ['repositoryRoot', realpathSync(main.repo)],
      ]) {
        if (created[field] !== want) throw new Error(`created.worktree.${field} is ${JSON.stringify(created[field])}, expected ${JSON.stringify(want)}`)
      }
      if (records[0].data.from !== 'main') throw new Error(`the request record carries from=${JSON.stringify(records[0].data.from)}`)
      const turn = firstTurnSeq(env, planSession)
      if (turn !== null && records[1].seq >= turn) {
        throw new Error(`the created record (seq ${records[1].seq}) is not before the first turn/start (seq ${turn})`)
      }
      return `request@${records[0].seq} + created@${records[1].seq} before turn/start@${turn ?? 'none yet'}; ${created.branch} on ${created.baseCommit.slice(0, 8)}`
    })

    await ctx.check('the native Change requests tab shows the ticket worktree', async () => {
      const key = (await rpc('ticket', { id: ticketId })).ticket.key
      const title = `${key} · plan · ${TASK.title}`
      // kanban registers the copy as a workspace under the ticket's title, so
      // that — not the pet name — is the sidebar group the session sits in.
      const labels = await sidebarWorkspaces(page)
      const group = labels.find((w) => w === TASK.title) ?? labels.find((w) => w.includes(copy.name)) ?? copy.name
      const opened = (await openSession(page, { workspace: group, title }))
        || (await openSession(page, { workspace: copy.name, title }))
      if (!opened) throw new Error(`could not reopen the plan session '${title}' from the sidebar (groups: ${labels.slice(0, 6).join(' | ')})`)
      const toggle = page.getByRole('button', { name: 'Open right sidebar' })
      await waitFor(async () => (await toggle.count()) > 0, { timeout: 20_000, what: 'the right-sidebar toggle' })
      await toggle.click()
      // The sidebar opens on its "Start" page of tool cards, exactly as the ui
      // module drives it; the panel is only reachable from there.
      await waitFor(async () => (await page.getByText('Start', { exact: true }).count()) > 0, { timeout: 20_000, what: 'the right sidebar' })
      // The sidebar card is 'Code review and changes'; the tab it opens is
      // titled 'Change requests'.
      const card = page.getByText('Code review and changes', { exact: true }).filter({ visible: true }).first()
      await waitFor(async () => (await card.count()) > 0, { timeout: 20_000, what: "the 'Code review and changes' tool card" })
      await card.click()
      await waitFor(
        async () => {
          const text = await page.locator('body').innerText()
          return text.includes(copy.path) || text.includes(copy.branch)
        },
        { timeout: 30_000, what: 'the ticket worktree in the Change requests panel' },
      )
      if ((await page.locator('[data-slot-error]').count()) > 0) throw new Error('the Change requests panel rendered a slot error')
      await s.shot('worktree-forge-tab')
      return `the panel names ${copy.branch} at ${copy.path}`
    })

    await ctx.check('the build session announces the same worktree and works inside it', async () => {
      const detail = await watch(rpc, ticketId, {
        until: (d) => d.sessions.some((row) => row.purpose === 'build'),
        what: 'a build session',
        timeout: 300_000,
      })
      const build = detail.sessions.filter((row) => row.purpose === 'build').pop()
      const records = await waitFor(
        async () => {
          const found = worktreeRecords(env, build.sessionId)
          return found.length >= 2 ? found : null
        },
        { timeout: 120_000, what: 'the worktree records in the build session log' },
      )
      if (records[1].data.worktree.path !== copy.path) {
        throw new Error(`the build session announced ${records[1].data.worktree.path}, not ${copy.path}`)
      }
      const turn = firstTurnSeq(env, build.sessionId)
      if (turn !== null && records[1].seq >= turn) throw new Error('the build session records came after its first turn')
      return `build session ${build.sessionId} announced ${records[1].data.worktree.branch} before turn/start`
    })

    await ctx.check('done removes the worktree, archives the sessions, and leaves the checkout clean', async () => {
      // Drive the gate by asking for it: the review has to pass and the approver
      // turn has to end in the human park before `resolve approve` is accepted,
      // and that turn may stop to ask a question first. So keep asking until the
      // engine takes it, and fail with the last refusal if it never does.
      const approveDeadline = Date.now() + 600_000
      let closedBy = 'approve'
      let refused = null
      for (;;) {
        try {
          await rpc('resolve', { id: ticketId, action: 'approve', message: 'smoke: the worktree probe shipped' })
          break
        } catch (error) {
          refused = String(error.message)
          if (Date.now() > approveDeadline) {
            // The approver turn is a model turn: it can stop to ask a question
            // and end without the human park. The archive step runs on the close
            // itself, so `markDone` proves the same thing; say which one closed.
            closedBy = `markDone (approve never opened: ${refused.slice(0, 120)})`
            await rpc('action', { id: ticketId, action: 'markDone', reason: 'smoke: the worktree probe shipped' })
            break
          }
          await sleep(15_000)
        }
      }
      const archived = await waitFor(
        async () => {
          const events = await rpc('events', { id: ticketId, limit: 500 })
          return events.find((event) => event.kind === 'workspace_archived' || event.kind === 'workspace_archive_skipped') ?? null
        },
        { timeout: 180_000, what: 'the workspace archive step to record its outcome' },
      )
      if (archived.kind !== 'workspace_archived') {
        throw new Error(`the close answered ${archived.kind}: ${JSON.stringify(archived.payload)}`)
      }
      const column = (await rpc('ticket', { id: ticketId })).ticket.column
      if (column !== 'done') throw new Error(`the ticket closed in ${column}, not done`)
      if (existsSync(copy.path)) throw new Error(`the worktree ${copy.path} is still on disk after done`)
      const left = worktreePaths(main.repo)
      if (left.length !== 1 || realpathSync(left[0]) !== realpathSync(main.repo)) {
        throw new Error(`git still lists ${left.length} worktree(s) for the scratch repo: ${left.join(', ')}`)
      }
      const payload = archived.payload
      if (!(payload.sessionsArchived >= 1)) throw new Error(`no sessions were archived: ${JSON.stringify(payload)}`)
      // What the plugin owns: it must not dirty the checkout it cut from. A model
      // that drops an untracked file in the parent directory is the model's
      // doing, so tracked changes fail the check and untracked leftovers are only
      // reported — the copy itself is gone either way.
      const tracked = git(main.repo, 'status', '--porcelain', '--untracked-files=no')
      if (tracked !== '') throw new Error(`the source checkout has modified tracked files: ${tracked.split('\n').slice(0, 3).join(' | ')}`)
      const strays = git(main.repo, 'status', '--porcelain').split('\n').filter((line) => line !== '')
      // The branch goes with the copy only when it is merged: `git branch -d`
      // refuses an unmerged one on purpose, so work that never landed outlives
      // the checkout it was written in. Either outcome is correct; the wrong one
      // is a merged branch left behind, or unmerged work deleted.
      const tip = refTip(main.repo, copy.branch)
      if (tip !== '' && isAncestor(main.repo, tip, 'origin/main')) {
        throw new Error(`${copy.branch} was merged into origin/main and still exists — the removal should have deleted it`)
      }
      const branchNote = tip === '' ? `${copy.branch} deleted with the copy` : `${copy.branch} kept: its work is not on origin/main`
      return `closed by ${closedBy}; the copy is gone; ${branchNote}; ${payload.sessionsArchived} session(s) archived; the scratch checkout's tracked files are untouched${strays.length ? ` (${strays.length} untracked path(s) a model left in it)` : ''}`
    })

    await ctx.check('a dead origin parks the plan dispatch and cuts no worktree', async () => {
      const before = worktreePaths(dead.repo).length
      const created = await rpc('create', {
        title: 'KAN-82 dead-origin probe',
        body: 'This ticket must never plan: its origin does not exist.',
        acceptance: ['the plan dispatch parks with the fetch failure'],
        workspaceCwd: dead.repo,
        worktree: true,
        writeMode: 'danger-full-access',
        planTiming: 'now',
        planQuestions: 'autonomous',
        column: 'working',
      })
      const probeId = created.ticket.id
      extraTickets.push(probeId)
      const deadline = Date.now() + 240_000
      let parked = null
      for (;;) {
        parked = (await rpc('ticket', { id: probeId })).ticket
        if (parked.needsAttentionReason) break
        if (Date.now() > deadline) throw new Error(`the dead-origin ticket never parked (last ${parked.column}/${parked.phase})`)
        await sleep(2000)
      }
      const reason = parked.needsAttentionReason
      if (!/fetch/i.test(reason)) throw new Error(`the ticket parked as '${reason}', not on a fetch failure`)
      // The ticket was filed with this checkout as its workspace; the point is
      // that no copy was cut, so it still names the plain checkout and not a
      // pool path under it.
      if (parked.workspaceCwd && parked.workspaceCwd.includes('/.agents/worktrees/')) {
        throw new Error(`a worktree was created anyway: ${parked.workspaceCwd}`)
      }
      if (worktreePaths(dead.repo).length !== before) throw new Error('git lists a worktree that should never have been made')
      if (existsSync(join(dead.repo, '.agents', 'worktrees'))) {
        throw new Error('the pool directory was created for a ticket that never got a copy')
      }
      await rpc('resolve', { id: probeId, action: 'discard', reason: 'smoke: probe over' })
      return `parked as '${reason.slice(0, 120)}' with no copy cut`
    })

    await ctx.check('no console errors', async () => {
      if (s.problems.length > 0) throw new Error(s.problems.slice(0, 3).join(' // '))
    })
  } finally {
    // Close the board's own leftovers first: a ticket still in Working would
    // eat the WIP cap for the next run and hold a scratch copy about to go.
    for (const id of [...extraTickets, ...(ticketId ? [ticketId] : [])]) {
      try {
        await rpc('resolve', { id, action: 'discard', reason: 'smoke: probe over' })
      } catch {
        try {
          await rpc('move', { id, column: 'discarded', reason: 'smoke: probe over' })
        } catch {
          /* already closed, or not parkable: nothing to clean */
        }
      }
    }
    // Only ever our own lab paths: a copy left by a failed check must not linger
    // in the scratch repo, and the scratch repos themselves are lab HOME.
    try {
      if (copy !== null && existsSync(copy.path)) {
        assertInLab(copy.path)
        rmSync(copy.path, { recursive: true, force: true })
        git(main.repo, 'worktree', 'prune')
      }
      for (const dir of [main.repo, main.seed, dead.repo, dead.seed]) {
        if (existsSync(dir)) rmSync(assertInLab(dir), { recursive: true, force: true })
      }
    } catch {
      /* best effort: never let cleanup mask the real failure */
    }
    await s.close()
  }
}
