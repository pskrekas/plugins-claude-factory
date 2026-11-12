// The person's commands on the line and on a job: stop, answer, reject.
// Each takes the lock first, so two sessions never change one job.
import { closePr, readPrByNumber } from '../adapters/github-pr'
import { githubIssues, listIssues } from '../adapters/github-issues'
import type { Run, Tracker } from '../adapters/tracker'
import { failureText } from '../core/comment'
import type { FactorySettings } from '../core/factory-settings'
import { grant, isFinished, move, reject, resume } from '../core/job'
import type { Job } from '../core/job'
import { clean } from '../core/rows'
import { prHostOf } from '../core/task'
import type { Io } from './io'
import {
  addFeedback,
  findJob,
  lockInfo,
  readJobs,
  releaseLock,
  retireJob,
  setStop,
  takeLock,
  writeJob,
} from './jobs'
import { loadSettings } from './readers/settings'
import { removeWorktree, worktreePath } from './worktrees'

const GH_TIMEOUT_MS = 30_000
const MAX_TEXT = 20_000
const ITEM_ID = /^[A-Za-z0-9#][A-Za-z0-9_.#-]{0,39}$/
const NO_TRACKER = ' No tracker is set: nothing was written to one.'

type Ctx = {
  root: string
  now: number
  f: FactorySettings
  run: Run
  // The tracker and the pull request host are GitHub, or there is none here.
  tracker: Tracker | null
  mark: string | null
}

async function context(io: Io): Promise<Ctx> {
  const loaded = await loadSettings(io)
  const { settings, root } = loaded
  const run: Run = (argv, stdin) => io.run(argv, { cwd: root, timeoutMs: GH_TIMEOUT_MS, stdin })
  const isGitHub = settings.tracker?.kind === 'github' && prHostOf(await io.remote(), settings.prHost) === 'github'

  return {
    root,
    now: await io.now(),
    f: settings.factory,
    run,
    tracker: isGitHub && settings.tracker ? githubIssues(run, settings.tracker.mark, settings.factory.forbiddenCommentWords) : null,
    mark: isGitHub && settings.tracker ? settings.tracker.mark : null,
  }
}

// Runs `work` with the lock held. The lock is given back after, unless this
// session held it before (then it is the session that runs the line).
async function locked(io: Io, ctx: Ctx, work: () => Promise<string>): Promise<string> {
  const before = await lockInfo(io, ctx.root, ctx.now)
  const lock = await takeLock(io, ctx.root, ctx.now)
  if (!lock.isHeld) {
    return `Another session runs the line (${clean(lock.holder ?? 'unknown')}). Nothing was changed.`
  }
  try {
    return await work()
  } finally {
    if (before.state !== 'mine') await releaseLock(io, ctx.root).catch(() => undefined)
  }
}

const why = (error: unknown) => clean(String(error instanceof Error ? error.message : error)).slice(0, 200)

// The job of an item that is still alive, or null.
async function jobOf(io: Io, ctx: Ctx, itemId: string): Promise<Job | null> {
  if (!ITEM_ID.test(itemId)) return null
  const { jobs } = await readJobs(io, ctx.root)

  return findJob(jobs.filter(job => !isFinished(job)), itemId)
}

const none = (itemId: string) => `No job for ${clean(itemId).slice(0, 40)}.`

export async function stopLine(io: Io): Promise<string> {
  const ctx = await context(io)

  return locked(io, ctx, async () => {
    await setStop(io, ctx.root, true)

    return 'The line starts no new station. Running agents finish theirs.'
  })
}

// What a person's "go on" grants a job that a limit stopped: the limit's own
// measure again. The question of such a stop starts with the limit's name.
function granted(job: Job, f: FactorySettings, now: number): Job {
  const asked = job.question ?? ''
  if (job.asker !== 'limit') return job
  if (asked.startsWith('round limit')) return grant(job, { rounds: 1 }, now)
  if (asked.startsWith('cost limit')) return grant(job, { usd: f.costLimitUsd.job }, now)
  if (asked.startsWith('time limit')) return grant(job, { minutes: f.timeLimitMin.job }, now)

  return job
}

export async function answerJob(io: Io, itemId: string, text: string): Promise<string> {
  const ctx = await context(io)

  return locked(io, ctx, async () => {
    const job = await jobOf(io, ctx, itemId)
    if (job === null) return none(itemId)
    const said = text.trim().slice(0, MAX_TEXT)
    const isAsking = job.stage === 'needs-info' || job.stage === 'needs-human'
    if (job.stage === 'ready' && said === '') {
      return `${itemId} is ready. Merge its pull request, or give it text to change something.`
    }
    if (!isAsking && job.stage !== 'ready') return `${itemId} does not wait for you (it is in ${job.stage}).`

    // What the person said is a file of the job: the next agent reads it as data.
    const withText = said === '' ? job : await addFeedback(io, ctx.root, job, said)
    const next = isAsking
      ? resume(granted(withText, ctx.f, ctx.now), 'the person answered', ctx.now)
      : move(withText, 'build', 'the person asked for a change', ctx.now, { sentBack: { by: 'you', why: said } })
    try {
      await ctx.tracker?.setState(itemId, 'in-progress')
    } catch (error) {
      return `${itemId} was not changed: set the tracker state failed (${why(error)}). Run the command again.`
    }
    await writeJob(io, ctx.root, next)
    const done = isAsking ? `${itemId} goes on in ${next.stage}.` : `${itemId} goes back to Build, round ${next.round}.`

    return done + (ctx.tracker === null ? NO_TRACKER : '')
  })
}

// An item the tracker says is in progress, with no job here (a lost state
// folder): the person drops it on the tracker. There is nothing here to change.
async function rejectClaimed(ctx: Ctx, itemId: string, said: string): Promise<string> {
  if (ctx.tracker === null || ctx.mark === null || !ITEM_ID.test(itemId)) return none(itemId)
  const { claimed } = await listIssues(ctx.run, ctx.mark)
  if (!claimed.some(item => item.id === itemId)) return none(itemId)
  const steps: [string, () => Promise<void>][] = [
    ['comment on the item', async () => ctx.tracker?.comment(itemId, `The factory dropped this: ${said}`)],
    ['set the tracker state', async () => ctx.tracker?.setState(itemId, 'rejected')],
  ]
  for (const [name, step] of steps) {
    try {
      await step()
    } catch (error) {
      return `${itemId} was not rejected: ${name} failed (${why(error)}). Run the command again.`
    }
  }

  return `${itemId} is rejected. The reason is on the item.`
}

export async function rejectJob(io: Io, itemId: string, reason: string): Promise<string> {
  const said = reason.trim().slice(0, MAX_TEXT)
  if (said === '') return 'A reason is needed: /factory reject <id> <reason>'
  const ctx = await context(io)

  return locked(io, ctx, async () => {
    const job = await jobOf(io, ctx, itemId)
    if (job === null) return rejectClaimed(ctx, itemId, said)

    // In this order; the first step that fails stops the rest, and the job is
    // written only at the end, so a failed reject leaves it as it was. Every
    // step is safe to run a second time.
    const steps: [string, () => Promise<void>][] = [
      ['comment on the item', async () => ctx.tracker?.comment(itemId, `The factory dropped this: ${said}`)],
      [
        'close the pull request',
        async () => {
          if (ctx.tracker === null || job.pr === null) return
          const { pr } = await readPrByNumber(ctx.run, job.pr.number)
          if (pr !== null && pr.state !== 'open') return
          const closed = await closePr(ctx.run, job.pr.number)
          if ('failed' in closed || closed.exitCode !== 0) throw new Error(failureText('gh', closed))
        },
      ],
      ['set the tracker state', async () => ctx.tracker?.setState(itemId, 'rejected')],
      [
        'remove the worktree',
        async () => {
          const path = await worktreePath(io, ctx.root, job.id)
          if (job.branch === null || path === null || (await io.stat(path)) === null) return
          const removed = await removeWorktree(io, ctx.root, job.id)
          if (!removed.ok) throw new Error(removed.why ?? 'git failed')
        },
      ],
      ['write the job', async () => writeJob(io, ctx.root, reject(job, said, ctx.now))],
      ['retire the job', async () => retireJob(io, ctx.root, job.id, ctx.now)],
    ]
    for (const [name, step] of steps) {
      try {
        await step()
      } catch (error) {
        return `${itemId} was not rejected: ${name} failed (${why(error)}). Run the command again.`
      }
    }

    return `${itemId} is rejected.` + (ctx.tracker === null ? NO_TRACKER : ' The reason is on the item.')
  })
}
