// What the plugin does when the engine tells it of an agent: a spawn, a tool
// call, the end of a turn, the report prompt. Each function answers fast and
// waits for nothing but the `Io`'s own calls (docs/notes/r2b-check.md).
import { OUT_FILE, typeOf } from '../core/agents'
import { ROLES } from '../core/factory-settings'
import type { Role } from '../core/factory-settings'
import { fenceOf, resolvePath } from '../core/fence'
import type { Who } from '../core/fence'
import { isJobId } from '../core/job'
import type { Usage } from '../core/price'
import { clean } from '../core/rows'
import { dropFact } from './inbox'
import type { Io } from './io'
import { readJob, readJobs, setStop, stateDirOf } from './jobs'
import { loadSettings } from './readers/settings'

// Starts one agent of the line. Built by a hook from its own `$`, because an
// agent is fenced only when a hook that is still running starts it.
export type Spawn = (a: { role: Role; description: string; prompt: string }) => Promise<{ agentId: string } | { no: string }>
export type AgentRef = { jobId: string; role: Role; focus: string }

const OURS = ROLES.map(typeOf)
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
let lastRead = Number.NEGATIVE_INFINITY
let forbidden: { at: number; commands: string[][] } | null = null

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

export function rememberAgent(agentId: string, ref: AgentRef): void {
  agents.set(agentId, ref)
  known.add(agentId)
}

// Which job and role an agent belongs to, or null when it is not the line's.
export async function agentOf(io: Io, root: string, agentId: string | undefined): Promise<AgentRef | null> {
  if (agentId === undefined || agentId === '') return null
  const hit = agents.get(agentId)
  if (hit !== undefined) return hit
  // A miss reads the job files again, at most once a second.
  const now = await io.now()
  if (now - lastRead < REREAD_MS && now >= lastRead) return null
  lastRead = now
  for (const job of (await readJobs(io, root)).jobs) {
    for (const work of job.work) rememberAgent(work.agentId, { jobId: job.id, role: work.role, focus: work.focus })
  }

  return agents.get(agentId) ?? null
}

// A spawn of one of the line's agent types: the folder it runs in, or a
// refusal. Null for any other agent type.
export async function onSpawn(
  io: Io,
  e: { subagentType: string; description: string },
): Promise<(AgentRef & { cwd: string }) | { deny: string } | null> {
  if (!OURS.includes(e.subagentType)) return null
  const ref = parseDescription(e.description)
  if (ref === null || typeOf(ref.role) !== e.subagentType) return { deny: NOT_THE_LINE }
  const root = await io.root()
  const dir = await stateDirOf(io, root)
  if (dir === null || (await readJob(io, root, ref.jobId)) === null) return { deny: NOT_THE_LINE }
  const tree = await io.stat(`${dir}/worktrees/${ref.jobId}`)
  if (tree === null || tree.kind !== 'dir') return { deny: NOT_THE_LINE }
  seenSpawns.add(e.description)

  return { ...ref, cwd: tree.realPath }
}

// Starts an agent through `raw` (a hook's own `$.agent.spawn`) and checks that
// the plugin's `agent.spawn` hook saw it. One that it did not see runs with no
// fence: the line is stopped and the person is told.
export async function checkedSpawn(
  io: Io,
  raw: (input: { subagentType: string; description: string; prompt: string }) => Promise<{ agentId?: string; deny?: string }>,
  a: { role: Role; description: string; prompt: string },
): Promise<{ agentId: string } | { no: string }> {
  seenSpawns.delete(a.description)
  const got = await raw({ subagentType: typeOf(a.role), description: a.description, prompt: a.prompt }).catch(
    (error: unknown) => ({ deny: String(error instanceof Error ? error.message : error) }) as { agentId?: string; deny?: string },
  )
  if (got.deny !== undefined) return { no: clean(got.deny).slice(0, 200) }
  if (!seenSpawns.delete(a.description)) {
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

async function forbiddenOf(io: Io): Promise<string[][]> {
  const now = await io.now()
  if (forbidden === null || now - forbidden.at >= SETTINGS_MS || now < forbidden.at) {
    forbidden = { at: now, commands: (await loadSettings(io)).settings.factory.forbiddenCommands }
  }

  return forbidden.commands
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
  if (agent === null || e.agentId === undefined) return null
  const dir = await stateDirOf(io, root)
  const [tree, folder] = dir === null ? [null, null] : await Promise.all([io.stat(`${dir}/worktrees/${agent.jobId}`), io.stat(`${dir}/jobs/${agent.jobId}`)])
  if (tree === null || folder === null) return { decision: 'deny', reason: 'The job of this agent has no folder.' }
  const who: Who = {
    role: agent.role,
    worktree: tree.realPath,
    jobDir: folder.realPath,
    outFile: `${folder.realPath}/out/${OUT_FILE[agent.role](agent.focus)}`,
    forbiddenCommands: await forbiddenOf(io),
  }
  const verdict = fenceOf({ tool: e.tool, input: await realInput(io, e.tool, e.input, who) }, who)
  if (verdict === null) return null
  if (verdict.decision === 'allow') return { decision: 'allow' }
  await dropFact(io, root, { kind: 'refusal', agentId: e.agentId, command: verdict.command, at: await io.now() }).catch(() => undefined)

  return { decision: 'deny', reason: verdict.reason }
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
