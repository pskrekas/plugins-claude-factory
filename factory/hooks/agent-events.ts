// What the plugin does when the engine tells it of an agent: a spawn, a tool
// call, the end of a turn, the report prompt. Each function answers fast and
// waits for nothing but the `Io`'s own calls (docs/notes/r2b-check.md).
import { AGENT_TYPES, OUT_FILE, SHELL_TOOL, typeOf } from '../core/agents'
import type { Shell } from '../core/agents'
import type { ContainerSpec, Role } from '../core/factory-settings'
import { fenceOf, forbiddenIn, resolvePath } from '../core/fence'
import type { Who } from '../core/fence'
import { isJobId } from '../core/job'
import type { Usage } from '../core/price'
import { clean } from '../core/rows'
import { removeJobContainer, runOnce } from './container'
import { baseContainer } from './gate'
import { dropFact } from './inbox'
import type { Io } from './io'
import { readJob, readJobs, setStop, stateDirOf } from './jobs'
import { loadSettings } from './readers/settings'

// Starts one agent of the line. Built by a hook from its own `$`, because an
// agent is fenced only when a hook that is still running starts it.
// `shell`: where the job's builder runs its commands; it says which builder type is started.
export type Spawn = (a: { role: Role; shell: Shell; description: string; prompt: string }) => Promise<{ agentId: string } | { no: string }>
export type AgentRef = { jobId: string; role: Role; focus: string }

const NOT_THE_LINE = 'Only the factory line starts this agent.'
const UNSEEN = 'the fence did not see this agent'
const REREAD_MS = 1_000
const SETTINGS_MS = 5_000

// The agents of the line that this session knows. After a reload the map is
// empty and is filled again from the job files (`work`).
const agents = new Map<string, AgentRef>()
// Every agent id of the line seen in this session: a report can arrive after
// its job moved on.
const known = new Set<string>()
// The spawns the `agent.spawn` hook saw, by description, until they are checked.
const seenSpawns = new Set<string>()
// When an id was last looked up and not found, so that an agent that is not
// the line's does not make every one of its tool calls read the job files.
const misses = new Map<string, number>()
const MAX_MISSES = 200
// Spawns of the line that the hook saw and whose agent id is not known yet.
let unsettled = 0
const FENCED_TOOLS = ['Bash', SHELL_TOOL, 'Write', 'Edit', 'Read', 'Glob', 'Grep']
const NOT_YET = 'The fence does not know this agent yet. Try again in a moment.'
let forbidden: { at: number; commands: string[][] } | null = null
let box: { at: number; answer: { ok: true; container: ContainerSpec | false | null } | { ok: false; why: string } } | null = null
// Where each job's builder runs its commands. It is set when a job is made and never changes.
const shells = new Map<string, Shell>()
const NOT_A_BUILDER = 'This tool is for the builder of the factory line.'
// One side at a time (design 8.3). While a command of a job runs in its
// container, a program in it could change a path of the job's folder between
// the fence's look at it and the file tool's use of it. So for a job that
// builds in a container, a file tool of this machine and a command never run
// at the same time; and since each command has a container of its own, no
// program of a builder runs at any other time.
const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep']
const shellRuns = new Set<string>() // the jobs with a command in a container now
const fileCalls = new Map<string, number>() // per job: its file calls that run now
const SHELL_RUNS = 'A command of this job runs in its container. Wait for it to end, then call again.'
const FILE_RUNS = 'A file call of this job runs. Wait for it to end, then call again.'
const TWO_SHELLS = 'Another command of this job runs. Wait for it to end, then call again.'
// The jobs with a command whose container docker did not confirm as gone: a
// program of it may still run, so the job's folder stays closed.
const unconfirmed = new Set<string>()
const STUCK = 'A container of this job may still run: docker did not confirm that it stopped. Start Docker; the next command of the job tries again.'
// Why a file call of a job must wait, or null.
const closedFor = (jobId: string): string | null => (unconfirmed.has(jobId) ? STUCK : shellRuns.has(jobId) ? SHELL_RUNS : null)
const NOT_RUN = 'The command was not run'
const SHELL_MS = { usual: 120_000, most: 600_000, least: 1_000 }

// `factory <role> <job id>`, or `factory reviewer:<focus> <job id>`.
export const descriptionOf = (role: Role, focus: string, jobId: string): string =>
  `factory ${role}${focus === '' ? '' : ':' + focus} ${jobId}`

function parseDescription(text: string): AgentRef | null {
  const found = /^factory (intake|spec|builder|reviewer|approver)(?::([a-z0-9-]{1,20}))? (\S+)$/.exec(text)
  if (found === null || !isJobId(found[3] ?? '')) return null
  const role = found[1] as Role
  const focus = found[2] ?? ''
  // A reviewer has a focus; no other role has one.
  if ((role === 'reviewer') !== (focus !== '')) return null

  return { jobId: found[3] ?? '', role, focus }
}

