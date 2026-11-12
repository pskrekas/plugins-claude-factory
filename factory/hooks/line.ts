// The line: the code that moves the jobs.
//
// `advance` is called only in a hook that is still running (`/factory run`,
// `/factory answer`, the end of a turn), because an agent is fenced only when
// such a hook starts it (docs/notes/r2b-check.md). One call advances at a
// time; a call that finds another at work asks it to go round once more and
// returns, and the one at work reads the fact that the caller left in the inbox.
//
// `watch` is for the timer. It starts no agent, runs no gate, reads no turn
// and makes no move of the state machine: it keeps the lock alive, makes a
// job whose agent is gone ask the person, says when the line waits for a
// hook, ends a run that is done, and sees a merged pull request.
import { commentPr, createDraftPr, readPrByNumber, readyPr } from '../adapters/github-pr'
import { briefOf } from '../core/agents'
import { answerOf } from '../core/answer'
import { parseDfFreeGb } from '../core/checks'
import { branchOf } from '../core/git-args'
import { addSpend, clearWork, failStation, isActive, isFinished, move, newJob, noteRefusal, noteResult, startWork, stop } from '../core/job'
import type { Job, PlanRow, Stage } from '../core/job'
import { canStart, dayLimitOf, freeSlots, isSameDay } from '../core/limits'
import { priceOf } from '../core/price'
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
import { isStopped, lockInfo, readJob, readJobs, releaseLock, retireJob, stateDirOf, takeLock, writeJob } from './jobs'
import { readInside } from './readers/files'
import { endRun, readRun, writeRun } from './run'
import { collect, discardOut, spendOf, writeDiff, writeItem } from './station'
import { addPlanTree, addWorktree, baseHeadOf, commitAll, dropBranch, fetchBase, headOf, pushCommit, removeCleanCopy, removeWorktree, syncBase } from './worktrees'

export type Advanced = { ran: boolean; started: number; moved: number; isDone: boolean; note: string | null }

const IDLE: Advanced = { ran: false, started: 0, moved: 0, isDone: false, note: null }
const MAX_PASSES = 30
const MAX_STEPS = 8
const MAX_TRIES = 2
const MERGE_ASK_MS = 300_000
const NO_ANSWER = 'gave no answer the line can read'
const UNSEEN = 'the fence did not see this agent'
const NOT_SENT = 'the comment was not sent'
const HIDDEN_QUESTION = 'The factory has a question about this item. Its text cannot be shown here: see the job on the machine that runs the line.'
// What is posted when a job waits for the person who runs the line. The
// question itself stays on the job: it can hold text that an agent wrote, and
// an agent with a shell can read what must not be on a public item.
const NEEDS_PERSON = 'The factory needs a person for this item. The question is in the Factory pane on the machine that runs the line.'
const MAX_AUTHOR_QUESTION = 300

let isAdvancing = false
// A call that found another at work asked it to go round once more.
let again = false
// The gate's result for a job, until the job's next step read it or the job moved.
const gates = new Map<string, { stage: Stage; round: number; result: GateResult }>()
// A command the fence refused twice, by job, until the job asked.
const repeats = new Map<string, string>()
const mergeAsked = new Map<string, number>()
// How often the step a job is at failed to be done (a write to the host, a push).
const fails = new Map<string, number>()
// Jobs that are left alone for the rest of one call: a step of theirs failed,
// and the next call tries it again.
const held = new Set<string>()
// Agents the line gave up on (too slow, or stopped by the fence), by job. One
// that still runs keeps its station from starting again in the same folder.
const abandoned = new Map<string, string[]>()
// How many items this run refused at intake, for the last line of the run.
let tally = { startedAt: 0, rejected: 0 }
// The run for which the person was told that the line waits, and the last note shown.
let waitsToldFor = 0
let lastNote = ''

