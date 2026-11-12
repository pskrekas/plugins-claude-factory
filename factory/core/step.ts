// What a job needs next: the one decision of the line. Pure: it reads the job
// and a few facts, and answers a step. It starts no agent and changes nothing.
import type { FactorySettings, Role } from './factory-settings'
import { isActive } from './job'
import type { Asker, Job, Result, SentBack, Stage, move } from './job'
import { limitOf, roundsLeft } from './limits'
import { routeOf } from './route'

export type GateResult = { pass: boolean; why: string | null; needsPerson: boolean; sha: string | null }

export type Facts = {
  now: number
  f: FactorySettings
  // All live jobs, for the day's limit.
  jobs: Job[]
  // The agent ids the session still runs.
  live: string[]
  // The line starts no new station.
  isStopped: boolean
  // The result of the gate that was run for this job at its stage, if one was.
  gate: GateResult | null
  // The fence refused the same command of this job twice; `refused` is the command.
  isRepeatRefusal: boolean
  refused: string
}

export type MoveSet = NonNullable<Parameters<typeof move>[4]>
export type Step =
  | { do: 'wait' }
  // The agents of the station, started together.
  | { do: 'spawn'; agents: { role: Role; focus: string }[] }
  | { do: 'gate'; which: 'fast' | 'full' }
  | { do: 'move'; to: Stage; reason: string; set?: MoveSet }
  | { do: 'ask'; question: string; asker: Asker; resumeAt?: Stage; set?: MoveSet }
  // The station starts again, once.
  | { do: 'retry'; why: string }

const WAIT: Step = { do: 'wait' }
const MINUTE = 60_000
const NO_ANSWER = 'gave no answer the line can read'

const ask = (question: string, asker: Asker, more: { resumeAt?: Stage; set?: MoveSet } = {}): Step => ({
  do: 'ask',
  question,
  asker,
  ...(more.resumeAt === undefined ? {} : { resumeAt: more.resumeAt }),
  ...(more.set === undefined ? {} : { set: more.set }),
})
const nameOf = (who: { role: Role; focus: string }) => (who.focus === '' ? who.role : `${who.role} (${who.focus})`)
const spawn = (role: Role, focus = ''): Step => ({ do: 'spawn', agents: [{ role, focus }] })
const resultOf = (job: Job, role: Role): Result | undefined => job.results.find(result => result.role === role)

// Back to Build as a new round; or, with no round left, a question for the person.
function back(job: Job, f: FactorySettings, sentBack: SentBack, reason: string): Step {
  if (roundsLeft(job, f) === 0) {
    const rounds = f.maxRounds + job.granted.rounds

    return ask(`round limit: ${rounds} rounds with no pass`, 'limit', { resumeAt: 'build', set: { sentBack } })
  }

  return { do: 'move', to: 'build', reason, set: { sentBack } }
}

const needsYou = (gate: GateResult, resumeAt: Stage): Step => ask(`The gate needs you: ${gate.why ?? 'it could not run'}`, 'gate', { resumeAt })

