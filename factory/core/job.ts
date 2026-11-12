// A factory job: one tracker item on its way through the line (design 5.3).
// Pure. The store (hooks/jobs.ts) is the only code that writes a job to disk,
// and `move` is the only way a job changes its stage.
import { RISKS } from './factory-settings'
import type { Risk } from './factory-settings'
import { isObject } from './rules'

export type Stage =
  | 'intake'
  | 'needs-info'
  | 'spec'
  | 'build'
  | 'gate'
  | 'review'
  | 'approve'
  | 'needs-human'
  | 'ready'
  | 'done'
  | 'rejected'

export type SentBack = { by: 'gate' | 'review' | 'approve' | 'you'; why: string }

export type Job = {
  id: string // the name of its folder
  itemId: string // the tracker's id, as the person knows it
  title: string
  stage: Stage
  round: number // starts at 1; +1 at every move back to `build`
  risk: Risk | null
  surfaces: string[]
  reviewers: string[]
  stoppedIn: Stage | null // while the job waits: the stage it goes back to
  question: string | null // what the person or the author is asked
  sentBack: SentBack | null
  pr: { number: number; url: string } | null
  createdAt: number
  updatedAt: number
  agentMs: number // sum of agent time
  costUsd: number | null // sum of the estimate; null when it cannot be priced
  history: { at: number; from: Stage | null; to: Stage; reason: string }[]
}

export const STAGES: readonly Stage[] = [
  'intake',
  'needs-info',
  'spec',
  'build',
  'gate',
  'review',
  'approve',
  'needs-human',
  'ready',
  'done',
  'rejected',
]

// A waiting stage also goes back to the one stage in `stoppedIn`.
export const TRANSITIONS: Record<Stage, readonly Stage[]> = {
  intake: ['spec', 'needs-info', 'needs-human', 'rejected'],
  'needs-info': ['rejected'],
  spec: ['build'],
  build: ['gate'],
  gate: ['review', 'build', 'needs-human'],
  review: ['approve', 'build', 'needs-human'],
  approve: ['ready', 'build', 'needs-human'],
  'needs-human': ['rejected'],
  ready: ['done', 'build', 'rejected'],
  done: [],
  rejected: [],
}

const ACTIVE: readonly Stage[] = ['intake', 'spec', 'build', 'gate', 'review', 'approve']
const ASKS: readonly Stage[] = ['needs-info', 'needs-human']
// A move to `build` from one of these is a loop: a new round.
const LOOPS_FROM: readonly Stage[] = ['gate', 'review', 'approve', 'ready']
const SENDERS: readonly string[] = ['gate', 'review', 'approve', 'you']

const ID = /^[a-z0-9][a-z0-9-]{0,59}$/
const MAX_ID = 60
const MAX = { itemId: 40, title: 200, question: 500, why: 300, reason: 200, url: 300, name: 40 }
const MAX_HISTORY = 100
const MAX_NAMES = 10

export class IllegalMove extends Error {}

export const isActive = (job: Job): boolean => ACTIVE.includes(job.stage)
export const isWaiting = (job: Job): boolean => ASKS.includes(job.stage) || job.stage === 'ready'
export const isFinished = (job: Job): boolean => job.stage === 'done' || job.stage === 'rejected'

export function isJobId(id: string): boolean {
  return ID.test(id)
}

// The runs of ASCII letters and digits of the item id, then of the title,
// lower-cased and joined by `-`. Nothing else of either text gets into a path.
export function jobIdOf(itemId: string, title: string): string {
  const words = `${itemId} ${title}`.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const id = words.join('-').slice(0, MAX_ID).replace(/-+$/, '')

  return id === '' ? 'job' : id
}

export function newJob(item: { id: string; title: string }, now: number): Job {
  return {
    id: jobIdOf(item.id, item.title),
    itemId: item.id.slice(0, MAX.itemId),
    title: item.title.slice(0, MAX.title),
    stage: 'intake',
    round: 1,
    risk: null,
    surfaces: [],
    reviewers: [],
    stoppedIn: null,
    question: null,
    sentBack: null,
    pr: null,
    createdAt: now,
    updatedAt: now,
    agentMs: 0,
    costUsd: null,
    history: [{ at: now, from: null, to: 'intake', reason: 'started' }],
  }
}