// A spawn that `onSpawn` let through ended: its agent is known, or it did not start.
export function spawnSettled(): void {
  unsettled = Math.max(0, unsettled - 1)
}

export function rememberAgent(agentId: string, ref: AgentRef): void {
  agents.set(agentId, ref)
  known.add(agentId)
}

// Which job and role an agent belongs to, or null when it is not the line's.
export async function agentOf(io: Io, root: string, agentId: string | undefined): Promise<AgentRef | null> {
  if (agentId === undefined || agentId === '') return null
  const hit = agents.get(agentId)
  if (hit !== undefined) return hit
  // An id that is not known is looked up in the job files at once (after a
  // reload the map is empty). The same id is not looked up again for a second.
  const now = await io.now()
  const missed = misses.get(agentId)
  if (missed !== undefined && now >= missed && now - missed < REREAD_MS) return null
  for (const job of (await readJobs(io, root)).jobs) {
    for (const work of job.work) rememberAgent(work.agentId, { jobId: job.id, role: work.role, focus: work.focus })
  }
  const found = agents.get(agentId) ?? null
  if (found === null) {
    if (misses.size >= MAX_MISSES) misses.clear()
    misses.set(agentId, now)
  }

  return found
}

// A spawn of one of the line's agent types: the folder it runs in, or a
// refusal. Null for any other agent type.
export async function onSpawn(
  io: Io,
  e: { subagentType: string; description: string },
): Promise<(AgentRef & { cwd: string }) | { deny: string } | null> {
  if (!AGENT_TYPES.includes(e.subagentType)) return null
  const ref = parseDescription(e.description)
  if (ref === null) return { deny: NOT_THE_LINE }
  const root = await io.root()
  const dir = await stateDirOf(io, root)
  const job = dir === null ? null : await readJob(io, root, ref.jobId)
  // The type is the one of the job's own shell: a job that builds in a
  // container never gets the builder that has a shell of this machine.
  if (job === null || typeOf(ref.role, job.shell) !== e.subagentType) return { deny: NOT_THE_LINE }
  const tree = await io.stat(`${dir}/worktrees/${ref.jobId}`)
  if (tree === null || tree.kind !== 'dir') return { deny: NOT_THE_LINE }
  seenSpawns.add(e.description)
  unsettled += 1

  return { ...ref, cwd: tree.realPath }
}

// Starts an agent through `raw` (a hook's own `$.agent.spawn`) and checks that
// the plugin's `agent.spawn` hook saw it. One that it did not see runs with no
// fence: the line is stopped and the person is told.
export async function checkedSpawn(
  io: Io,
  raw: (input: { subagentType: string; description: string; prompt: string }) => Promise<{ agentId?: string; deny?: string }>,
  a: { role: Role; shell: Shell; description: string; prompt: string },
): Promise<{ agentId: string } | { no: string }> {
  seenSpawns.delete(a.description)
  const got = await raw({ subagentType: typeOf(a.role, a.shell), description: a.description, prompt: a.prompt }).catch(
    (error: unknown) => ({ deny: String(error instanceof Error ? error.message : error) }) as { agentId?: string; deny?: string },
  )
  if (got.deny !== undefined) return { no: clean(got.deny).slice(0, 200) }
  if (!seenSpawns.delete(a.description)) {
    // Its report must not reach the session's model either.
    if (got.agentId !== undefined) known.add(got.agentId)
    await setStop(io, await io.root(), true).catch(() => undefined)
    io.toast('Factory: an agent started outside the fence. The line is stopped.')
    io.sound()

    return { no: UNSEEN }
  }
  const ref = parseDescription(a.description)
  if (got.agentId === undefined || ref === null) return { no: 'the agent did not start' }
  rememberAgent(got.agentId, ref)

  return { agentId: got.agentId }
}

// The forbidden commands, kept for a few seconds.
async function forbiddenOf(io: Io): Promise<string[][]> {
  const now = await io.now()
  if (forbidden === null || now - forbidden.at >= SETTINGS_MS || now < forbidden.at) {
    forbidden = { at: now, commands: (await loadSettings(io)).settings.factory.forbiddenCommands }
  }

  return forbidden.commands
}

// The container of the builder's commands, kept for a few seconds. It is the
// base branch's, as the person approved it (the gate's own rule): the
// settings file of a working tree names no image.
async function boxOf(io: Io): Promise<{ ok: true; container: ContainerSpec | false | null } | { ok: false; why: string }> {
  const now = await io.now()
  if (box === null || now - box.at >= SETTINGS_MS || now < box.at) {
    const { settings, root } = await loadSettings(io)
    box = { at: now, answer: await baseContainer(io, root, settings.baseBranch) }
  }

  return box.answer
}