// What the station's answers (or the gate's result) lead to. Null when the
// station has not started, or still misses an agent.
function answered(job: Job, facts: Facts): Step | null {
  const { f, gate } = facts
  switch (job.stage) {
    case 'intake': {
      const answer = resultOf(job, 'intake')?.answer
      if (answer?.kind === 'accept') {
        const route = routeOf(answer.risk, answer.surfaces, f)
        const set: MoveSet = { risk: answer.risk, surfaces: answer.surfaces, reviewers: route.reviewers }
        if (route.isOverRisk) return ask(`Risk ${answer.risk} is above the limit (${f.maxRisk}).`, 'intake', { resumeAt: 'spec', set })

        return { do: 'move', to: 'spec', reason: `accepted, risk ${answer.risk}`, set }
      }
      if (answer?.kind === 'needs-info') return ask(answer.question, 'intake')

      return answer?.kind === 'reject' ? { do: 'move', to: 'rejected', reason: answer.reason } : null
    }
    case 'spec':
      return resultOf(job, 'spec')?.answer?.kind === 'done' ? { do: 'move', to: 'build', reason: 'spec written' } : null
    case 'build': {
      const answer = resultOf(job, 'builder')?.answer
      if (answer?.kind === 'stuck') return ask(`The builder is stuck: ${answer.why}`, 'station', { resumeAt: 'build' })

      return answer?.kind === 'done' ? { do: 'move', to: 'gate', reason: 'built' } : null
    }
    case 'gate':
      if (gate === null) return null
      if (gate.needsPerson) return needsYou(gate, 'gate')

      return gate.pass
        ? { do: 'move', to: 'review', reason: 'checks passed' }
        : back(job, f, { by: 'gate', why: gate.why ?? 'checks failed' }, 'checks failed')
    case 'review': {
      if (job.reviewers.length === 0) return { do: 'move', to: 'approve', reason: 'no reviewer is routed' }
      const answers = job.reviewers.map(focus => job.results.find(result => result.role === 'reviewer' && result.focus === focus)?.answer)
      if (answers.some(answer => answer === undefined || answer === null)) return null
      const changes = answers.filter(answer => answer?.kind === 'changes').length
      if (changes === 0) return { do: 'move', to: 'approve', reason: 'reviewers passed' }

      return back(job, f, { by: 'review', why: `${changes} reviewer${changes === 1 ? '' : 's'} asked for changes` }, 'changes asked')
    }
    case 'approve': {
      const answer = resultOf(job, 'approver')?.answer
      if (answer?.kind === 'ask') return ask(answer.question, 'approve')
      if (answer?.kind !== 'ready') return null
      // Ready: the full checks decide, on the branch brought up to date with
      // the base. They merge, push and mark ready, so a stopped line waits.
      if (gate === null) return facts.isStopped ? WAIT : { do: 'gate', which: 'full' }
      if (gate.needsPerson) return needsYou(gate, 'approve')

      return gate.pass
        ? { do: 'move', to: 'ready', reason: 'full checks passed' }
        : back(job, f, { by: 'approve', why: gate.why ?? 'full checks failed' }, 'full checks failed')
    }
    default:
      return null
  }
}

// The first thing a station does.
function start(job: Job): Step {
  switch (job.stage) {
    case 'intake':
      return spawn('intake')
    case 'spec':
      return spawn('spec')
    case 'build':
      return spawn('builder')
    case 'gate':
      return { do: 'gate', which: 'fast' }
    case 'review': {
      // Only the reviewers that have not answered yet (after a restart some have).
      const have = job.results.filter(result => result.role === 'reviewer').map(result => result.focus)

      return { do: 'spawn', agents: job.reviewers.filter(focus => !have.includes(focus)).map(focus => ({ role: 'reviewer' as const, focus })) }
    }
    case 'approve':
      return spawn('approver')
    default:
      return WAIT
  }
}

export function nextStep(job: Job, facts: Facts): Step {
  const { f, now } = facts
  if (facts.isRepeatRefusal) return ask(`The fence refused the same command twice: ${facts.refused}`, 'fence')
  if (!isActive(job)) return WAIT

  // Agents at work: the job waits for them. One that is gone, or too slow,
  // makes the job ask at once: only a hook can start an agent, and the code
  // that sees the silence may be a timer (docs/notes/r2b-check.md).
  if (job.work.length > 0) {
    const lost = job.work.find(work => !facts.live.includes(work.agentId) || now - work.startedAt > f.stationTimeoutMin * MINUTE)

    return lost === undefined ? WAIT : ask(`The ${nameOf(lost)} did not answer. /factory answer ${job.itemId} starts it again.`, 'station')
  }

  // An answer that cannot be used: the station is tried once more, then the person is asked.
  const failed = job.results.find(result => result.answer === null || result.why !== null)
  if (failed !== undefined) {
    const why = failed.why ?? NO_ANSWER

    return job.tries === 0 ? { do: 'retry', why } : ask(`The ${nameOf(failed)} failed twice: ${why}`, 'station')
  }

  const next = answered(job, facts)
  if (next !== null) return next

  // The station has not started. A stopped line starts none; a limit asks first.
  if (facts.isStopped) return WAIT
  const limit = limitOf(job, facts.jobs, f, now)

  return limit === null ? start(job) : ask(limit, 'limit')
}
