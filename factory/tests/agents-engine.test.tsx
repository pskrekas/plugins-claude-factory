import { expect, test } from 'claude-code/testing'

import { move, newJob, startWork } from '../core/job'
import type { Job } from '../core/job'
import { lockText } from '../core/lock'
import { START, STATE, engine } from './kit'

const NOW = 1_000_000
const building = (item: string, agentId: string): Job =>
  startWork(['spec', 'build'].reduce((j, to) => move(j, to as 'spec', 'ok', 1), newJob({ id: item, title: 'A thing' }, 1)), { agentId, role: 'builder', focus: '' , startedAt: 5 }, 6)
const world = (on: Parameters<typeof engine>[0], job: Job) =>
  engine(on, {
    files: { [`${STATE}/jobs/${job.id}/job.json`]: JSON.stringify(job), [`${STATE}/worktrees/${job.id}/README.md`]: 'x' },
    now: NOW,
  })
const inbox = (w: { files: Record<string, string> }) =>
  Object.entries(w.files).filter(([name]) => name.startsWith(`${STATE}/inbox/`)).map(([, text]) => JSON.parse(text) as { kind: string; agentId: string; command?: string; usage?: unknown })

test('the five agent types are registered at the start, and the model is not offered them', async ($, on) => {
  const w = world(on, building('31', 'e31'))
  await $.session.start(START)

  expect(w.registered.map(spec => spec.name)).toEqual(['intake', 'spec', 'builder', 'reviewer', 'approver'])
  expect(w.registered.find(spec => spec.name === 'builder')?.tools).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'])
  expect(w.registered.find(spec => spec.name === 'intake')?.model).toBe('opus')
  expect(await $.agent.offer({ agent: 'factory:builder', description: 'x' } as never)).toEqual({ isOffered: false })
  expect(await $.agent.offer({ agent: 'general-purpose', description: 'x' } as never)).toEqual({ isOffered: true })
})

test('a tool call of a job\'s agent goes through the fence; any other call is not the plugin\'s', async ($, on) => {
  const w = world(on, building('32', 'e32'))
  await $.session.start(START)
  const check = (input: object) => $.tool.check(input as never)

  expect(await check({ tool: 'Bash', input: { command: 'npm test' }, agentId: 'e32' })).toEqual({ decision: 'allow' })
  expect(await check({ tool: 'Bash', input: { command: 'git push origin main' }, agentId: 'e32' })).toEqual({ decision: 'deny', reason: 'The line pushes; an agent does not.' })
  expect(inbox(w)).toEqual([{ kind: 'refusal', agentId: 'e32', command: 'git push origin main', at: NOW }])
  // The engine's own answer comes back unchanged.
  expect(await check({ tool: 'Bash', input: { command: 'git push origin main' } })).toEqual({ decision: 'ask' })
  expect(await check({ tool: 'Bash', input: { command: 'git push origin main' }, agentId: 'someone-else' })).toEqual({ decision: 'ask' })
  expect(await check({ tool: 'SubagentHandback', input: { message: 'DONE' }, agentId: 'e32' })).toEqual({ decision: 'ask' })
})

test('the end of an agent\'s turn is a fact, and its report does not reach the model', async ($, on) => {
  const w = world(on, building('33', 'e33'))
  await $.session.start(START)
  const usage = { model: 'm', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }

  await $.turn.complete({ agentId: 'e33', answer: 'DONE', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer', usage } as never)
  expect(inbox(w).map(fact => [fact.kind, fact.agentId, fact.usage])).toEqual([['turn', 'e33', usage]])
  await $.turn.complete({ answer: 'hello', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  expect(inbox(w).length).toBe(1)

  const report = '<agent-message from="e33">\n[Subagent hand-back] DONE'
  expect(await $.prompt.submit({ text: report, origin: { kind: 'peer' } } as never)).toEqual({ drop: 'factory: an agent of the line finished' })
  expect(await $.prompt.submit({ text: 'hello' } as never)).toEqual({ text: 'hello' })
  expect(await $.prompt.submit({ text: report } as never)).toEqual({ text: report })
})

test('only the line starts an agent of its types, and it starts in the job\'s worktree', async ($, on) => {
  const job = building('34', 'e34')
  const w = world(on, job)
  await $.session.start(START)

  expect(await $.agent.spawn({ subagentType: 'factory:builder', description: 'please build', prompt: 'p' } as never)).toEqual({ deny: 'Only the factory line starts this agent.' })
  expect(w.spawned).toEqual([])
  const started = await $.agent.spawn({ subagentType: 'factory:builder', description: `factory builder ${job.id}`, prompt: 'p' } as never)
  expect(started).toEqual({ model: 'm', agentId: 'a1' })
  expect(w.spawned).toEqual([{ type: 'factory:builder', description: `factory builder ${job.id}`, cwd: `${STATE}/worktrees/${job.id}` }])
  // The new agent is fenced at once.
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 1' }, agentId: 'a1' } as never)).toEqual({ decision: 'deny', reason: 'The line talks to the host; an agent does not.' })
  // Another kind of agent is not touched.
  await $.agent.spawn({ subagentType: 'general-purpose', description: 'x', prompt: 'p' } as never)
  expect(w.spawned.at(-1)).toEqual({ type: 'general-purpose', description: 'x', cwd: undefined })
})

test('when an agent of the line ends, its hook advances the job; a new agent that the fence did not see stops the line', async ($, on) => {
  const spec = startWork(move(newJob({ id: '35', title: 'A thing' }, 1), 'spec', 'ok', 1, { risk: 'low', surfaces: [], reviewers: ['code'] }), { agentId: 'e35', role: 'spec', focus: '', startedAt: NOW }, NOW)
  const w = engine(on, {
    files: {
      [`${STATE}/jobs/${spec.id}/job.json`]: JSON.stringify(spec),
      [`${STATE}/jobs/${spec.id}/out/spec.md`]: '## Summary\n- build it',
      [`${STATE}/worktrees/${spec.id}/README.md`]: 'x',
      [`${STATE}/run.json`]: JSON.stringify({ version: 1, session: 'session-1', startedAt: NOW, queue: [] }),
      [`${STATE}/lock.1/holder`]: lockText('session-1', NOW, '/r'),
    },
    agents: [{ id: 'e35', status: 'completed', type: 'factory:spec', description: 'x' }],
    now: NOW,
  })
  await $.session.start(START)
  await $.turn.complete({ agentId: 'e35', answer: 'DONE', durationMs: 60_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  // The hook advanced the job: the spec's file was taken, the job is in Build,
  // and the builder was started with the line's own description.
  const job = JSON.parse(w.files[`${STATE}/jobs/${spec.id}/job.json`] ?? '{}') as Job
  expect(job.stage).toBe('build')
  expect(w.files[`${STATE}/jobs/${spec.id}/files/spec.md`]).toBe('## Summary\n- build it')
  expect(w.spawned.map(one => one.description)).toEqual([`factory builder ${spec.id}`])
  // This test engine does not run the plugin's own agent.spawn hook for a
  // spawn the plugin makes (the real engine does: docs/notes/r2b-check.md).
  // So the fence did not see the agent, and the line stops itself.
  expect(job.work).toEqual([])
  expect(w.files[`${STATE}/stop`]).toBe('stop\n')
  expect(w.toasts).toContain('Factory: an agent started outside the fence. The line is stopped.')
})
