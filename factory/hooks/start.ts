// `/factory run`: what must be true before the line runs, then the run file
// and the first call that advances the jobs.
import { endWork, isActive, isFinished } from '../core/job'
import type { Spawn } from './agent-events'
import { context } from './context'
import { gateCommands } from './gate'
import type { Io } from './io'
import { lockInfo, readJobs, retireJob, setStop, stateDirOf, takeLock, writeJob } from './jobs'
import { advance, liveOf, tidy } from './line'
import { MAX_QUEUE, readRun, writeRun } from './run'
import { clean } from '../core/rows'

const ITEM_ID = /^[A-Za-z0-9#][A-Za-z0-9_.#-]{0,39}$/
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// What to do about a gate that cannot run.
function gateHint(why: string): string {
  if (why === 'gate commands are not approved') return 'Approve them with /factory approve.'
  if (why === 'no gate') return 'Put the fast checks in gate.fast of the settings file on the base branch.'

  return 'Check the settings file on the base branch.'
}

const MAX_PLAN = 10

// The jobs of the last dry run go: a run of the line, or a new plan, starts clean.
async function clearPlan(io: Io, root: string, now: number): Promise<void> {
  const dir = await stateDirOf(io, root)
  if (dir === null) return
  for (const job of (await readJobs(io, root)).jobs.filter(one => one.plan !== null)) {
    await tidy(io, root, dir, job)
    await retireJob(io, root, job.id, now).catch(() => undefined)
  }
}

// `/factory plan`, the dry run: Intake on the queue as it is now (ten items at
// most), in a clean copy of the base. It builds nothing, makes no branch and
// no pull request, and writes nothing to the tracker. The pane shows what
// Intake said of each item.
export async function startPlan(io: Io, spawn: Spawn, ready: { hasAgentTypes: boolean }): Promise<string> {
  const ctx = await context(io)
  if (ctx.tracker === null || ctx.mark === null) return '/factory plan needs a GitHub tracker in the settings.'
  if (!ready.hasAgentTypes) return 'The agent types of the line are not registered. Start a new session.'
  // A run that is going is left alone. A run file with no live lock is a run that died.
  const lock = await lockInfo(io, ctx.root, ctx.now)
  if (lock.state === 'theirs' || ((await readRun(io, ctx.root)) !== null && lock.state === 'mine')) {
    return 'The line runs. Wait for it to end, or stop it with /factory stop, before a plan.'
  }
  if (!(await takeLock(io, ctx.root, ctx.now)).isHeld) return 'The line runs. Wait for it to end, or stop it with /factory stop, before a plan.'
  await setStop(io, ctx.root, false)
  await clearPlan(io, ctx.root, ctx.now)
  const queue = (await ctx.tracker.list(ctx.mark)).map(item => item.id).slice(0, MAX_PLAN)
  await writeRun(io, ctx.root, { version: 1, session: await io.sessionId(), startedAt: ctx.now, queue, plan: true })
  await advance(io, spawn)

  return `The plan runs Intake on ${plural(queue.length, 'item')}. It builds nothing and writes nothing to the tracker.`
}

// Starts a run of the line: one pass over the queue as it is now (or over one
// item), and the jobs that are already there. `spawn` is the calling hook's
// own. The lock is kept until the run ends.
export async function startRun(io: Io, spawn: Spawn, only: string | null, ready: { hasAgentTypes: boolean }): Promise<string> {
  if (only !== null && !ITEM_ID.test(only)) return 'Not an item id: /factory run [id]'
  const ctx = await context(io)
  if (ctx.tracker === null || ctx.mark === null) return '/factory run needs a GitHub tracker in the settings.'
  if (!ready.hasAgentTypes) return 'The agent types of the line are not registered. Start a new session.'
  // No gate, no factory (design 8.2): the fast checks must be there and approved.
  const gate = await gateCommands(io, ctx.root, ctx.base, 'fast')
  if (!gate.ok) return `No gate, no factory: ${gate.why}. ${gateHint(gate.why)}`
  const lock = await takeLock(io, ctx.root, ctx.now)
  if (!lock.isHeld) return `Another session runs the line (${clean(lock.holder ?? 'unknown')}). Nothing was changed.`
  await setStop(io, ctx.root, false)

  // The jobs of an earlier session go on. An agent of theirs that is gone is
  // taken off its job, so its station starts again: this is a hook, it may.
  await clearPlan(io, ctx.root, ctx.now)
  const live = liveOf(await io.agents())
  const jobs = (await readJobs(io, ctx.root)).jobs.filter(job => !isFinished(job))
  for (const job of jobs) {
    const lost = job.work.filter(work => !live.includes(work.agentId))
    if (lost.length > 0) await writeJob(io, ctx.root, lost.reduce((next, work) => endWork(next, work.agentId, ctx.now), job))
  }

  // The queue is read once. An item that gets the mark later waits for the next run.
  const queue = only !== null ? [only] : (await ctx.tracker.list(ctx.mark)).map(item => item.id).slice(0, MAX_QUEUE)
  await writeRun(io, ctx.root, { version: 1, session: await io.sessionId(), startedAt: ctx.now, queue })
  const going = jobs.filter(isActive).length
  await advance(io, spawn)

  return `The line runs: ${plural(queue.length, 'item')} in the queue, ${going} job${going === 1 ? ' goes' : 's go'} on. /factory stop stops it.`
}