// Where the builder of a job runs its commands, or null when the job is gone.
async function shellOf(io: Io, root: string, jobId: string): Promise<Shell | null> {
  const hit = shells.get(jobId)
  if (hit !== undefined) return hit
  const job = await readJob(io, root, jobId)
  if (job === null) return null
  shells.set(jobId, job.shell)

  return job.shell
}

// Where a path really is: the real path of the nearest part of it that
// exists, and the rest after it. A link that leads out of the job is seen.
async function realOf(io: Io, path: string): Promise<string> {
  let at = path
  let rest = ''
  for (;;) {
    const info = await io.stat(at)
    if (info !== null) return info.realPath + rest
    const cut = at.lastIndexOf('/')
    if (cut <= 0) return path
    rest = at.slice(cut) + rest
    at = at.slice(0, cut)
  }
}

// The call with its paths made real, for the fence to judge.
async function realInput(io: Io, tool: string, input: unknown, who: Who): Promise<unknown> {
  if (typeof input !== 'object' || input === null) return input
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  const key = tool === 'Read' || tool === 'Write' || tool === 'Edit' ? 'file_path' : tool === 'Glob' || tool === 'Grep' ? 'path' : null
  const given = key === null ? undefined : out[key]
  if (key !== null && typeof given === 'string' && given !== '') {
    const full = resolvePath(given, who.worktree)
    if (full !== null) out[key] = await realOf(io, full)
  }

  return out
}

// The fence's answer for one tool call, or null when the call is not the
// fence's to answer. A refusal is also dropped as a fact.
export async function onToolCheck(
  io: Io,
  e: { agentId?: string; tool: string; input: unknown },
): Promise<{ decision: 'allow' } | { decision: 'deny'; reason: string } | null> {
  const root = await io.root()
  const agent = await agentOf(io, root, e.agentId)
  if (e.agentId === undefined) return null
  if (agent === null) {
    // Between the start of one of the line's agents and the moment its id is
    // known, an agent that is not known could be that one: it is refused, not
    // passed on. (The hand-back is never the fence's to answer.)
    return unsettled > 0 && FENCED_TOOLS.includes(e.tool) ? { decision: 'deny', reason: NOT_YET } : null
  }
  // Told early; `onFileCall` is the one that holds the rule.
  const closed = FILE_TOOLS.includes(e.tool) ? closedFor(agent.jobId) : null
  if (closed !== null) return { decision: 'deny', reason: closed }

  return verdictOf(io, root, agent, e.agentId, e.tool, e.input)
}

// The fence's answer for one call of an agent of the line; a refusal is also
// dropped as a fact. Null when the call is not the fence's to answer.
async function verdictOf(
  io: Io,
  root: string,
  agent: AgentRef,
  agentId: string,
  tool: string,
  input: unknown,
): Promise<{ decision: 'allow' } | { decision: 'deny'; reason: string } | null> {
  const dir = await stateDirOf(io, root)
  const [tree, folder] = dir === null ? [null, null] : await Promise.all([io.stat(`${dir}/worktrees/${agent.jobId}`), io.stat(`${dir}/jobs/${agent.jobId}`)])
  const shell = await shellOf(io, root, agent.jobId)
  if (tree === null || folder === null || shell === null) return { decision: 'deny', reason: 'The job of this agent has no folder.' }
  const who: Who = {
    role: agent.role,
    shell,
    worktree: tree.realPath,
    jobDir: folder.realPath,
    outFile: `${folder.realPath}/out/${OUT_FILE[agent.role](agent.focus)}`,
    forbiddenCommands: await forbiddenOf(io),
  }
  const verdict = fenceOf({ tool, input: await realInput(io, tool, input, who) }, who)
  if (verdict === null) return null
  if (verdict.decision === 'allow') return { decision: 'allow' }
  await dropFact(io, root, { kind: 'refusal', agentId, command: verdict.command, at: await io.now() }).catch(() => undefined)

  return { decision: 'deny', reason: verdict.reason }
}

