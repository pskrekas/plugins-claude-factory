// The line: the code that moves the jobs.
//
// `advance` is called only in a hook that is still running (`/factory run`,
// `/factory answer`, the `turn.complete` hook of a factory agent), because an
// agent is fenced only when such a hook starts it (docs/notes/r2b-check.md).
// One call advances at a time; a call that finds another at work returns at
// once, and the one at work reads the fact that the caller left in the inbox.
//
// `watch` is for the timer. It starts no agent: it keeps the lock alive, makes
// a job whose agent is gone ask the person, and sees a merged pull request.
import { createDraftPr, commentPr, readPrByNumber, readyPr } from '../adapters/github-pr'
import { answerOf } from '../core/answer'
import { briefOf } from '../core/agents'
import { parseDfFreeGb } from '../core/checks'
import { branchOf } from '../core/git-args'
import { clearWork, failStation, isActive, isFinished, move, newJob, noteRefusal, noteResult, startWork, stop } from '../core/job'
import type { Job, Stage } from '../core/job'
import { canStart, freeSlots, limitOf } from '../core/limits'
import { clean } from '../core/rows'
import { nextStep } from '../core/step'
import type { GateResult, Step } from '../core/step'
import { descriptionOf } from './agent-events'
import type { Spawn } from './agent-events'
import { context } from './context'
import type { Ctx } from './context'
import { runGate } from './gate'
import { drainFacts } from './inbox'
import type { Io } from './io'
import { isStopped, lockInfo, readJobs, releaseLock, retireJob, stateDirOf, takeLock, writeJob } from './jobs'
import { readInside } from './readers/files'
import { endRun, readRun, writeRun } from './run'
import { collect, discardOut, spendOf, writeDiff, writeItem } from './station'
import { addWorktree, baseHeadOf, dropBranch, headOf, pushCommit, removeCleanCopy, removeWorktree, syncBase } from './worktrees'

export type Advanced = { ran: boolean; started: number; moved: number; isDone: boolean; note: string | null }

const IDLE: Advanced = { ran: false, started: 0, moved: 0, isDone: false, note: null }
const MAX_PASSES = 12
const MAX_STEPS = 8
const MERGE_ASK_MS = 300_000
const NO_ANSWER = 'gave no answer the line can read'
// What the timer's stand-in for `Spawn` answers: the station is left for a hook.
const LATER = 'later'
const UNSEEN = 'the fence did not see this agent'

let isAdvancing = false
// The gate's result for a job, until the job's next step read it or the job moved.
const gates = new Map<string, { stage: Stage; round: number; result: GateResult }>()
// A command the fence refused twice, by job, until the job asked.
const repeats = new Map<string, string>()
const mergeAsked = new Map<string, number>()
// How many items this run refused at intake, for the last line of the run.
let tally = { startedAt: 0, rejected: 0 }

const why = (error: unknown) => clean(String(error instanceof Error ? error.message : error)).slice(0, 200)
export const liveOf = (agents: readonly { id: string; status: string }[]) =>
  agents.filter(agent => agent.status !== 'failed' && agent.status !== 'killed').map(agent => agent.id)

async function freeDiskGb(io: Io, dir: string): Promise<number | null> {
  const df = await io.run(['df', '-Pk', dir], { timeoutMs: 5_000 })

  return 'failed' in df || df.exitCode !== 0 ? null : parseDfFreeGb(df.stdout)
}

// What is left of a job that ended: its worktree, the gate's copy, its folder.
async function tidy(io: Io, root: string, dir: string, job: Job, now: number): Promise<void> {
  if ((await io.stat(`${dir}/worktrees/${job.id}`)) !== null) await removeWorktree(io, root, job.id).catch(() => undefined)
  if ((await io.stat(`${dir}/gate/${job.id}`)) !== null) await removeCleanCopy(io, root, job.id).catch(() => undefined)
  // The local branch goes too, so the item can run again.
  if (job.branch !== null && (await headOf(io, root, job.id)) !== null) await dropBranch(io, root, job.id).catch(() => undefined)
  await retireJob(io, root, job.id, now).catch(() => undefined)
  gates.delete(job.id)
  repeats.delete(job.id)
  mergeAsked.delete(job.id)
}