const why = (error: unknown) => clean(String(error instanceof Error ? error.message : error)).slice(0, 200)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
// An agent that ended well still counts as there: its fact is on the way.
export const liveOf = (agents: readonly { id: string; status: string }[]) =>
  agents.filter(agent => agent.status !== 'failed' && agent.status !== 'killed').map(agent => agent.id)
const runningOf = (agents: readonly { id: string; status: string }[]) =>
  agents.filter(agent => ['pending', 'running', 'waiting'].includes(agent.status)).map(agent => agent.id)
// Whether what is on disk is still the job a step was worked out for.
const isSame = (a: Job, b: Job) =>
  a.stage === b.stage && a.round === b.round && a.updatedAt === b.updatedAt && a.history.length === b.history.length && a.work.length === b.work.length && a.results.length === b.results.length

async function freeDiskGb(io: Io, dir: string): Promise<number | null> {
  const df = await io.run(['df', '-Pk', dir], { timeoutMs: 5_000 })

  return 'failed' in df || df.exitCode !== 0 ? null : parseDfFreeGb(df.stdout)
}

// What a job that ended no longer needs: its worktree, the gate's copy, its
// local branch. The job itself stays in the state folder for the rest of its
// day: what it spent is in the day's total and under the day's limit.
export async function tidy(io: Io, root: string, dir: string, job: Job): Promise<void> {
  if ((await io.stat(`${dir}/worktrees/${job.id}`)) !== null) await removeWorktree(io, root, job.id).catch(() => undefined)
  if ((await io.stat(`${dir}/gate/${job.id}`)) !== null) await removeCleanCopy(io, root, job.id).catch(() => undefined)
  // The local branch goes too, so the item can run again.
  if (job.branch !== null && (await headOf(io, root, job.id)) !== null) await dropBranch(io, root, job.id).catch(() => undefined)
  for (const map of [gates, repeats, mergeAsked, fails, abandoned]) map.delete(job.id)
}

// The test files and build settings the branch changed, from the full gate's report.
async function testFilesOf(io: Io, dir: string, job: Job): Promise<string[]> {
  const text = (await readInside(io, dir, `jobs/${job.id}/files/round-${job.round}/merge-checks.md`, 300_000)) ?? ''
  const lines = text.split('\n')
  const from = lines.indexOf('## Test and settings files changed')
  if (from < 0) return []
  const names: string[] = []
  for (const line of lines.slice(from + 1)) {
    const name = /^- `(.*)`$/.exec(line)?.[1]
    if (name === undefined || names.length >= 20) break
    names.push(clean(name))
  }

  return names
}

// What a step of a plan job says of its item.
function planRowOf(step: Step & { do: 'ask' | 'move' }, maxRisk: string): PlanRow {
  const risk = step.set?.risk ?? null
  if (step.do === 'move' && step.to === 'spec') return { verdict: 'accept', risk, note: '' }
  if (step.do === 'move' && step.to === 'rejected') return { verdict: 'reject', risk: null, note: step.reason }
  if (step.do === 'ask' && step.asker === 'intake') {
    return step.resumeAt === 'spec' ? { verdict: 'accept', risk, note: `above the limit (${maxRisk})` } : { verdict: 'needs-info', risk: null, note: step.question }
  }

  return { verdict: 'failed', risk: null, note: step.do === 'ask' ? step.question : step.reason }
}

type Ask = Step & { do: 'ask' }

// Tells the item that the job waits: the label first (setting it twice
// changes nothing), then the comment. Text that an agent wrote is posted in
// one case only: Intake's question to the item's author (Intake has no shell
// and reads the clean checkout), cut short, and as a fixed text when the
// settings refuse it. A limit's name is the plugin's own text. Every other
// question stays on the job, for the pane. Answers why it failed, or null.
async function tellItem(ctx: Ctx, job: Job, step: Ask): Promise<string | null> {
  if (ctx.tracker === null) return null
  // Intake's question is for the item's author; every other one is for the person who runs the line.
  const isForAuthor = step.asker === 'intake' && step.resumeAt === undefined
  try {
    await ctx.tracker.setState(job.itemId, 'needs-human')
    try {
      const text = isForAuthor
        ? `The factory has a question about this item: ${step.question.slice(0, MAX_AUTHOR_QUESTION)}`
        : step.asker === 'limit'
          ? `The factory needs a person: ${step.question}`
          : NEEDS_PERSON
      await ctx.tracker.comment(job.itemId, text)
    } catch (error) {
      if (!why(error).includes(NOT_SENT)) throw error
      await ctx.tracker.comment(job.itemId, isForAuthor ? HIDDEN_QUESTION : NEEDS_PERSON)
    }

    return null
  } catch (error) {
    return why(error)
  }
}

