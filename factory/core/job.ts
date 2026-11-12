// A factory job: one tracker item on its way through the line (design 5.3).
// Pure. The store (hooks/jobs.ts) is the only code that writes a job to disk,
// and `move` is the only way a job changes its stage.
import { RISKS, ROLES } from './factory-settings'
import type { Risk, Role } from './factory-settings'
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

// Who stopped a job to ask: a station, or a limit of the line.
// `fence`: the same command was refused twice. `station`: an agent failed twice, or is stuck.
export type Asker = 'intake' | 'gate' | 'review' | 'approve' | 'limit' | 'fence' | 'station'

// An agent that works on the job now. `focus` says which reviewer (`code`, `ui`, …); '' for the other roles.
export type Work = { agentId: string; role: Role; focus: string; startedAt: number }

export type SentBack = { by: 'gate' | 'review' | 'approve' | 'you'; why: string }

// Agent time and its price on one local day (YYYY-MM-DD). The day limits sum
// these, so money spent yesterday on a job that ends today is not today's.
export type Spend = { day: string; ms: number; usd: number | null }

export type Job = {
  version: 1 // a file of another version is not read, so it is never rewritten
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
  costUsd: number | null // sum of the estimate; null when any piece had no price
  spend: Spend[] // the same, per day
  stageMs: Partial<Record<Stage, number>> // agent time per station
  // What the person allowed on top of the settings' limits, when a job that
  // reached one was told to go on.
  granted: { rounds: number; usd: number; minutes: number }
  branch: string | null // 'factory/<id>' once the job has a worktree
  itemUrl: string | null // the tracker item's address
  asker: Asker | null // who stopped the job, while it waits
  refusals: number // commands the fence refused
  feedback: number // how many feedback files the job has
  work: Work[] // the agents of the station that runs now; empty between stations
  refused: string[] // the newest refused commands, to see the same one twice
  tries: number // how often the station that runs now failed
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
  // A limit can stop a job at any station, and a person can drop it at any.
  spec: ['build', 'needs-human', 'rejected'],
  build: ['gate', 'needs-human', 'rejected'],
  gate: ['review', 'build', 'needs-human', 'rejected'],
  review: ['approve', 'build', 'needs-human', 'rejected'],
  approve: ['ready', 'build', 'needs-human', 'rejected'],
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
const MAX_SPEND = 60
// Where a job that asks can go back to (design 5.3).
const RESUMES: readonly Stage[] = ['intake', 'spec', 'build', 'gate', 'review', 'approve']
const ASKERS: readonly string[] = ['intake', 'gate', 'review', 'approve', 'limit', 'fence', 'station']
const MAX_WORK = 8
const MAX_REFUSED = 10
const MAX_COMMAND = 200
const FOCUS = /^[a-z0-9-]{1,20}$/

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
    version: 1,
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
    spend: [],
    stageMs: {},
    granted: { rounds: 0, usd: 0, minutes: 0 },
    branch: null,
    itemUrl: null,
    asker: null,
    refusals: 0,
    feedback: 0,
    work: [],
    refused: [],
    tries: 0,
    history: [{ at: now, from: null, to: 'intake', reason: 'started' }],
  }
}

export function move(
  job: Job,
  to: Stage,
  reason: string,
  now: number,
  set: Partial<
    Pick<Job, 'question' | 'sentBack' | 'risk' | 'surfaces' | 'reviewers' | 'pr' | 'stoppedIn' | 'asker' | 'branch' | 'itemUrl'>
  > = {},
): Job {
  const from = job.stage
  const isAsking = ASKS.includes(from)
  if (!TRANSITIONS[from].includes(to) && !(isAsking && to === job.stoppedIn)) {
    throw new IllegalMove(`${from} -> ${to}`)
  }
  // A move back to Build is a new round: from a station that sends it back
  // (it must say who), or from a stop that was made because no round was left.
  const isSentBack = to === 'build' && LOOPS_FROM.includes(from)
  if (isSentBack && !set.sentBack) throw new IllegalMove(`${from} -> build needs who sent it back`)
  // A stop that was made in Build itself (a cost or time limit in the middle
  // of a round) goes on in the same round: no station judged it again.
  const stoppedFrom = job.history.at(-1)?.from
  const isLoop = isSentBack || (to === 'build' && isAsking && job.sentBack !== null && stoppedFrom !== 'build')
  if (ASKS.includes(to) && !set.question) throw new IllegalMove(`${from} -> ${to} needs a question`)

  // Only what `set` really gives is applied, and its text is cut: a job that
  // was moved must still be a job file the store can read back.
  const next: Job = {
    ...job,
    stage: to,
    round: isLoop ? job.round + 1 : job.round,
    // Every move starts clean: no agent of the last station, no failed try.
    work: [],
    tries: 0,
    updatedAt: now,
    history: [...job.history, { at: now, from, to, reason: reason.slice(0, MAX.reason) }].slice(-MAX_HISTORY),
  }
  if (set.question != null) next.question = set.question.slice(0, MAX.question)
  if (set.sentBack != null) next.sentBack = { by: set.sentBack.by, why: set.sentBack.why.slice(0, MAX.why) }
  if (set.risk !== undefined) next.risk = set.risk
  if (set.surfaces !== undefined) next.surfaces = set.surfaces.slice(0, MAX_NAMES).map(name => name.slice(0, MAX.name))
  if (set.reviewers !== undefined) next.reviewers = set.reviewers.slice(0, MAX_NAMES).map(name => name.slice(0, MAX.name))
  if (set.pr !== undefined) next.pr = set.pr

  if (set.branch !== undefined) next.branch = set.branch
  if (set.itemUrl !== undefined) next.itemUrl = set.itemUrl === null ? null : set.itemUrl.slice(0, MAX.url)
  if (ASKS.includes(to)) {
    // Where it goes back to: what the caller says, or, stopped at intake for
    // its risk, on to spec when the person lets it; else where it was.
    const back = set.stoppedIn ?? (from === 'intake' && to === 'needs-human' ? 'spec' : from)
    if (!RESUMES.includes(back)) throw new IllegalMove(`${to} cannot go back to ${back}`)
    next.stoppedIn = back
    next.asker = set.asker ?? null
  } else if (isAsking) {
    next.stoppedIn = null
    next.question = null
    next.asker = null
  }
  // Once the reviewers pass a round, nobody "sent it back" any more.
  if (to === 'approve' || to === 'ready') next.sentBack = null

  return next
}