// The plugin's shell tool (design 8.3): one command of a builder, run inside
// its job's container. It answers only the builder of a job that builds in a
// container, while the job is in Build. The command is never read by a shell
// of the person's machine: it is one argument of `sh -c` inside the container.
export async function onShell(
  io: Io,
  e: { agentId?: string; command?: unknown; timeout_ms?: unknown },
): Promise<{ result: string } | { deny: string }> {
  const root = await io.root()
  const agent = await agentOf(io, root, e.agentId)
  const job = agent === null || agent.role !== 'builder' ? null : await readJob(io, root, agent.jobId)
  if (e.agentId === undefined || job === null || job.shell !== 'container' || job.stage !== 'build') return { deny: NOT_A_BUILDER }
  const command = typeof e.command === 'string' ? e.command : ''
  if (command.trim() === '') return { deny: `${NOT_RUN}: give one command as text.` }
  const refused = forbiddenIn(command, await forbiddenOf(io))
  if (refused !== null) {
    await dropFact(io, root, { kind: 'refusal', agentId: e.agentId, command: clean(refused).trim().slice(0, 200), at: await io.now() }).catch(() => undefined)

    return { deny: 'This command is forbidden in this repository.' }
  }
  const where = await boxOf(io)
  if (!where.ok) return { deny: `${NOT_RUN}: ${where.why}.` }
  if (where.container === null || where.container === false) return { deny: `${NOT_RUN}: the settings name no container.` }
  const asked = typeof e.timeout_ms === 'number' && Number.isFinite(e.timeout_ms) && e.timeout_ms > 0 ? e.timeout_ms : SHELL_MS.usual
  // One side at a time. Nothing is awaited between this look and the mark.
  if (shellRuns.has(job.id)) return { deny: TWO_SHELLS }
  if ((fileCalls.get(job.id) ?? 0) > 0) return { deny: FILE_RUNS }
  shellRuns.add(job.id)
  try {
    // A container of an earlier command that docker did not confirm as gone
    // is removed first. While that fails, nothing of the job runs.
    if (unconfirmed.has(job.id)) {
      if (!(await removeJobContainer(io, root, job.id))) return { deny: STUCK }
      unconfirmed.delete(job.id)
    }
    const ran = await runOnce(io, root, job.id, where.container, command, Math.round(Math.min(SHELL_MS.most, Math.max(SHELL_MS.least, asked))))
    if (!ran.isGone) unconfirmed.add(job.id)

    return ran.ok ? { result: ran.text } : { deny: `${NOT_RUN}: ${ran.why.replace(/\.$/, '')}.` }
  } finally {
    shellRuns.delete(job.id)
  }
}

// A file tool call of an agent of the line, as the engine is about to run it
// (`next`); `e` holds the tool's arguments beside its name. For a job that
// builds in a container it does not run while a command of the job runs, and
// no command starts while it runs. And the fence judges it again here, at the
// moment it runs: a command that ended since the engine asked the fence may
// have turned a part of its path into a link. From the count below until the
// call ends nothing of the job runs, so what the fence sees now is what the
// tool will use. Any other call goes on unchanged.
export async function onFileCall<T>(io: Io, e: { agentId?: string; tool: string; [key: string]: unknown }, next: () => Promise<T>): Promise<T | { deny: string }> {
  if (e.agentId === undefined || !FILE_TOOLS.includes(e.tool)) return next()
  const root = await io.root()
  const agent = await agentOf(io, root, e.agentId)
  if (agent === null || (await shellOf(io, root, agent.jobId)) !== 'container') return next()
  const { jobId } = agent
  // Nothing is awaited between this look and the count.
  const closed = closedFor(jobId)
  if (closed !== null) return { deny: closed }
  fileCalls.set(jobId, (fileCalls.get(jobId) ?? 0) + 1)
  try {
    const verdict = await verdictOf(io, root, agent, e.agentId, e.tool, e)
    if (verdict !== null && verdict.decision === 'deny') return { deny: verdict.reason }

    return await next()
  } finally {
    const left = (fileCalls.get(jobId) ?? 1) - 1
    if (left > 0) fileCalls.set(jobId, left)
    else fileCalls.delete(jobId)
  }
}

// The end of an agent's turn: a fact for the code that advances the jobs.
// True when the agent was the line's.
export async function onTurn(
  io: Io,
  e: { agentId?: string; answer: string; durationMs: number; usage?: Usage; reason: string },
): Promise<boolean> {
  const root = await io.root()
  if (e.agentId === undefined || (await agentOf(io, root, e.agentId)) === null) return false
  await dropFact(io, root, {
    kind: 'turn',
    agentId: e.agentId,
    answer: e.answer,
    ms: Math.max(0, e.durationMs),
    usage: e.usage ?? null,
    reason: e.reason,
    at: await io.now(),
  })

  return true
}

// True for the prompt that carries the report of one of the line's agents.
// The session's model is not told: it would be woken at every station, and it
// would read text that an agent wrote.
export async function isOwnReport(io: Io, e: { origin?: { kind: string }; text: string }): Promise<boolean> {
  if (e.origin?.kind !== 'peer') return false
  const from = /^<agent-message from="([^"]{1,100})">/.exec(e.text)?.[1]
  if (from === undefined) return false

  return known.has(from) || (await agentOf(io, await io.root(), from)) !== null
}
