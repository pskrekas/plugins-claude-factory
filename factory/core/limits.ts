// The limits of the line (design 8.1) and the totals of the day (5.4). Pure.
import type { FactorySettings } from './factory-settings'
import { isActive } from './job'
import type { Job } from './job'

const MINUTE = 60_000

export function freeSlots(jobs: Job[], f: FactorySettings): number {
  return Math.max(0, f.slots - jobs.filter(isActive).length)
}

// The same local calendar day.
export function isSameDay(a: number, b: number): boolean {
  const [x, y] = [new Date(a), new Date(b)]

  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

const round2 = (n: number) => Math.round(n * 100) / 100

// The first limit `job` has reached, or null. `jobs` are the others (the job
// itself may be among them; it is counted once).
export function limitOf(job: Job, jobs: Job[], f: FactorySettings, now: number): string | null {
  if (job.round > f.maxRounds) return 'round limit'
  const today = [job, ...jobs.filter(other => other.id !== job.id)].filter(j => isSameDay(j.updatedAt, now))
  if (job.costUsd !== null) {
    if (job.costUsd > f.costLimitUsd.job) return 'cost limit for the job'
    const spent = today.reduce((sum, j) => sum + (j.costUsd ?? 0), 0)

    return spent > f.costLimitUsd.day ? 'cost limit for the day' : null
  }
  // No price for this job: time stands in for cost.
  if (job.agentMs > f.timeLimitMin.job * MINUTE) return 'time limit for the job'
  const worked = today.reduce((sum, j) => sum + j.agentMs, 0)

  return worked > f.timeLimitMin.day * MINUTE ? 'time limit for the day' : null
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

// The jobs updated today. `minutes` and `costUsd` sum all of them, also one
// that still runs; `done`, `finished` and `firstRound` count those that ended.
export function todayOf(jobs: Job[], now: number): Today {
  const today = jobs.filter(job => isSameDay(job.updatedAt, now))
  const passed = today.filter(job => job.stage === 'done' || job.stage === 'ready')
  const isPriced = today.length > 0 && today.every(job => job.costUsd !== null)

  return {
    done: passed.length,
    minutes: Math.round(today.reduce((sum, job) => sum + job.agentMs, 0) / MINUTE),
    costUsd: isPriced ? round2(today.reduce((sum, job) => sum + (job.costUsd ?? 0), 0)) : null,
    firstRound: passed.filter(job => job.round === 1).length,
    finished: passed.length + today.filter(job => job.stage === 'rejected').length,
  }
}
