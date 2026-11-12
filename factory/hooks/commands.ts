// The person's commands on the line and on a job: stop, answer, reject.
// Each takes the lock first, so two sessions never change one job.
import { closePr, readPrByNumber } from '../adapters/github-pr'
import { githubIssues, inRepo, listIssues } from '../adapters/github-issues'
import type { Run, Tracker } from '../adapters/tracker'
import { failureText } from '../core/comment'
import type { FactorySettings } from '../core/factory-settings'
import { grant, isFinished, move, reject, resume } from '../core/job'
import type { Job } from '../core/job'
import { limitOf } from '../core/limits'
import { clean } from '../core/rows'
import { prHostOf, repoOf } from '../core/task'
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

export type Ctx = {
  root: string
  // The branch jobs start from and are compared with.
  base: string
  now: number
  f: FactorySettings
  run: Run
  // The tracker and the pull request host are GitHub, or there is none here.
  tracker: Tracker | null
  mark: string | null
}

// What a command or the line needs to act: the repo, the settings, and the
// tracker when there is one.
export async function context(io: Io): Promise<Ctx> {
  const { settings, root } = await loadSettings(io)
  const remote = await io.remote()
  // Every gh call names the repository of `origin`. A remote that names none
  // gives no tracker: nothing is written to a project gh would pick itself.
  const repo = repoOf(remote)
  const plain: Run = (argv, stdin) => io.run(argv, { cwd: root, timeoutMs: GH_TIMEOUT_MS, stdin })
  const run = repo === null ? plain : inRepo(plain, repo)
  const tracker = settings.tracker
  const isGitHub = tracker?.kind === 'github' && prHostOf(remote, settings.prHost) === 'github' && repo !== null

  return {
    root,
    base: settings.baseBranch,
    now: await io.now(),
    f: settings.factory,
    run,
    tracker: isGitHub && tracker ? githubIssues(run, tracker.mark, settings.factory.forbiddenCommentWords) : null,
    mark: isGitHub && tracker ? tracker.mark : null,
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
const none = (itemId: string) => `No job for ${clean(itemId).slice(0, 40)}.`

// The jobs that are still alive, and the one of an item among them.
async function alive(io: Io, ctx: Ctx, itemId: string): Promise<{ jobs: Job[]; job: Job | null }> {
  const jobs = (await readJobs(io, ctx.root)).jobs.filter(job => !isFinished(job))

  return { jobs, job: ITEM_ID.test(itemId) ? findJob(jobs, itemId) : null }
}

// The brake. It changes no job, so it needs no lock: it works also from a
// session that does not run the line.
export async function stopLine(io: Io): Promise<string> {
  await setStop(io, (await loadSettings(io)).root, true)

  return 'The line starts no new station. Running agents finish theirs.'
}

// What a person's "go on" grants a job that a limit of its own stopped: that
// limit's measure once more. The question of such a stop is the limit's name
// (`limitOf`). A limit of the day is not the job's to lift.
function granted(job: Job, f: FactorySettings, now: number): Job {
  const asked = job.question ?? ''
  if (job.asker !== 'limit') return job
  if (asked.startsWith('round limit')) return grant(job, { rounds: 1 }, now)
  if (asked.startsWith('cost limit for the job')) return grant(job, { usd: f.costLimitUsd.job }, now)
  if (asked.startsWith('time limit for the job')) return grant(job, { minutes: f.timeLimitMin.job }, now)

  return job
}

export async function answerJob(io: Io, itemId: string, text: string): Promise<string> {
  const ctx = await context(io)

  return locked(io, ctx, async () => {
    const { jobs, job } = await alive(io, ctx, itemId)
    if (job === null) return none(itemId)
    const said = text.trim().slice(0, MAX_TEXT)
    const isAsking = job.stage === 'needs-info' || job.stage === 'needs-human'
    if (job.stage === 'ready' && said === '') {
      return `${itemId} is ready. Merge its pull request, or give it text to change something.`
    }
    if (!isAsking && job.stage !== 'ready') return `${itemId} does not wait for you (it is in ${job.stage}).`
    // A question for the item's author has no answer without text.
    if (job.stage === 'needs-info' && said === '') return `Give the answer as text: /factory answer ${itemId} <text>`
    const allowed = granted(job, ctx.f, ctx.now)
    const limit = job.asker === 'limit' ? limitOf(allowed, jobs, ctx.f, ctx.now) : null
    if (limit !== null) return `${itemId} is still at a limit (${limit}). Nothing was changed.`

    // What the person said is a file of the job: the next agent reads it as
    // data. The job is written last, so a step that fails leaves it as it was
    // (a second run writes the same file again).
    const steps = { now: 'write the answer' }
    try {
      const withText = said === '' ? allowed : await addFeedback(io, ctx.root, allowed, said)
      const next = isAsking
        ? resume(withText, 'the person answered', ctx.now)
        : move(withText, 'build', 'the person asked for a change', ctx.now, { sentBack: { by: 'you', why: said } })
      steps.now = 'set the tracker state'
      await ctx.tracker?.setState(itemId, 'in-progress')
      steps.now = 'write the job'
      await writeJob(io, ctx.root, next)
      const done = isAsking ? `${itemId} goes on in ${next.stage}.` : `${itemId} goes back to Build, round ${next.round}.`

      return done + (ctx.tracker === null ? NO_TRACKER : '')
    } catch (error) {
      return `${itemId} was not changed: ${steps.now} failed (${why(error)}). Run the command again.`
    }
  })
}

type Step = [string, () => Promise<void>]

// Runs the steps in order. The name and the reason of the first that fails, or null.
async function firstFailure(steps: Step[]): Promise<string | null> {
  for (const [name, step] of steps) {
    try {
      await step()
    } catch (error) {
      return `${name} failed (${why(error)})`
    }
  }

  return null
}

// An item the tracker says is in progress, with no job here (a lost state
// folder): the person drops it on the tracker. There is nothing here to change.
async function rejectClaimed(ctx: Ctx, itemId: string, said: string): Promise<string> {
  if (ctx.tracker === null || ctx.mark === null || !ITEM_ID.test(itemId)) return none(itemId)
  const listed = await listIssues(ctx.run, ctx.mark)
  if (listed.items === null) {
    const reason = listed.result === null ? 'not a label' : failureText('gh', listed.result)

    return `${itemId} was not rejected: read the tracker failed (${clean(reason).slice(0, 200)}). Run the command again.`
  }
  if (!listed.claimed.some(item => item.id === itemId)) return none(itemId)
  const failed = await firstFailure([
    ['comment on the item', async () => ctx.tracker?.comment(itemId, `The factory dropped this: ${said}`)],
    ['set the tracker state', async () => ctx.tracker?.setState(itemId, 'rejected')],
  ])

  return failed === null
    ? `${itemId} is rejected. The reason is on the item.`
    : `${itemId} was not rejected: ${failed}. Run the command again.`
}

export async function rejectJob(io: Io, itemId: string, reason: string): Promise<string> {
  const said = reason.trim().slice(0, MAX_TEXT)
  if (said === '') return 'A reason is needed: /factory reject <id> <reason>'
  const ctx = await context(io)

  return locked(io, ctx, async () => {
    const { job } = await alive(io, ctx, itemId)
    if (job === null) return rejectClaimed(ctx, itemId, said)

    // In this order; the first step that fails stops the rest, and the job is
    // written last of them, so a failed reject leaves it as it was. Every
    // step is safe to run a second time.
    const failed = await firstFailure([
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
      ['write the job', async () => writeJob(io, ctx.root, reject(job, said, ctx.now))],
    ])
    if (failed !== null) return `${itemId} was not rejected: ${failed}. Run the command again.`

    // The job is rejected now, here and on the tracker. What follows only
    // tidies up: a step that fails is named, and does not undo the reject.
    const left: string[] = []
    const tidy: Step[] = [
      [
        'remove the worktree',
        async () => {
          const path = await worktreePath(io, ctx.root, job.id)
          if (job.branch === null || path === null || (await io.stat(path)) === null) return
          const removed = await removeWorktree(io, ctx.root, job.id)
          if (!removed.ok) throw new Error(removed.why ?? 'git failed')
        },
      ],
      ['retire the job', async () => retireJob(io, ctx.root, job.id, ctx.now)],
    ]
    for (const [name, step] of tidy) {
      try {
        await step()
      } catch (error) {
        left.push(`${name} (${why(error)})`)
      }
    }

    return (
      `${itemId} is rejected.` +
      (ctx.tracker === null ? NO_TRACKER : ' The reason is on the item.') +
      (left.length === 0 ? '' : ` Not cleaned up: ${left.join('; ')}.`)
    )
  })
}