export function move(
  job: Job,
  to: Stage,
  reason: string,
  now: number,
  set: Partial<Pick<Job, 'question' | 'sentBack' | 'risk' | 'surfaces' | 'reviewers' | 'pr'>> = {},
): Job {
  const from = job.stage
  const isAsking = ASKS.includes(from)
  if (!TRANSITIONS[from].includes(to) && !(isAsking && to === job.stoppedIn)) {
    throw new IllegalMove(`${from} -> ${to}`)
  }
  const isLoop = to === 'build' && LOOPS_FROM.includes(from)
  if (isLoop && !set.sentBack) throw new IllegalMove(`${from} -> build needs who sent it back`)

  const next: Job = {
    ...job,
    ...set,
    stage: to,
    round: isLoop ? job.round + 1 : job.round,
    updatedAt: now,
    history: [...job.history, { at: now, from, to, reason: reason.slice(0, MAX.reason) }].slice(-MAX_HISTORY),
  }
  if (ASKS.includes(to)) {
    // Stopped at intake for its risk, the job goes on to spec when the person
    // lets it; stopped anywhere else, it goes back where it was.
    next.stoppedIn = from === 'intake' && to === 'needs-human' ? 'spec' : from
  } else if (isAsking) {
    next.stoppedIn = null
    next.question = null
  }
  // Once the reviewers pass a round, nobody "sent it back" any more.
  if (to === 'approve' || to === 'ready') next.sentBack = null

  return next
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isStage = (v: unknown): v is Stage => STAGES.includes(v as Stage)
const cut = (v: string, max: number) => v.slice(0, max)

// A list of short strings, or null when it is not one.
function names(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every(item => typeof item === 'string')) return null

  return v.slice(0, MAX_NAMES).map(item => cut(item, MAX.name))
}

// A job file is data from disk: every field is checked, text is cut, and
// anything that does not fit gives null.
export function parseJob(text: string, folder: string): Job | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  const { id, itemId, title, stage, round, risk, stoppedIn, question, sentBack, pr, costUsd } = raw
  if (typeof id !== 'string' || id !== folder || !isJobId(id)) return null
  if (typeof itemId !== 'string' || typeof title !== 'string' || !isStage(stage)) return null
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) return null
  if (risk !== null && !RISKS.includes(risk as Risk)) return null
  if (stoppedIn !== null && !isStage(stoppedIn)) return null
  if (question !== null && typeof question !== 'string') return null
  if (costUsd !== null && !isCount(costUsd)) return null
  if (!isCount(raw.createdAt) || !isCount(raw.updatedAt) || !isCount(raw.agentMs)) return null
  const surfaces = names(raw.surfaces)
  const reviewers = names(raw.reviewers)
  if (surfaces === null || reviewers === null) return null

  let back: SentBack | null = null
  if (sentBack !== null) {
    if (!isObject(sentBack) || !SENDERS.includes(sentBack.by as string)) return null
    if (typeof sentBack.why !== 'string') return null
    back = { by: sentBack.by as SentBack['by'], why: cut(sentBack.why, MAX.why) }
  }
  let pull: Job['pr'] = null
  if (pr !== null) {
    if (!isObject(pr) || !isCount(pr.number) || typeof pr.url !== 'string') return null
    pull = { number: pr.number, url: cut(pr.url, MAX.url) }
  }
  if (!Array.isArray(raw.history)) return null
  const history: Job['history'] = []
  for (const entry of raw.history.slice(-MAX_HISTORY)) {
    if (!isObject(entry) || !isCount(entry.at) || !isStage(entry.to)) return null
    if ((entry.from !== null && !isStage(entry.from)) || typeof entry.reason !== 'string') return null
    history.push({ at: entry.at, from: entry.from, to: entry.to, reason: cut(entry.reason, MAX.reason) })
  }

  return {
    id,
    itemId: cut(itemId, MAX.itemId),
    title: cut(title, MAX.title),
    stage,
    round,
    risk: risk as Risk | null,
    surfaces,
    reviewers,
    stoppedIn,
    question: question === null ? null : cut(question, MAX.question),
    sentBack: back,
    pr: pull,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    agentMs: raw.agentMs,
    costUsd,
    history,
  }
}
