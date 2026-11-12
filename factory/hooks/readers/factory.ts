// The factory line for the pane: the jobs on disk and the size of the queue.
// It runs `gh` and reads the state folder: no command from the settings file,
// so it needs no approval.
import { listIssues } from '../../adapters/github-issues'
import type { FactorySettings } from '../../core/factory-settings'
import { isActive, isWaiting } from '../../core/job'
import type { Job } from '../../core/job'
import { todayOf } from '../../core/limits'
import { countsFor } from '../../core/line'
import type { FactoryView, JobView } from '../../core/model'
import { readJobs } from '../jobs'
import type { Reader } from '../refresh'

const MAX_JOBS = 20
const MAX_WAITING = 10
const GH_TIMEOUT_MS = 15_000

const viewOfJob = (job: Job, f: FactorySettings): JobView => ({
  itemId: job.itemId,
  title: job.title,
  stage: job.stage,
  stoppedIn: job.stoppedIn,
  round: job.round,
  maxRounds: f.maxRounds,
  sentBack: job.sentBack,
  question: job.question,
  prNumber: job.pr?.number ?? null,
  minutes: Math.round(job.agentMs / 60_000),
  costUsd: job.costUsd,
})

// What the pane needs of the jobs: the running ones, then the waiting ones
// (each newest first, twenty at most), and the totals of the day over all of
// them. Null when there is nothing at all to show.
export function viewOf(
  jobs: Job[],
  f: FactorySettings,
  queue: number | null,
  note: string | null,
  now: number,
): FactoryView | null {
  if (jobs.length === 0 && queue === null && note === null) return null
  const newest = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const running = newest.filter(isActive)
  const waiting = newest.filter(isWaiting)
  // The view holds twenty jobs. The jobs that wait need the person, so they
  // always get ten of the places, and more when few jobs run.
  const showWaiting = Math.min(waiting.length, Math.max(MAX_WAITING, MAX_JOBS - running.length))
  const showRunning = Math.min(running.length, MAX_JOBS - showWaiting)

  return {
    jobs: [...running.slice(0, showRunning), ...waiting.slice(0, showWaiting)].map(job => viewOfJob(job, f)),
    // The numbers are of all jobs, so the line is right also when some are not shown.
    counts: countsFor(jobs, queue),
    running: running.length,
    waiting: waiting.length,
    moreRunning: running.length - showRunning,
    moreWaiting: waiting.length - showWaiting,
    queue,
    slots: f.slots,
    today: todayOf(jobs, now),
    note,
  }
}

export const factoryReader: Reader = {
  name: 'factory',
  read: async (io, ctx) => {
    const { jobs, note } = await readJobs(io, ctx.root)
    const tracker = ctx.settings.tracker
    let queue: number | null = null
    // The quick read at session start asks no tracker.
    if (!ctx.isLight && tracker?.kind === 'github') {
      const { items } = await listIssues(
        argv => io.run(argv, { cwd: ctx.root, timeoutMs: GH_TIMEOUT_MS }),
        tracker.mark,
      )
      queue = items === null ? null : items.length
    }

    return { factory: viewOf(jobs, ctx.settings.factory, queue, note, ctx.now) }
  },
}
