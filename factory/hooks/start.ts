// `/factory run`: what must be true before the line runs, then the run file
// and the first call that advances the jobs.
import { endWork, isActive, isFinished } from '../core/job'
import type { Spawn } from './agent-events'
import { context } from './context'
import type { Ctx } from './context'
import { dockerState, sweepContainers } from './container'
import { gateCommands } from './gate'
import type { Io } from './io'
import { lockInfo, readJobs, releaseLock, retireJob, setStop, stateDirOf, takeLock, writeJob } from './jobs'
import { advance, liveOf, tidy } from './line'
import { MAX_QUEUE, endRun, readRun, writeRun } from './run'
import { failureText } from '../core/comment'
import { clean } from '../core/rows'
import { toolNote } from '../core/task'

const ITEM_ID = /^[A-Za-z0-9#][A-Za-z0-9_.#-]{0,39}$/
const BOX_NOT_APPROVED = 'the container settings are not approved'
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
  if (ctx.tracker === null || ctx.mark === null) return ctx.trackerNote ?? '/factory plan needs a tracker in the settings (github, azure-boards or mcp).'
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
  if (ctx.tracker === null || ctx.mark === null) return ctx.trackerNote ?? '/factory run needs a tracker in the settings (github, azure-boards or mcp).'
  // A job ends as a pull request: the remote must be one the plugin can open one on.
  if (ctx.host === null) return '/factory run needs a pull request host: a github.com or a dev.azure.com remote.'
  if (!ready.hasAgentTypes) return 'The agent types of the line are not registered. Start a new session.'
  // No gate, no factory (design 8.2): the fast checks must be there and approved.
  const gate = await gateCommands(io, ctx.root, ctx.base, 'fast')
  if (!gate.ok && gate.why === BOX_NOT_APPROVED) return `No container, no factory: ${gate.why}. Approve them with /factory approve.`
  if (!gate.ok) return `No gate, no factory: ${gate.why}. ${gateHint(gate.why)}`
  // No container, no factory (design 8.3): the builder and the gate run code
  // that an agent wrote. The base branch's settings say where: in a container
  // (then docker and the image must be there), or, by the person's own
  // approved word, on this machine.
  if (gate.container === null) return 'No container, no factory: set factory.container in the settings file on the base branch (an image, or false to run on this machine).'
  if (gate.container !== false) {
    const docker = await dockerState(io, gate.container.image)
    if (!docker.ok) return `No container, no factory: ${docker.why.replace(/\.$/, '')}.`
  }
  // Only a marked item runs, also when it is named: the mark is the person's own word (design 8.1).
  if (only !== null && !(await ctx.tracker.hasMark(only))) return `${clean(only)} does not carry the mark "${ctx.mark}". Only a marked item runs.`
  // A session that already runs the line may have a builder's command or a gate in a container now.
  const wasMine = (await lockInfo(io, ctx.root, ctx.now)).state === 'mine'
  const lock = await takeLock(io, ctx.root, ctx.now)
  if (!lock.isHeld) return `Another session runs the line (${clean(lock.holder ?? 'unknown')}). Nothing was changed.`
  try {
    return await begin(io, spawn, only, ctx, gate.container !== false && !wasMine)
  } catch (error) {
    // Nothing is left half-started: no run file, no lock.
    await endRun(io, ctx.root).catch(() => undefined)
    await releaseLock(io, ctx.root).catch(() => undefined)

    return `The line did not start (${clean(String(error instanceof Error ? error.message : error)).slice(0, 200)}). Nothing runs.`
  }
}

async function begin(io: Io, spawn: Spawn, only: string | null, ctx: Ctx, hasDocker: boolean): Promise<string> {
  if (ctx.tracker === null || ctx.mark === null) return ''
  await setStop(io, ctx.root, false)
  // Containers that a crash, a closed session or a time limit left behind go.
  // Only when this session did not run the line before this call: then no
  // gate and no builder of this repository runs now.
  if (hasDocker) await sweepContainers(io, ctx.root, []).catch(() => 0)

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
  // A tracker that cannot be read (its tool is missing or not logged in) stops the start, with the reason.
  const scan = only !== null ? null : await ctx.tracker.scan()
  if (scan !== null && scan.items === null) {
    // An MCP tracker runs no command: its own note says why.
    if (ctx.tracker.kind === 'mcp') throw new Error(`the tracker could not be read: ${scan.note ?? 'no reason given'}`)
    const tool = ctx.tracker.kind === 'github' ? 'gh' : 'az'
    throw new Error(`the tracker could not be read: ${toolNote(scan.result, tool) ?? (scan.result === null ? 'not a mark' : failureText(tool, scan.result))}`)
  }
  const queue = only !== null ? [only] : (scan?.items ?? []).map(item => item.id).slice(0, MAX_QUEUE)
  await writeRun(io, ctx.root, { version: 1, session: await io.sessionId(), startedAt: ctx.now, queue })
  const going = jobs.filter(isActive).length
  await advance(io, spawn)

  return `The line runs: ${plural(queue.length, 'item')} in the queue, ${going} job${going === 1 ? ' goes' : 's go'} on. /factory stop stops it.`
}
