// The factory line for the pane: the jobs on disk and the size of the queue.
// It runs `gh` or `az` (or calls the tracker's approved MCP tools) and reads the state folder: no command from the settings file.
// A place that the settings file names is asked only when approved (`adaptersOf`).
import type { FactorySettings } from '../../core/factory-settings'
import { isActive, isWaiting } from '../../core/job'
import type { Job } from '../../core/job'
import { todayOf } from '../../core/limits'
import { countsFor } from '../../core/line'
import type { FactoryView, JobView } from '../../core/model'
import { toolNote } from '../../core/task'
import { adaptersOf } from '../adapters'
import { isStopped, lockInfo, readJobs } from '../jobs'
import type { Reader } from '../refresh'

const MAX_JOBS = 20
const MAX_WAITING = 10
const MAX_CLAIMED = 10
const MAX_PLAN = 10
const GH_TIMEOUT_MS = 15_000

// What is known of the line besides its jobs. `claimed` are the ids the
// tracker says are in progress, with or without a job here.
export type LineInfo = Pick<FactoryView, 'lock' | 'holder' | 'isStopped' | 'claimed'>
const NOBODY: LineInfo = { lock: 'free', holder: null, isStopped: false, claimed: [] }

// The agents at work on a job, in a few words.
function workOf(job: Job, now: number): JobView['work'] {
  const [first] = job.work
  if (first === undefined) return null
  const since = Math.min(...job.work.map(work => work.startedAt))

  return {
    text: job.work.length === 1 ? first.role : `${first.role}s`,
    count: job.work.length,
    minutes: Math.max(0, Math.round((now - since) / 60_000)),
  }
}

const viewOfJob = (job: Job, f: FactorySettings, now: number): JobView => ({
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
  work: workOf(job, now),
  tries: job.tries,
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
  line: LineInfo = NOBODY,
): FactoryView | null {
  // A plan job is a row of the plan, never a job of the line. What it spent
  // is in the day's total with every other job.
  const everyJob = jobs
  const plan = [...jobs]
    .filter(job => job.plan !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(0, MAX_PLAN)
    .map(job => ({ itemId: job.itemId, verdict: job.plan?.verdict ?? 'failed', risk: job.plan?.risk ?? null, note: job.plan?.note ?? '' }))
  jobs = jobs.filter(job => job.plan === null)
  // An item that has a job here is that job, whatever the tracker says.
  const here = new Set(jobs.map(job => job.itemId))
  const claimed = line.claimed.filter(id => !here.has(id)).slice(0, MAX_CLAIMED)
  if (everyJob.length === 0 && queue === null && note === null && claimed.length === 0) return null
  const newest = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const running = newest.filter(isActive)
  const waiting = newest.filter(isWaiting)
  // The view holds twenty jobs. The jobs that wait need the person, so they
  // always get ten of the places, and more when few jobs run.
  const showWaiting = Math.min(waiting.length, Math.max(MAX_WAITING, MAX_JOBS - running.length))
  const showRunning = Math.min(running.length, MAX_JOBS - showWaiting)

  return {
    jobs: [...running.slice(0, showRunning), ...waiting.slice(0, showWaiting)].map(job => viewOfJob(job, f, now)),
    // The numbers are of all jobs, so the line is right also when some are not shown.
    // A claimed item with no job waits for the person, at the last station.
    counts: countsFor(jobs, queue).map((count, at, all) => (at === all.length - 1 ? count + claimed.length : count)),
    running: running.length,
    waiting: waiting.length + claimed.length,
    moreRunning: running.length - showRunning,
    moreWaiting: waiting.length - showWaiting,
    queue,
    slots: f.slots,
    today: todayOf(everyJob, now),
    note,
    lock: line.lock,
    holder: line.lock === 'theirs' ? line.holder : null,
    isStopped: line.isStopped,
    claimed,
    plan,
  }
}

export const factoryReader: Reader = {
  name: 'factory',
  read: async (io, ctx) => {
    const read = await readJobs(io, ctx.root)
    const { jobs } = read
    let { note } = read
    let queue: number | null = null
    let claimed: string[] = []
    // The quick read at session start asks no tracker.
    const tracker = ctx.settings.tracker
    if (!ctx.isLight && tracker !== null) {
      // The same adapter as the line's, so the same rule: a place that the
      // settings file names is asked only when the person approved it.
      const { tracker: chosen } = await adaptersOf(io, ctx.root, ctx.settings, GH_TIMEOUT_MS)
      if (chosen !== null) {
        const listed = await chosen.scan()
        queue = listed.items === null ? null : listed.items.length
        claimed = listed.claimed.map(item => item.id)
        // A tool that is missing or not logged in, or an MCP server that did not answer, is said here.
        if (listed.items === null && chosen.kind === 'azure-boards') note ??= toolNote(listed.result, 'az')
        if (listed.items === null && chosen.kind === 'mcp') note ??= listed.note ?? null
      }
    }
    const lock = await lockInfo(io, ctx.root, ctx.now)
    const line = { lock: lock.state, holder: lock.holder, isStopped: await isStopped(io, ctx.root), claimed }

    return { factory: viewOf(jobs, ctx.settings.factory, queue, note, ctx.now, line) }
  },
}