// Stops a job to ask: the item's author (intake's question) or the person.
export function stop(
  job: Job,
  why: { question: string; asker: Asker; resumeAt?: Stage },
  now: number,
): Job {
  const to: Stage = why.asker === 'intake' && why.resumeAt === undefined ? 'needs-info' : 'needs-human'

  return move(job, to, `${why.asker} asks`, now, {
    question: why.question,
    asker: why.asker,
    ...(why.resumeAt === undefined ? {} : { stoppedIn: why.resumeAt }),
  })
}

// Sends a job that asked back to the station it stopped in.
export function resume(job: Job, reason: string, now: number): Job {
  if (!ASKS.includes(job.stage) || job.stoppedIn === null) throw new IllegalMove(`${job.stage} is not a stop to resume`)

  return move(job, job.stoppedIn, reason, now)
}

// Drops a job, from any stage it is alive in.
export function reject(job: Job, reason: string, now: number): Job {
  return move(job, 'rejected', reason, now)
}

// An agent starts on the job. A job holds at most eight; one more is not added.
export function startWork(job: Job, work: Work, now: number): Job {
  return job.work.length >= MAX_WORK ? job : { ...job, work: [...job.work, work], updatedAt: now }
}

// An agent of the job ended.
export function endWork(job: Job, agentId: string, now: number): Job {
  return { ...job, work: job.work.filter(work => work.agentId !== agentId), updatedAt: now }
}

export function clearWork(job: Job, now: number): Job {
  return { ...job, work: [], updatedAt: now }
}

// The station that runs now failed once more.
export function failStation(job: Job, now: number): Job {
  return { ...job, tries: job.tries + 1, updatedAt: now }
}

// The fence refused a command of the job's agent. `isRepeat`: the same
// command was refused before (design 8.1: twice stops the job).
export function noteRefusal(job: Job, command: string, now: number): { job: Job; isRepeat: boolean } {
  const text = command.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAX_COMMAND)
  const isRepeat = job.refused.includes(text)
  const refused = isRepeat ? job.refused : [...job.refused, text].slice(-MAX_REFUSED)

  return { job: { ...job, refusals: job.refusals + 1, refused, updatedAt: now }, isRepeat }
}

// Adds to what the person allowed on top of the limits.
export function grant(job: Job, more: { rounds?: number; usd?: number; minutes?: number }, now: number): Job {
  const add = (have: number, extra: number | undefined) => Math.max(0, have + (extra ?? 0))

  return {
    ...job,
    granted: {
      rounds: add(job.granted.rounds, more.rounds),
      usd: add(job.granted.usd, more.usd),
      minutes: add(job.granted.minutes, more.minutes),
    },
    updatedAt: now,
  }
}