// The job as it waits for the person.
function stopped(job: Job, step: Ask, now: number): Job {
  const set = step.set ?? {}
  const before: Job = {
    ...job,
    ...(set.risk !== undefined ? { risk: set.risk } : {}),
    ...(set.surfaces !== undefined ? { surfaces: set.surfaces } : {}),
    ...(set.reviewers !== undefined ? { reviewers: set.reviewers } : {}),
    ...(set.sentBack != null ? { sentBack: set.sentBack } : {}),
  }

  return stop(before, { question: step.question, asker: step.asker, ...(step.resumeAt === undefined ? {} : { resumeAt: step.resumeAt }) }, now)
}

type Pass = Advanced & { changed: boolean }

// One pass over the jobs. With `spawn` null it is the timer's: see `watch`.
async function pass(io: Io, spawn: Spawn | null): Promise<Pass> {
  const idle: Pass = { ...IDLE, changed: false }
  const isTimer = spawn === null
  const ctx: Ctx = await context(io)
  const { root, f } = ctx
  const run = await readRun(io, root)
  const dir = await stateDirOf(io, root)
  if (run === null || dir === null || run.session !== (await io.sessionId())) return idle
  if (!(await takeLock(io, root, ctx.now)).isHeld) return idle
  if (tally.startedAt !== run.startedAt) tally = { startedAt: run.startedAt, rejected: 0 }
  const out: Pass = { ran: true, started: 0, moved: 0, isDone: false, note: null, changed: false }
  // Every job in the folder: the ones that ended today count for the limits.
  let jobs = (await readJobs(io, root)).jobs
  // A dry run moves only plan jobs; a run of the line moves only its own.
  const isPlanRun = run.plan === true
  const isMine = (job: Job) => isActive(job) && (job.plan !== null) === isPlanRun
  const put = (job: Job) => {
    jobs = jobs.some(one => one.id === job.id) ? jobs.map(one => (one.id === job.id ? job : one)) : [...jobs, job]
  }
  // Writes a job. `was` is the job the new one was worked out from: when what
  // is on disk is no longer that job (a person's command changed it while a
  // gate ran), nothing is written and the answer is null.
  const save = async (job: Job, was?: Job): Promise<Job | null> => {
    if (was !== undefined) {
      const disk = await readJob(io, root, was.id)
      if (disk === null || !isSame(disk, was)) {
        jobs = disk === null ? jobs.filter(one => one.id !== was.id) : jobs.map(one => (one.id === was.id ? disk : one))
        gates.delete(was.id)
        out.changed = true

        return null
      }
    }
    await writeJob(io, root, job)
    put(job)
    out.changed = true

    return job
  }
  const tell = (job: Job, text: string) => {
    out.note = `${clean(job.itemId)}: ${text}`
  }

  if (!isTimer) {
    // A job that ended on an earlier day leaves the folder.
    for (const job of jobs.filter(one => isFinished(one) && !isSameDay(one.updatedAt, ctx.now))) {
      await tidy(io, root, dir, job)
      await retireJob(io, root, job.id, ctx.now).catch(() => undefined)
      jobs = jobs.filter(one => one.id !== job.id)
    }
    // What the hooks learned: a refused command, the end of an agent's turn.
    for (const fact of await drainFacts(io, root)) {
      const job = jobs.find(one => one.work.some(work => work.agentId === fact.agentId))
      const work = job?.work.find(one => one.agentId === fact.agentId)
      if (job === undefined || work === undefined) {
        // The turn of an agent the line gave up on: its cost still counts.
        const left = fact.kind === 'turn' ? jobs.find(one => (abandoned.get(one.id) ?? []).includes(fact.agentId)) : undefined
        if (left !== undefined && fact.kind === 'turn') {
          abandoned.set(left.id, (abandoned.get(left.id) ?? []).filter(id => id !== fact.agentId))
          await save(addSpend(left, left.stoppedIn ?? left.stage, fact.ms, priceOf(fact.usage, f.prices), ctx.now), left)
        }
        continue
      }
      if (fact.kind === 'refusal') {
        const noted = noteRefusal(job, fact.command, ctx.now)
        if (noted.isRepeat) repeats.set(job.id, fact.command)
        await save(noted.job, job)
        continue
      }
      const spent = spendOf(job, fact, f, ctx.now)
      const answer = fact.reason === 'answer' ? answerOf(work.role, fact.answer) : null
      const got = answer === null ? null : await collect(io, root, spent, work.role, work.focus)
      const reason = got === null ? NO_ANSWER : got.ok ? null : got.why
      await save(noteResult(spent, { role: work.role, focus: work.focus, answer, why: reason }, ctx.now), job)
    }
  }

  const isLineStopped = await isStopped(io, root)
  const agents = await io.agents()
  const live = liveOf(agents)
  const running = runningOf(agents)
  const hasFacts = (await io.listDir(`${dir}/inbox`)).length > 0
  const order = jobs.filter(isMine).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(job => job.id)
  let isOutsideFence = false

  // The job waits for the person from here on. The item is told; when it
  // cannot be told twice, the job waits all the same and the person is told here.
  const ask = async (job: Job, step: Ask): Promise<void> => {
    const failed = await tellItem(ctx, job, step)
    if (failed !== null) {
      const tries = (fails.get(job.id) ?? 0) + 1
      fails.set(job.id, tries)
      if (tries < MAX_TRIES) {
        tell(job, `the item could not be told (${failed})`)
        held.add(job.id)

        return
      }
    }
    if ((await save(stopped(job, step, await io.now()), job)) === null) return
    if (job.work.length > 0) abandoned.set(job.id, job.work.map(work => work.agentId))
    for (const map of [gates, repeats, fails]) map.delete(job.id)
    out.moved += 1
    const item = clean(job.itemId)
    io.toast(failed === null ? `Factory: ${item} needs you.` : `Factory: ${item} needs you. The item could not be told (${failed}).`)
    io.sound()
  }

  for (const id of order) {
    for (let n = 0; n < MAX_STEPS && !isOutsideFence; n++) {
      const job = jobs.find(one => one.id === id)
      if (job === undefined || !isMine(job) || held.has(id)) break
      const kept = gates.get(id)
      const gate = kept !== undefined && kept.stage === job.stage && kept.round === job.round ? kept.result : null
      const step: Step = nextStep(job, { now: ctx.now, f, jobs, live, isStopped: isLineStopped, gate, isRepeatRefusal: repeats.has(id), refused: repeats.get(id) ?? '' })
      if (step.do === 'wait') break

      if (isTimer) {
        // The timer does one thing to a job: an agent that is gone or too slow
        // makes its job ask. Not while a fact waits: that agent may have answered.
        if (step.do === 'ask' && job.work.length > 0 && !hasFacts) await ask(job, step)
        break
      }

      if (step.do === 'spawn') {
        // An agent the line gave up on still works in the job's folder: no second one beside it.
        if ((abandoned.get(id) ?? []).some(agentId => running.includes(agentId))) {
          tell(job, 'its last agent still runs; the station starts when it has ended')
          break
        }
        let next = job
        for (const agent of step.agents) {
          const got = await spawn({
            role: agent.role,
            shell: job.shell,
            description: descriptionOf(agent.role, agent.focus, job.id),
            prompt: briefOf(agent.role, { jobId: job.id, itemId: job.itemId, round: job.round, focus: agent.focus, files: `${dir}/jobs/${job.id}/files`, out: `${dir}/jobs/${job.id}/out`, worktree: `${dir}/worktrees/${job.id}` }),
          })
          if ('agentId' in got) {
            // Its clock starts now, not when the pass began: a gate may have run since.
            const at = await io.now()
            next = startWork(next, { agentId: got.agentId, role: agent.role, focus: agent.focus, startedAt: at }, at)
            out.started += 1
          } else {
            isOutsideFence = got.no === UNSEEN
            next = noteResult(next, { role: agent.role, focus: agent.focus, answer: null, why: `could not start: ${got.no}` }, ctx.now)
          }
        }
        if (next !== job) await save(next, job)
        // The station runs now: nothing more for this job until an agent ends.
        if (next.work.length > 0) break
        continue
      }

      if (step.do === 'retry') {
        for (const result of job.results) await discardOut(io, root, job, result.role, result.focus)
        if ((await save(clearWork(failStation(job, ctx.now), ctx.now), job)) === null) break
        continue
      }

      // A plan job ends here: what Intake said is its row, and nothing is
      // written to the tracker.
      if (job.plan !== null && (step.do === 'ask' || step.do === 'move')) {
        const ended = await save({ ...move(job, 'rejected', 'plan only', ctx.now), plan: planRowOf(step, f.maxRisk) }, job)
        if (ended !== null) {
          await tidy(io, root, dir, ended)
          out.moved += 1
        }
        break
      }

      if (step.do === 'gate') {
        // A gate can run for longer than the lock lives: it is refreshed first, and the timer keeps it.
        await takeLock(io, root, await io.now())
        let result: GateResult | null = null
        if (step.which === 'full') {
          // What goes on to the full checks is the commit the reviewers read.
          const tip = await headOf(io, root, job.id)
          if (job.sha !== null && tip !== job.sha) {
            await ask(job, {
              do: 'ask',
              question: `The branch has a commit that the reviewers did not read. /factory answer ${job.itemId} runs the gate and the review again.`,
              asker: 'gate',
              resumeAt: 'gate',
            })
            break
          }
          // The base is merged in here; the push waits until the full gate judged the merged commit.
          const sync = await syncBase(io, root, job.id, ctx.base)
          if (!sync.ok || sync.sha === undefined) {
            const text = sync.ok ? 'the merged commit could not be read' : (sync.why ?? 'git failed')
            result = { pass: false, why: text, needsPerson: !text.startsWith('conflict'), sha: null }
          }
        }
        result = result ?? (await runGate(io, root, job, ctx.base, step.which))
        // A person's command may have changed the job while the gate ran.
        const disk = await readJob(io, root, id)
        if (disk === null || !isSame(disk, job)) {
          jobs = disk === null ? jobs.filter(one => one.id !== id) : jobs.map(one => (one.id === id ? disk : one))
          out.changed = true
          break
        }
        gates.set(id, { stage: job.stage, round: job.round, result })
        out.changed = true
        continue
      }

      if (step.do === 'ask') {
        await ask(job, step)
        break
      }

      // A move of the state machine. Its effects come first. One that fails
      // leaves the job where it is for the next call; one that fails twice
      // makes the job wait for the person, with the reason.
      let set = step.set ?? {}
      let judged: string | null = job.sha
      try {
        if (job.stage === 'build' && step.to === 'gate') {
          // The builder has no git: the plugin commits what it left, and the gate judges that commit.
          const committed = await commitAll(io, root, job)
          if (!committed.ok) throw new Error(`the work could not be committed (${committed.why ?? 'git failed'})`)
        }
        if ((job.stage === 'gate' && step.to === 'review') || step.to === 'ready') {
          // What goes on is the commit the gate judged. A branch that moved is gated again.
          const sha = await headOf(io, root, job.id)
          if (gate === null || sha === null || gate.sha !== sha) {
            gates.delete(id)
            out.changed = true
            continue
          }
          // Only now is the commit pushed: the gate has run, and a branch that
          // changed a protected path never gets here.
          const pushed = await pushCommit(io, root, job.id, sha)
          if (!pushed.ok) throw new Error(`the push was refused (${pushed.why ?? 'git failed'})`)
          if (step.to === 'review') {
            if (job.pr === null && ctx.tracker !== null) {
              const body = `Built by the factory line for item ${job.itemId}.${job.itemUrl === null ? '' : `\n\n${job.itemUrl}`}`
              const made = await createDraftPr(ctx.run, { head: branchOf(job.id), base: ctx.base, title: `${job.itemId}: ${job.title}`, body })
              if (made.pr === null) throw new Error('the pull request could not be opened')
              // Kept at once: a second try must not open a second pull request.
              const withPr = await save({ ...job, pr: made.pr }, job)
              if (withPr === null) break
              set = { ...set, pr: made.pr }
              await ctx.tracker.linkPr(job.itemId, made.pr.url).catch(error => tell(job, `the pull request was not linked (${why(error)})`))
            } else if (job.pr !== null) {
              await commentPr(ctx.run, job.pr.number, `Round ${job.round} pushed.`)
            }
            const baseSha = await baseHeadOf(io, root, ctx.base)
            if (baseSha === null || !(await writeDiff(io, root, job, baseSha, sha))) throw new Error('the change could not be written for the reviewers')
            judged = sha
          }
        }
        if (step.to === 'ready') {
          if (job.pr !== null) {
            const made = await readyPr(ctx.run, job.pr.number)
            if ('failed' in made || made.exitCode !== 0) throw new Error('the pull request could not be marked ready')
          }
          const files = await testFilesOf(io, dir, job)
          // No report text of an agent is posted: the reports are in the job's files, for the pane.
          const text = [
            `The factory finished this. The pull request is ready for you to merge: ${job.pr?.url ?? '(no pull request)'}`,
            '',
            `Test and settings files the branch changed: ${files.length === 0 ? 'none' : files.join(', ')}`,
          ].join('\n')
          await ctx.tracker?.setState(job.itemId, 'needs-human')
          await ctx.tracker?.comment(job.itemId, text).catch(async error => {
            if (!why(error).includes(NOT_SENT)) throw error
            await ctx.tracker?.comment(job.itemId, `The factory finished this. The pull request is ready for you to merge: ${job.pr?.url ?? '(no pull request)'}`)
          })
        }
        if (step.to === 'rejected') {
          await ctx.tracker?.setState(job.itemId, 'rejected')
          await ctx.tracker?.comment(job.itemId, `The factory did not take this: ${step.reason}`).catch(async error => {
            if (!why(error).includes(NOT_SENT)) throw error
            await ctx.tracker?.comment(job.itemId, 'The factory did not take this.')
          })
        }
      } catch (error) {
        const tries = (fails.get(id) ?? 0) + 1
        fails.set(id, tries)
        if (tries < MAX_TRIES) {
          tell(job, why(error))
          held.add(id)
        } else {
          const current = jobs.find(one => one.id === id) ?? job
          await ask(current, { do: 'ask', question: `The line could not go on: ${why(error)}`, asker: 'station', resumeAt: job.stage })
        }
        break
      }
      const current = jobs.find(one => one.id === id) ?? job
      const next = move(current, step.to, step.reason, await io.now(), set)
      // A job that goes back to Build has no reviewed commit any more.
      const moved = await save({ ...next, sha: step.to === 'build' ? null : judged }, current)
      if (moved === null) break
      for (const map of [gates, fails]) map.delete(id)
      out.moved += 1
      if (step.to === 'ready') {
        io.toast(`Factory: ${clean(job.itemId)} is ready. You merge.`)
        io.sound()
      }
      if (isFinished(moved)) {
        tally.rejected += 1
        await tidy(io, root, dir, moved)
      }
    }
    if (isOutsideFence) break
  }

  // New jobs from the queue, while a slot is free.
  let queue = [...run.queue]
  let blocked: string | null = dayLimitOf(jobs, f, ctx.now)
  while (!isTimer && queue.length > 0 && !isLineStopped && !isOutsideFence && blocked === null && ctx.tracker !== null) {
    // A dry run has its own slots: jobs of the line that wait do not hold it up.
    if (freeSlots(jobs.filter(job => (job.plan !== null) === isPlanRun), f) === 0) break
    if (!canStart(await freeDiskGb(io, dir), f)) {
      blocked = 'the disk is nearly full'
      break
    }
    const [itemId = '', ...rest] = queue
    queue = rest
    await writeRun(io, root, { ...run, queue })
    out.changed = true
    if (jobs.some(job => job.itemId === itemId && isActive(job))) continue
    const item = await ctx.tracker.read(itemId).catch(() => null)
    if (item === null) {
      out.note = `${clean(itemId)}: the item could not be read`
      continue
    }
    // Where the job's builder runs its commands is set here, once, from the settings.
    const fresh = newJob({ id: item.id, title: item.title }, ctx.now, f.container !== null && f.container !== false ? 'container' : 'host')
    // An item that ended runs again: its old job is retired first.
    const old = jobs.find(one => one.id === fresh.id)
    if (old !== undefined) {
      if (!isFinished(old)) continue
      await tidy(io, root, dir, old)
      await retireJob(io, root, old.id, ctx.now)
      jobs = jobs.filter(one => one.id !== old.id)
    }
    // Only the item's author and the person who runs the line are read as comments.
    const person = await ctx.me()
    if (isPlanRun) {
      // A dry run: a clean copy of the base on no branch, Intake, and no word to the tracker.
      const baseSha = (await fetchBase(io, root, ctx.base)).ok ? await baseHeadOf(io, root, ctx.base) : null
      const copy = baseSha === null ? { ok: false, why: 'the base branch could not be read' } : await addPlanTree(io, root, fresh.id, baseSha)
      if (!copy.ok) {
        out.note = `${clean(itemId)}: no copy of the base (${copy.why})`
        continue
      }
      const planned: Job = { ...fresh, itemUrl: item.url === '' ? null : item.url, plan: { verdict: 'running', risk: null, note: '' } }
      await writeItem(io, root, planned, item, person)
      await save(planned)
      continue
    }
    const job: Job = { ...fresh, branch: branchOf(fresh.id), itemUrl: item.url === '' ? null : item.url }
    const tree = await addWorktree(io, root, job.id, ctx.base)
    if (!tree.ok) {
      out.note = `${clean(itemId)}: no worktree (${tree.why})`
      continue
    }
    await writeItem(io, root, job, item, person)
    await save(job)
    // The claim: another machine's queue no longer holds the item.
    try {
      await ctx.tracker.setState(itemId, 'in-progress')
      await ctx.tracker.comment(itemId, 'The factory started on this.')
    } catch (error) {
      tell(job, `the item could not be told (${why(error)})`)
    }
  }

  // Nothing left to do: the run ends. A stopped line is done when no agent
  // works. A line that a limit holds, with nothing at work, ends and says so.
  const active = jobs.filter(isMine)
  const isHeldUp = blocked !== null && queue.length > 0 && active.length === 0
  out.isDone = !isOutsideFence && (isLineStopped ? active.every(job => job.work.length === 0) : isHeldUp || (queue.length === 0 && active.length === 0))
  if (out.isDone) {
    await endRun(io, root)
    await releaseLock(io, root).catch(() => undefined)
    gates.clear()
    if (isHeldUp) io.toast(`The line stopped: ${blocked}. ${plural(queue.length, 'item')} ${queue.length === 1 ? 'is' : 'are'} left in the queue.`)
    if (isPlanRun) {
      const rows = jobs.map(job => job.plan).filter((row): row is PlanRow => row !== null)
      const count = (is: (row: PlanRow) => boolean) => rows.filter(is).length
      const asks = count(row => row.verdict === 'needs-info')
      io.toast(`The plan is done: ${count(row => row.verdict === 'accept' && row.note === '')} would run, ${asks} ask${asks === 1 ? 's' : ''}, ${count(row => row.verdict === 'reject')} refused.`)
    } else {
      const own = jobs.filter(job => job.plan === null)
      const ready = own.filter(job => job.stage === 'ready').length
      const need = own.filter(job => job.stage === 'needs-info' || job.stage === 'needs-human').length
      io.toast(`The factory line finished: ${ready} ready, ${need} need you, ${tally.rejected} rejected.`)
    }
  } else if (isTimer && !isLineStopped && waitsToldFor !== run.startedAt) {
    // The line has something to do that only a hook can do, and no agent of
    // its own will end to bring one: the person is told, once.
    const isDue = hasFacts || active.some(job => job.work.length === 0 && !held.has(job.id))
    const hasWorker = active.some(job => job.work.some(work => running.includes(work.agentId)))
    if (isDue && !hasWorker) {
      waitsToldFor = run.startedAt
      io.toast('Factory: the line waits. Run /factory run to go on.')
    }
  }
  if (!isTimer && out.changed) waitsToldFor = 0
  // A step that could not be done is said once, not at every call.
  if (out.note !== null && out.note !== lastNote && !out.isDone) {
    lastNote = out.note
    io.toast(`Factory: ${out.note}`)
  }

  return out
}