// The first lines of a report's summary, as plain text.
async function summaryOf(io: Io, dir: string, job: Job, name: string): Promise<string[]> {
  const text = (await readInside(io, dir, `jobs/${job.id}/files/round-${job.round}/${name}`, 200_000)) ?? ''
  const lines = text.split('\n')
  const from = lines.findIndex(line => line.trim() === '## Summary')
  if (from < 0) return []
  const out: string[] = []
  for (const line of lines.slice(from + 1)) {
    if (line.startsWith('#') || out.length >= 5) break
    if (line.trim() !== '') out.push(clean(line).slice(0, 300))
  }

  return out
}

type Pass = Advanced & { changed: boolean }

async function pass(io: Io, spawn: Spawn): Promise<Pass> {
  const idle: Pass = { ...IDLE, changed: false }
  const ctx: Ctx = await context(io)
  const { root, f } = ctx
  const run = await readRun(io, root)
  const dir = await stateDirOf(io, root)
  if (run === null || dir === null || run.session !== (await io.sessionId())) return idle
  if (!(await takeLock(io, root, ctx.now)).isHeld) return idle
  if (tally.startedAt !== run.startedAt) tally = { startedAt: run.startedAt, rejected: 0 }
  const out: Pass = { ran: true, started: 0, moved: 0, isDone: false, note: null, changed: false }
  let jobs = (await readJobs(io, root)).jobs.filter(job => !isFinished(job))
  const save = async (job: Job) => {
    await writeJob(io, root, job)
    jobs = jobs.some(one => one.id === job.id) ? jobs.map(one => (one.id === job.id ? job : one)) : [...jobs, job]
    out.changed = true

    return job
  }
  const drop = (id: string) => {
    jobs = jobs.filter(one => one.id !== id)
  }
  const tell = (job: Job, what: string, error: unknown) => {
    out.note = `${clean(job.itemId)}: ${what} (${why(error)})`
  }

  // What the hooks learned: a refused command, the end of an agent's turn.
  for (const fact of await drainFacts(io, root)) {
    const job = jobs.find(one => one.work.some(work => work.agentId === fact.agentId))
    const work = job?.work.find(one => one.agentId === fact.agentId)
    if (job === undefined || work === undefined) continue
    if (fact.kind === 'refusal') {
      const noted = noteRefusal(job, fact.command, ctx.now)
      if (noted.isRepeat) repeats.set(job.id, fact.command)
      await save(noted.job)
      continue
    }
    const spent = spendOf(job, fact, f, ctx.now)
    const answer = fact.reason === 'answer' ? answerOf(work.role, fact.answer) : null
    const got = answer === null ? null : await collect(io, root, spent, work.role, work.focus)
    const reason = got === null ? NO_ANSWER : got.ok ? null : got.why
    await save(noteResult(spent, { role: work.role, focus: work.focus, answer, why: reason }, ctx.now))
  }

  const stopped = await isStopped(io, root)
  const live = liveOf(await io.agents())
  const order = jobs.filter(isActive).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(job => job.id)
  let isOutsideFence = false

  for (const id of order) {
    for (let n = 0; n < MAX_STEPS && !isOutsideFence; n++) {
      const job = jobs.find(one => one.id === id)
      if (job === undefined || !isActive(job)) break
      const kept = gates.get(id)
      const gate = kept !== undefined && kept.stage === job.stage && kept.round === job.round ? kept.result : null
      const step: Step = nextStep(job, { now: ctx.now, f, jobs, live, isStopped: stopped, gate, isRepeatRefusal: repeats.has(id), refused: repeats.get(id) ?? '' })
      if (step.do === 'wait') break

      if (step.do === 'spawn') {
        let next = job
        let isLater = false
        for (const agent of step.agents) {
          const got = await spawn({
            role: agent.role,
            description: descriptionOf(agent.role, agent.focus, job.id),
            prompt: briefOf(agent.role, { jobId: job.id, itemId: job.itemId, round: job.round, focus: agent.focus, files: `${dir}/jobs/${job.id}/files`, out: `${dir}/jobs/${job.id}/out`, worktree: `${dir}/worktrees/${job.id}` }),
          })
          if ('agentId' in got) {
            next = startWork(next, { agentId: got.agentId, role: agent.role, focus: agent.focus, startedAt: ctx.now }, ctx.now)
            out.started += 1
          } else if (got.no === LATER) {
            isLater = true
            break
          } else {
            isOutsideFence = got.no === UNSEEN
            next = noteResult(next, { role: agent.role, focus: agent.focus, answer: null, why: `could not start: ${got.no}` }, ctx.now)
          }
        }
        if (next !== job) await save(next)
        // The station runs now (or waits for a hook): nothing more for this job in this pass.
        if (isLater || next.work.length > 0) break
        continue
      }

      if (step.do === 'retry') {
        for (const result of job.results) await discardOut(io, root, job, result.role, result.focus)
        await save(clearWork(failStation(job, ctx.now), ctx.now))
        continue
      }

      if (step.do === 'gate') {
        // A gate can run for longer than the lock lives: it is refreshed first, and the timer keeps it.
        await takeLock(io, root, await io.now())
        let result: GateResult | null = null
        if (step.which === 'full') {
          const sync = await syncBase(io, root, job.id, ctx.base)
          if (!sync.ok || sync.sha === undefined) {
            const text = sync.ok ? 'the merged commit could not be read' : (sync.why ?? 'git failed')
            result = { pass: false, why: text, needsPerson: !text.startsWith('conflict'), sha: null }
          } else {
            const pushed = await pushCommit(io, root, job.id, sync.sha)
            if (!pushed.ok) result = { pass: false, why: `the push failed: ${pushed.why ?? ''}`, needsPerson: true, sha: null }
          }
        }
        gates.set(id, { stage: job.stage, round: job.round, result: result ?? (await runGate(io, root, job, ctx.base, step.which)) })
        out.changed = true
        continue
      }

      if (step.do === 'ask') {
        try {
          // Intake's question is for the item's author; every other one is for the person who runs the line.
          const isForAuthor = step.asker === 'intake' && step.resumeAt === undefined
          await ctx.tracker?.comment(job.itemId, isForAuthor ? `The factory has a question about this item: ${step.question}` : `The factory needs a person: ${step.question}`)
          await ctx.tracker?.setState(job.itemId, 'needs-human')
        } catch (error) {
          tell(job, 'the item could not be told', error)
          break
        }
        const set = step.set ?? {}
        const before: Job = {
          ...job,
          ...(set.risk !== undefined ? { risk: set.risk } : {}),
          ...(set.surfaces !== undefined ? { surfaces: set.surfaces } : {}),
          ...(set.reviewers !== undefined ? { reviewers: set.reviewers } : {}),
          ...(set.sentBack != null ? { sentBack: set.sentBack } : {}),
        }
        await save(stop(before, { question: step.question, asker: step.asker, ...(step.resumeAt === undefined ? {} : { resumeAt: step.resumeAt }) }, ctx.now))
        gates.delete(id)
        repeats.delete(id)
        out.moved += 1
        io.toast(`Factory: ${clean(job.itemId)} needs you.`)
        io.sound()
        break
      }

      // A move of the state machine. Its effects come first; when one fails
      // the job stays where it is and the next call tries again.
      let set = step.set ?? {}
      try {
        if (job.stage === 'build' && step.to === 'gate') {
          const [sha, baseSha] = [await headOf(io, root, job.id), await baseHeadOf(io, root, ctx.base)]
          if (sha === null || baseSha === null) throw new Error('the branch could not be read')
          // A branch with no commit of its own is not pushed: the gate will say so.
          if (sha !== baseSha) {
            const pushed = await pushCommit(io, root, job.id, sha)
            if (!pushed.ok) throw new Error(pushed.why ?? 'the push failed')
            if (job.pr === null && ctx.tracker !== null) {
              const body = `Built by the factory line for item ${job.itemId}.${job.itemUrl === null ? '' : `\n\n${job.itemUrl}`}`
              const made = await createDraftPr(ctx.run, { head: branchOf(job.id), base: ctx.base, title: `${job.itemId}: ${job.title}`, body })
              if (made.pr === null) throw new Error('the pull request could not be opened')
              // Kept at once: a second try must not open a second pull request.
              await save({ ...job, pr: made.pr })
              set = { ...set, pr: made.pr }
              await ctx.tracker.linkPr(job.itemId, made.pr.url).catch(error => tell(job, 'the pull request was not linked', error))
            } else if (job.pr !== null) {
              await commentPr(ctx.run, job.pr.number, `Round ${job.round} pushed.`)
            }
          }
        }
        if ((job.stage === 'gate' && step.to === 'review') || step.to === 'ready') {
          // What goes on is the commit the gate judged. A branch that moved is gated again.
          const sha = await headOf(io, root, job.id)
          if (gate === null || sha === null || gate.sha !== sha) {
            gates.delete(id)
            out.changed = true
            continue
          }
          if (step.to === 'review') {
            const baseSha = await baseHeadOf(io, root, ctx.base)
            if (baseSha === null || !(await writeDiff(io, root, job, baseSha, sha))) throw new Error('the change could not be written for the reviewers')
          }
        }
        if (step.to === 'ready') {
          if (job.pr !== null) {
            const made = await readyPr(ctx.run, job.pr.number)
            if ('failed' in made || made.exitCode !== 0) throw new Error('the pull request could not be marked ready')
          }
          const summary = await summaryOf(io, dir, job, 'decision.md')
          const text = [`The factory finished this. The pull request is ready for you to merge: ${job.pr?.url ?? '(no pull request)'}`, '', ...summary].join('\n')
          await ctx.tracker?.comment(job.itemId, text)
          await ctx.tracker?.setState(job.itemId, 'needs-human')
        }
        if (step.to === 'rejected') {
          await ctx.tracker?.comment(job.itemId, `The factory did not take this: ${step.reason}`)
          await ctx.tracker?.setState(job.itemId, 'rejected')
        }
      } catch (error) {
        tell(job, 'the step could not be done', error)
        break
      }
      const current = jobs.find(one => one.id === id) ?? job
      const moved = await save(move(current, step.to, step.reason, ctx.now, set))
      gates.delete(id)
      out.moved += 1
      if (step.to === 'ready') {
        io.toast(`Factory: ${clean(job.itemId)} is ready. You merge.`)
        io.sound()
      }
      if (isFinished(moved)) {
        tally.rejected += 1
        await tidy(io, root, dir, moved, ctx.now)
        drop(id)
      }
    }
    if (isOutsideFence) break
  }

  // New jobs from the queue, while a slot is free.
  let queue = [...run.queue]
  const isDayOver = () => jobs.some(job => (limitOf(job, jobs, f, ctx.now) ?? '').endsWith('for the day'))
  while (queue.length > 0 && !stopped && !isOutsideFence && ctx.tracker !== null && freeSlots(jobs, f) > 0 && !isDayOver()) {
    if (!canStart(await freeDiskGb(io, dir), f)) {
      out.note = 'The disk is nearly full: no new job starts.'
      break
    }
    const [itemId = '', ...rest] = queue
    queue = rest
    await writeRun(io, root, { ...run, queue })
    out.changed = true
    if (jobs.some(job => job.itemId === itemId)) continue
    const item = await ctx.tracker.read(itemId).catch(() => null)
    if (item === null) {
      out.note = `${clean(itemId)}: the item could not be read`
      continue
    }
    const fresh = newJob({ id: item.id, title: item.title }, ctx.now)
    const job: Job = { ...fresh, branch: branchOf(fresh.id), itemUrl: item.url === '' ? null : item.url }
    const tree = await addWorktree(io, root, job.id, ctx.base)
    if (!tree.ok) {
      out.note = `${clean(itemId)}: no worktree (${tree.why})`
      continue
    }
    await writeItem(io, root, job, item)
    await save(job)
    // The claim: another machine's queue no longer holds the item.
    try {
      await ctx.tracker.setState(itemId, 'in-progress')
      await ctx.tracker.comment(itemId, 'The factory started on this.')
    } catch (error) {
      tell(job, 'the item could not be told', error)
    }
  }

  // Nothing left to do: the run ends. A stopped line is done when no agent works.
  const active = jobs.filter(isActive)
  out.isDone = !isOutsideFence && (stopped ? active.every(job => job.work.length === 0) : queue.length === 0 && active.length === 0)
  if (out.isDone) {
    await endRun(io, root)
    await releaseLock(io, root).catch(() => undefined)
    gates.clear()
    const ready = jobs.filter(job => job.stage === 'ready').length
    const need = jobs.filter(job => job.stage === 'needs-info' || job.stage === 'needs-human').length
    io.toast(`The factory line finished: ${ready} ready, ${need} need you, ${tally.rejected} rejected.`)
  }

  return out
}

