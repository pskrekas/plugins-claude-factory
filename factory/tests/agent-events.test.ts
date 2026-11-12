import { expect, test } from 'claude-code/testing'

import { move, newJob, startWork } from '../core/job'
import type { Job } from '../core/job'
import { stateFolderOf } from '../core/state-path'
import { agentOf, checkedSpawn, isOwnReport, onSpawn, onToolCheck, onTurn, rememberAgent } from '../hooks/agent-events'
import { drainFacts } from '../hooks/inbox'
import { fakeIo } from './kit'

const DIR = '/state/' + stateFolderOf('/r/.git')
const build = (item: string): Job => ['spec', 'build'].reduce((j, to) => move(j, to as 'spec', 'ok', 1), newJob({ id: item, title: 'A thing' }, 1))
// A world with jobs on disk, each with its worktree.
function world(jobs: Job[], extra: Record<string, string> = {}, more: { reals?: Record<string, string> } = {}) {
  const files: Record<string, string> = { '/r/.git/HEAD': 'x', '/r/.claude/factory.json': '{"factory": {"forbiddenCommands": [["npm", "publish"]]}}', ...extra }
  for (const job of jobs) {
    files[`${DIR}/jobs/${job.id}/job.json`] = JSON.stringify(job)
    files[`${DIR}/worktrees/${job.id}/README.md`] = 'x'
  }

  return fakeIo({ files, ...more })
}
const wt = (job: Job) => `${DIR}/worktrees/${job.id}`

test('a spawn of the line gets its job\'s worktree as its folder; any other spawn of the line\'s types is refused', async () => {
  const job = build('21')
  const io = world([job])
  expect(await onSpawn(io, { subagentType: 'factory:builder', description: `factory builder ${job.id}` })).toEqual({ cwd: wt(job), jobId: job.id, role: 'builder', focus: '' })
  expect(await onSpawn(io, { subagentType: 'factory:reviewer', description: `factory reviewer:code ${job.id}` })).toEqual({ cwd: wt(job), jobId: job.id, role: 'reviewer', focus: 'code' })
  const refused = { deny: 'Only the factory line starts this agent.' }
  for (const description of ['help me', `factory spec ${job.id}`, 'factory builder 99-unknown', `factory builder ${job.id} extra`, `factory builder:../x ${job.id}`, 'factory builder ../x']) {
    expect([description, await onSpawn(io, { subagentType: 'factory:builder', description })]).toEqual([description, refused])
  }
  // An agent of another kind is not the line's business.
  expect(await onSpawn(io, { subagentType: 'general-purpose', description: `factory builder ${job.id}` })).toBe(null)
})

test('the fence answers for an agent of a job, and a refusal is a fact', async () => {
  const job = build('22')
  const io = world([job])
  rememberAgent('ag22', { jobId: job.id, role: 'builder', focus: '' })

  expect(await onToolCheck(io, { agentId: 'ag22', tool: 'Bash', input: { command: 'npm test' } })).toEqual({ decision: 'allow' })
  expect(await onToolCheck(io, { agentId: 'ag22', tool: 'Bash', input: { command: 'git push origin main' } })).toEqual({ decision: 'deny', reason: 'The line pushes; an agent does not.' })
  expect(await onToolCheck(io, { agentId: 'ag22', tool: 'Bash', input: { command: 'npm publish' } })).toEqual({ decision: 'deny', reason: 'This command is forbidden in this repository.' })
  expect(await onToolCheck(io, { agentId: 'ag22', tool: 'Write', input: { file_path: `${DIR}/jobs/${job.id}/out/build.md`, content: 'x' } })).toEqual({ decision: 'allow' })
  expect(await onToolCheck(io, { agentId: 'ag22', tool: 'Write', input: { file_path: `${DIR}/jobs/${job.id}/job.json`, content: 'x' } })).toEqual({ decision: 'deny', reason: 'This is not a place this agent writes.' })
  expect((await drainFacts(io, '/r')).map(fact => (fact.kind === 'refusal' ? [fact.agentId, fact.command] : null))).toEqual([
    ['ag22', 'git push origin main'],
    ['ag22', 'npm publish'],
    ['ag22', `${DIR}/jobs/${job.id}/job.json`],
  ])
  // Not the fence's to answer: no agent, an agent that is not the line's, a tool that is not the role's.
  expect(await onToolCheck(io, { tool: 'Bash', input: { command: 'git push' } })).toBe(null)
  expect(await onToolCheck(io, { agentId: 'stranger', tool: 'Bash', input: { command: 'git push' } })).toBe(null)
  expect(await onToolCheck(io, { agentId: 'ag22', tool: 'SubagentHandback', input: { message: 'DONE' } })).toBe(null)
})