export async function advance(io: Io, spawn: Spawn): Promise<Advanced> {
  if (isAdvancing) {
    // The one at work goes round once more: the caller's fact is in the inbox.
    again = true
    // It may be in a gate that outlives the lock: keep the lock alive.
    const root = await io.root()
    if ((await lockInfo(io, root, await io.now())).state === 'mine') await takeLock(io, root, await io.now())

    return IDLE
  }
  isAdvancing = true
  held.clear()
  try {
    const total: Advanced = { ...IDLE }
    for (let n = 0; n < MAX_PASSES; n++) {
      again = false
      const one = await pass(io, spawn)
      total.ran = total.ran || one.ran
      total.started += one.started
      total.moved += one.moved
      total.note = one.note ?? total.note
      total.isDone = one.isDone
      if (!one.ran || one.isDone) break
      // Nothing changed and nobody asked for one more round: done. No `await`
      // is between this test and the release of the flag.
      if (!one.changed && !again) break
    }

    return total
  } finally {
    isAdvancing = false
  }
}

// A ready job whose pull request was merged is done: its item is told, its
// worktree goes. Each job is asked at most every five minutes. Run under the
// lock; another session's lock is left alone.
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
  if (before.state === 'theirs' || !(await takeLock(io, ctx.root, ctx.now)).isHeld) return
  try {
    for (const job of due) {
      mergeAsked.set(job.id, ctx.now)
      const { pr } = await readPrByNumber(ctx.run, job.pr?.number ?? 0)
      if (pr?.state !== 'merged') continue
      const disk = await readJob(io, ctx.root, job.id)
      if (disk === null || !isSame(disk, job)) continue
      await ctx.tracker.setState(job.itemId, 'done').catch(() => undefined)
      const done = move(job, 'done', 'the pull request was merged', ctx.now)
      await writeJob(io, ctx.root, done)
      await tidy(io, ctx.root, dir, done)
    }
  } finally {
    // Given back only when no run took it meanwhile.
    if (before.state !== 'mine' && (await readRun(io, ctx.root)) === null) await releaseLock(io, ctx.root).catch(() => undefined)
  }
}

// For the timer. See the head of this file for what it does and does not do.
export async function watch(io: Io): Promise<void> {
  if (isAdvancing) {
    const root = await io.root()
    if ((await lockInfo(io, root, await io.now())).state === 'mine') await takeLock(io, root, await io.now())

    return
  }
  await pass(io, null)
  if (!isAdvancing) await settleMerged(io)
}