export async function advance(io: Io, spawn: Spawn): Promise<Advanced> {
  if (isAdvancing) {
    // The one at work may be in a gate that outlives the lock: keep the lock alive.
    const root = await io.root()
    if ((await lockInfo(io, root, await io.now())).state === 'mine') await takeLock(io, root, await io.now())

    return IDLE
  }
  isAdvancing = true
  try {
    const total: Advanced = { ...IDLE }
    for (let n = 0; n < MAX_PASSES; n++) {
      const one = await pass(io, spawn)
      total.ran = total.ran || one.ran
      total.started += one.started
      total.moved += one.moved
      total.note = one.note ?? total.note
      total.isDone = one.isDone
      if (!one.ran || !one.changed || one.isDone) break
    }

    return total
  } finally {
    isAdvancing = false
  }
}

// A ready job whose pull request was merged is done: its item is told, its
// worktree goes, its folder is retired. Each job is asked at most every five
// minutes. Run under the lock; another session's lock is left alone.
async function settleMerged(io: Io): Promise<void> {
  const ctx = await context(io)
  const dir = await stateDirOf(io, ctx.root)
  if (dir === null || ctx.tracker === null) return
  const due = (await readJobs(io, ctx.root)).jobs.filter(job => {
    const last = mergeAsked.get(job.id)

    return job.stage === 'ready' && job.pr !== null && (last === undefined || ctx.now - last >= MERGE_ASK_MS || ctx.now < last)
  })
  if (due.length === 0) return
  const before = await lockInfo(io, ctx.root, ctx.now)
  if (!(await takeLock(io, ctx.root, ctx.now)).isHeld) return
  try {
    for (const job of due) {
      mergeAsked.set(job.id, ctx.now)
      const { pr } = await readPrByNumber(ctx.run, job.pr?.number ?? 0)
      if (pr?.state !== 'merged') continue
      await ctx.tracker.setState(job.itemId, 'done').catch(() => undefined)
      const done = move(job, 'done', 'the pull request was merged', ctx.now)
      await writeJob(io, ctx.root, done)
      await tidy(io, ctx.root, dir, done, ctx.now)
    }
  } finally {
    if (before.state !== 'mine') await releaseLock(io, ctx.root).catch(() => undefined)
  }
}

// For the timer. It starts no agent and runs no station: a station that is
// due is left for the next hook.
export async function watch(io: Io): Promise<void> {
  await advance(io, async () => ({ no: LATER }))
  if (!isAdvancing) await settleMerged(io)
}