test('a path is judged by where it really is: a link that leads out of the job is refused', async () => {
  const job = build('23')
  const io = world([job], { '/r/.env': 'SECRET=1' }, { reals: { [`${DIR}/worktrees/23-a-thing/link`]: '/r', [`${DIR}/worktrees/23-a-thing/link/.env`]: '/r/.env' } })
  io.files[`${wt(job)}/link/.env`] = 'SECRET=1'
  rememberAgent('ag23', { jobId: job.id, role: 'builder', focus: '' })

  expect(await onToolCheck(io, { agentId: 'ag23', tool: 'Read', input: { file_path: `${wt(job)}/README.md` } })).toEqual({ decision: 'allow' })
  expect(await onToolCheck(io, { agentId: 'ag23', tool: 'Read', input: { file_path: 'README.md' } })).toEqual({ decision: 'allow' })
  expect((await onToolCheck(io, { agentId: 'ag23', tool: 'Read', input: { file_path: `${wt(job)}/link/.env` } }))?.decision).toBe('deny')
  // A new file under a linked folder goes where the folder really is.
  expect((await onToolCheck(io, { agentId: 'ag23', tool: 'Write', input: { file_path: `${wt(job)}/link/new/x.ts`, content: 'x' } }))?.decision).toBe('deny')
  expect((await onToolCheck(io, { agentId: 'ag23', tool: 'Grep', input: { pattern: 'SECRET', path: `${wt(job)}/link` } }))?.decision).toBe('deny')
  expect(await onToolCheck(io, { agentId: 'ag23', tool: 'Write', input: { file_path: `${wt(job)}/src/new/x.ts`, content: 'x' } })).toEqual({ decision: 'allow' })
})

test('after a reload the agents of the jobs are found again from the job files', async () => {
  const job = startWork(build('24'), { agentId: 'ag24', role: 'reviewer', focus: 'code', startedAt: 5 }, 6)
  const io = world([job])
  io.time = 50_000
  expect(await agentOf(io, '/r', 'ag24')).toEqual({ jobId: job.id, role: 'reviewer', focus: 'code' })
  expect(await onToolCheck(io, { agentId: 'ag24', tool: 'Write', input: { file_path: `${DIR}/jobs/${job.id}/out/review-code.md`, content: 'x' } })).toEqual({ decision: 'allow' })
  expect((await onToolCheck(io, { agentId: 'ag24', tool: 'Write', input: { file_path: `${wt(job)}/x.ts`, content: 'x' } }))?.decision).toBe('deny')
})

test('the end of an agent\'s turn is a fact; its report is the line\'s own', async () => {
  const job = build('25')
  const io = world([job])
  rememberAgent('ag25', { jobId: job.id, role: 'builder', focus: '' })
  const usage = { model: 'm', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }

  expect(await onTurn(io, { agentId: 'ag25', answer: 'DONE', durationMs: 1200, usage, reason: 'answer' })).toBe(true)
  expect(await onTurn(io, { agentId: 'stranger', answer: 'DONE', durationMs: 1, reason: 'answer' })).toBe(false)
  expect(await onTurn(io, { answer: 'hello', durationMs: 1, reason: 'answer' })).toBe(false)
  expect(await drainFacts(io, '/r')).toEqual([{ kind: 'turn', agentId: 'ag25', answer: 'DONE', ms: 1200, usage, reason: 'answer', at: 0 }])

  const report = '<agent-message from="ag25">\n[Subagent hand-back] DONE'
  expect(await isOwnReport(io, { origin: { kind: 'peer' }, text: report })).toBe(true)
  expect(await isOwnReport(io, { origin: { kind: 'peer' }, text: '<agent-message from="stranger">\nhi' })).toBe(false)
  // A person who types the same text is a person.
  expect(await isOwnReport(io, { text: report })).toBe(false)
  expect(await isOwnReport(io, { origin: { kind: 'composer' }, text: report })).toBe(false)
})

test('an agent that the fence did not see stops the line', async () => {
  const job = build('26')
  const io = world([job])
  const description = `factory builder ${job.id}`
  // The engine runs the plugin's agent.spawn hook, which notes the spawn.
  const seen = async () => {
    await onSpawn(io, { subagentType: 'factory:builder', description })

    return { agentId: 'ag26' }
  }
  expect(await checkedSpawn(io, seen, { role: 'builder', description, prompt: 'p' })).toEqual({ agentId: 'ag26' })
  expect(await agentOf(io, '/r', 'ag26')).toEqual({ jobId: job.id, role: 'builder', focus: '' })

  // The hook was not run: the agent is outside the fence.
  const unseen = async () => ({ agentId: 'ag27' })
  expect(await checkedSpawn(io, unseen, { role: 'builder', description, prompt: 'p' })).toEqual({ no: 'the fence did not see this agent' })
  expect(io.files[`${DIR}/stop`]).toBe('stop\n')
  expect(io.toasts.at(-1)).toBe('Factory: an agent started outside the fence. The line is stopped.')
  // A refusal of the engine is passed on.
  expect(await checkedSpawn(io, async () => ({ deny: 'a limit' }), { role: 'builder', description, prompt: 'p' })).toEqual({ no: 'a limit' })
})
