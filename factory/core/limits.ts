// The limits of the line (design 8.1) and the totals of the day (5.4). Pure.
import type { FactorySettings } from './factory-settings'
import { dayOf, isActive } from './job'
import type { Job } from './job'

const MINUTE = 60_000

export function freeSlots(jobs: Job[], f: FactorySettings): number {
  return Math.max(0, f.slots - jobs.filter(isActive).length)
}

// The same local calendar day.
export function isSameDay(a: number, b: number): boolean {
  return dayOf(a) === dayOf(b)
}

const round2 = (n: number) => Math.round(n * 100) / 100

// How many more times this job may loop back to Build. With `maxRounds` 3 a
// job in round 3 that fails has none left: it stops and asks the person, who
// can grant more.
export function roundsLeft(job: Job, f: FactorySettings): number {
  return Math.max(0, f.maxRounds + job.granted.rounds - job.round)
}

// What all jobs spent on the day of `now`. `usd` is null when any of it had no price.
function spentOn(jobs: Job[], now: number): { ms: number; usd: number | null; isAny: boolean } {
  const day = dayOf(now)
  const entries = jobs.flatMap(job => job.spend.filter(entry => entry.day === day))

  return {
    ms: entries.reduce((sum, entry) => sum + entry.ms, 0),
    usd: entries.every(entry => entry.usd !== null)
      ? round2(entries.reduce((sum, entry) => sum + (entry.usd ?? 0), 0))
      : null,
    isAny: entries.length > 0,
  }
}

// The cost or time limit `job` has reached, or null. `jobs` are all the jobs
// (the job itself may be among them; it is counted once). A job with a price
// is held to the cost limits; a job with none (also a price of zero for real
// work) is held to the time limits. What the person granted is added to the
// job's own limit.
export function limitOf(job: Job, jobs: Job[], f: FactorySettings, now: number): string | null {
  const all = [job, ...jobs.filter(other => other.id !== job.id)]
  const today = spentOn(all, now)
  const isPriced = job.costUsd !== null && !(job.costUsd === 0 && job.agentMs > 0)
  if (isPriced) {
    if ((job.costUsd ?? 0) > f.costLimitUsd.job + job.granted.usd) return 'cost limit for the job'
    const usd = all.reduce(
      (sum, other) => sum + (other.spend.find(entry => entry.day === dayOf(now))?.usd ?? 0),
      0,
    )

    return usd > f.costLimitUsd.day ? 'cost limit for the day' : null
  }
  if (job.agentMs > (f.timeLimitMin.job + job.granted.minutes) * MINUTE) return 'time limit for the job'

  return today.ms > f.timeLimitMin.day * MINUTE ? 'time limit for the day' : null
}

// The day's limit that all jobs together have reached, or null: the cost of
// the day when it is known, else its agent time. It counts every job that
// spent today, also one that ended. No new job starts past it.
export function dayLimitOf(jobs: Job[], f: FactorySettings, now: number): string | null {
  const today = spentOn(jobs, now)
  if (!today.isAny) return null
  if (today.usd !== null) return today.usd > f.costLimitUsd.day ? 'cost limit for the day' : null

  return today.ms > f.timeLimitMin.day * MINUTE ? 'time limit for the day' : null
}

// No new job starts on a nearly full disk. An unknown amount does not stop one.
export function canStart(freeDiskGb: number | null, f: FactorySettings): boolean {
  return freeDiskGb === null || freeDiskGb >= f.minFreeDiskGb
}

export type Today = {
  done: number
  minutes: number
  costUsd: number | null
  firstRound: number
  finished: number
}

// The day of `now`. `minutes` and `costUsd` are what every job spent today,
// also one that still runs. `done`, `finished` and `firstRound` count the jobs
// that ended today.
export function todayOf(jobs: Job[], now: number): Today {
  const ended = jobs.filter(job => isSameDay(job.updatedAt, now))
  const passed = ended.filter(job => job.stage === 'done' || job.stage === 'ready')
  const spent = spentOn(jobs, now)

  return {
    done: passed.length,
    minutes: Math.round(spent.ms / MINUTE),
    costUsd: spent.isAny ? spent.usd : null,
    firstRound: passed.filter(job => job.round === 1).length,
    finished: passed.length + ended.filter(job => job.stage === 'rejected').length,
  }
}