// The local calendar day of a time, as YYYY-MM-DD.
export function dayOf(time: number): string {
  const d = new Date(time)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

const round2 = (n: number) => Math.round(n * 100) / 100

// Adds the time and the price of one agent run to a job: to its sums, to the
// day's entry and to the station's time. `usd` is null when the run could not
// be priced; then the day and the job have no price any more.
export function addSpend(job: Job, stage: Stage, ms: number, usd: number | null, now: number): Job {
  const day = dayOf(now)
  const before = job.spend.find(entry => entry.day === day)
  const today: Spend = {
    day,
    ms: (before?.ms ?? 0) + ms,
    usd: usd === null || before?.usd === null ? null : round2((before?.usd ?? 0) + usd),
  }
  const spend = [...job.spend.filter(entry => entry.day !== day), today].slice(-MAX_SPEND)
  const isPriced = spend.every(entry => entry.usd !== null)

  return {
    ...job,
    agentMs: job.agentMs + ms,
    costUsd: isPriced ? round2(spend.reduce((sum, entry) => sum + (entry.usd ?? 0), 0)) : null,
    spend,
    stageMs: { ...job.stageMs, [stage]: (job.stageMs[stage] ?? 0) + ms },
    updatedAt: now,
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
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
  if (!isObject(raw) || raw.version !== 1) return null
  const { id, itemId, title, stage, round, risk, stoppedIn, question, sentBack, pr, costUsd } = raw
  if (typeof id !== 'string' || id !== folder || !isJobId(id)) return null
  if (typeof itemId !== 'string' || typeof title !== 'string' || !isStage(stage)) return null
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) return null
  if (risk !== null && !RISKS.includes(risk as Risk)) return null
  if (question !== null && typeof question !== 'string') return null
  // A job that asks says where it goes back to, and what it asks; no other job does.
  if (ASKS.includes(stage)) {
    if (!RESUMES.includes(stoppedIn as Stage) || !question) return null
  } else if (stoppedIn !== null) {
    return null
  }
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
    if (!isObject(pr) || !isCount(pr.number) || !Number.isInteger(pr.number)) return null
    if (typeof pr.url !== 'string') return null
    pull = { number: pr.number, url: cut(pr.url, MAX.url) }
  }
  if (!Array.isArray(raw.history)) return null
  const history: Job['history'] = []
  for (const entry of raw.history.slice(-MAX_HISTORY)) {
    if (!isObject(entry) || !isCount(entry.at) || !isStage(entry.to)) return null
    if ((entry.from !== null && !isStage(entry.from)) || typeof entry.reason !== 'string') return null
    history.push({ at: entry.at, from: entry.from, to: entry.to, reason: cut(entry.reason, MAX.reason) })
  }

  const granted = raw.granted
  if (!isObject(granted) || !isCount(granted.rounds) || !isCount(granted.usd) || !isCount(granted.minutes)) return null
  if (!Array.isArray(raw.spend) || !isObject(raw.stageMs)) return null
  const spend: Spend[] = []
  for (const entry of raw.spend.slice(-MAX_SPEND)) {
    if (!isObject(entry) || typeof entry.day !== 'string' || !DAY.test(entry.day)) return null
    if (!isCount(entry.ms) || (entry.usd !== null && !isCount(entry.usd))) return null
    spend.push({ day: entry.day, ms: entry.ms, usd: entry.usd })
  }
  const stageMs: Job['stageMs'] = {}
  for (const [name, ms] of Object.entries(raw.stageMs)) {
    if (!isStage(name) || !isCount(ms)) return null
    stageMs[name] = ms
  }

  // Fields a file of the first line version does not have read as their defaults.
  const { branch = null, itemUrl = null, asker = null, refusals = 0, feedback = 0 } = raw
  const { work = [], refused = [], tries = 0 } = raw
  if (!Array.isArray(work) || work.length > MAX_WORK || !Array.isArray(refused)) return null
  const inFlight: Work[] = []
  for (const entry of work) {
    if (!isObject(entry) || typeof entry.agentId !== 'string' || !/^[\x21-\x7e]{1,100}$/.test(entry.agentId)) return null
    if (!ROLES.includes(entry.role as Role) || !isCount(entry.startedAt)) return null
    if (typeof entry.focus !== 'string' || (entry.focus !== '' && !FOCUS.test(entry.focus))) return null
    inFlight.push({ agentId: entry.agentId, role: entry.role as Role, focus: entry.focus, startedAt: entry.startedAt })
  }
  if (!refused.every(text => typeof text === 'string')) return null
  if (!isCount(tries) || !Number.isInteger(tries)) return null
  if (branch !== null && branch !== `factory/${id}`) return null
  if (itemUrl !== null && typeof itemUrl !== 'string') return null
  if (asker !== null && !ASKERS.includes(asker as string)) return null
  if (!isCount(refusals) || !isCount(feedback) || !Number.isInteger(refusals) || !Number.isInteger(feedback)) return null

  return {
    version: 1,
    id,
    itemId: cut(itemId, MAX.itemId),
    title: cut(title, MAX.title),
    stage,
    round,
    risk: risk as Risk | null,
    surfaces,
    reviewers,
    stoppedIn: stoppedIn as Stage | null,
    question: question === null ? null : cut(question, MAX.question),
    sentBack: back,
    pr: pull,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    agentMs: raw.agentMs,
    costUsd,
    spend,
    stageMs,
    granted: { rounds: granted.rounds, usd: granted.usd, minutes: granted.minutes },
    branch: branch as string | null,
    itemUrl: itemUrl === null ? null : cut(itemUrl as string, MAX.url),
    asker: asker as Asker | null,
    refusals,
    feedback,
    work: inFlight,
    refused: (refused as string[]).slice(-MAX_REFUSED).map(text => cut(text, MAX_COMMAND)),
    tries,
    history,
  }
}
