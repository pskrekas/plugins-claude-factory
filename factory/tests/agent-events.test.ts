import { expect, test } from 'claude-code/testing'

import { storeKey } from '../core/consent'
import { move, newJob, startWork } from '../core/job'
import type { Job } from '../core/job'
import { stateFolderOf } from '../core/state-path'
import { agentOf, checkedSpawn, isOwnReport, onShell, onSpawn, onToolCheck, onTurn, rememberAgent, spawnSettled } from '../hooks/agent-events'
import { drainFacts } from '../hooks/inbox'
import { fakeIo } from './kit'

const DIR = '/state/' + stateFolderOf('/r/.git')
const build = (item: string, shell: 'container' | 'host' = 'host'): Job => ['spec', 'build'].reduce((j, to) => move(j, to as 'spec', 'ok', 1), newJob({ id: item, title: 'A thing' }, 1, shell))
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
  expect(await onSpawn(io, { subagentType: 'factory:builder-host', description: `factory builder ${job.id}` })).toEqual({ cwd: wt(job), jobId: job.id, role: 'builder', focus: '' })
  expect(await onSpawn(io, { subagentType: 'factory:reviewer', description: `factory reviewer:code ${job.id}` })).toEqual({ cwd: wt(job), jobId: job.id, role: 'reviewer', focus: 'code' })
  // The engine's hook settles each spawn it let through; here the test does.
  spawnSettled()
  spawnSettled()
  const refused = { deny: 'Only the factory line starts this agent.' }
  for (const description of ['help me', `factory spec ${job.id}`, 'factory builder 99-unknown', `factory builder ${job.id} extra`, `factory builder:../x ${job.id}`, 'factory builder ../x']) {
    expect([description, await onSpawn(io, { subagentType: 'factory:builder-host', description })]).toEqual([description, refused])
  }
  // A job's builder is of the kind the job says: a job on this machine gets no container builder, and the other way round.
  const boxed = build('29', 'container')
  const both = world([job, boxed])
  expect(await onSpawn(both, { subagentType: 'factory:builder', description: `factory builder ${job.id}` })).toEqual(refused)
  expect(await onSpawn(both, { subagentType: 'factory:builder-host', description: `factory builder ${boxed.id}` })).toEqual(refused)
  expect(await onSpawn(both, { subagentType: 'factory:builder', description: `factory builder ${boxed.id}` })).toEqual({ cwd: wt(boxed), jobId: boxed.id, role: 'builder', focus: '' })
  spawnSettled()
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

test('an agent the fence does not know is looked up at once, and refused while a spawn of the line is not settled', async () => {
  const job = startWork(build('28'), { agentId: 'ag28', role: 'builder', focus: '', startedAt: 5 }, 6)
  const io = world([job])
  io.time = 90_000
  // Two ids that were never seen, in the same moment: each one is looked up.
  expect(await agentOf(io, '/r', 'nobody-28')).toBe(null)
  expect(await agentOf(io, '/r', 'ag28')).toEqual({ jobId: job.id, role: 'builder', focus: '' })
  // The same unknown id is not looked up again within a second.
  const reads = io.reads.length
  expect(await agentOf(io, '/r', 'nobody-28')).toBe(null)
  expect(io.reads.length).toBe(reads)

  // The line started an agent whose id is not known yet: a call of an unknown agent is refused, not passed on.
  await onSpawn(io, { subagentType: 'factory:builder-host', description: `factory builder ${job.id}` })
  expect(await onToolCheck(io, { agentId: 'early-28', tool: 'mcp__factory__sh', input: { command: 'ls' } })).toEqual({
    decision: 'deny',
    reason: 'The fence does not know this agent yet. Try again in a moment.',
  })
  expect(await onToolCheck(io, { agentId: 'early-28', tool: 'Bash', input: { command: 'git push' } })).toEqual({
    decision: 'deny',
    reason: 'The fence does not know this agent yet. Try again in a moment.',
  })
  expect(await onToolCheck(io, { agentId: 'early-28', tool: 'SubagentHandback', input: {} })).toBe(null)
  expect(await onToolCheck(io, { tool: 'Bash', input: { command: 'ls' } })).toBe(null)
  spawnSettled()
  io.time = 95_000
  expect(await onToolCheck(io, { agentId: 'early-28', tool: 'Bash', input: { command: 'git push' } })).toBe(null)
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
    await onSpawn(io, { subagentType: 'factory:builder-host', description })
    spawnSettled()

    return { agentId: 'ag26' }
  }
  expect(await checkedSpawn(io, seen, { role: 'builder', shell: 'host', description, prompt: 'p' })).toEqual({ agentId: 'ag26' })
  expect(await agentOf(io, '/r', 'ag26')).toEqual({ jobId: job.id, role: 'builder', focus: '' })

  // The hook was not run: the agent is outside the fence.
  const unseen = async () => ({ agentId: 'ag27' })
  expect(await checkedSpawn(io, unseen, { role: 'builder', shell: 'host', description, prompt: 'p' })).toEqual({ no: 'the fence did not see this agent' })
  expect(io.files[`${DIR}/stop`]).toBe('stop\n')
  expect(io.toasts.at(-1)).toBe('Factory: an agent started outside the fence. The line is stopped.')
  // A refusal of the engine is passed on.
  expect(await checkedSpawn(io, async () => ({ deny: 'a limit' }), { role: 'builder', shell: 'host', description, prompt: 'p' })).toEqual({ no: 'a limit' })
  // The kind of builder that is asked for is the job's kind.
  const types: string[] = []
  const note = async (input: { subagentType: string }) => {
    types.push(input.subagentType)

    return { deny: 'no' }
  }
  await checkedSpawn(io, note, { role: 'builder', shell: 'container', description, prompt: 'p' })
  await checkedSpawn(io, note, { role: 'builder', shell: 'host', description, prompt: 'p' })
  await checkedSpawn(io, note, { role: 'reviewer', shell: 'container', description: `factory reviewer:code ${job.id}`, prompt: 'p' })
  expect(types).toEqual(['factory:builder', 'factory:builder-host', 'factory:reviewer'])
})

const BOXED = '{"factory": {"container": {"image": "node:22"}, "forbiddenCommands": [["npm", "publish"]]}}'
const LABEL = stateFolderOf('/r/.git')
// A world where docker answers: the job's container runs, and a command prints `out`.
const BOX_LINE = '[container] node:22 · network on · memory 4g · cpus 2'
const BASE = 'f'.repeat(40)
// `settings` is the file of the base branch; the person approved the container line.
function shellWorld(jobs: Job[], settings = BOXED, isRunning = true, approved = [BOX_LINE]) {
  const io = world(jobs, { '/r/.claude/factory.json': BOXED })
  io.store.set(storeKey('/r/.git'), approved)
  io.answer = argv => {
    const line = argv.join(' ')
    if (line === 'git rev-parse --verify refs/remotes/origin/main^{commit}') return { exitCode: 0, stdout: BASE + '\n' }
    if (line === `git show ${BASE}:.claude/factory.json`) return { exitCode: 0, stdout: settings }
    if (line === 'id -u') return { exitCode: 0, stdout: '501\n' }
    if (line === 'id -g') return { exitCode: 0, stdout: '20\n' }
    if (line.startsWith('docker inspect')) return isRunning ? { exitCode: 0, stdout: 'true\n' } : { exitCode: 1, stdout: '', stderr: 'No such object' }
    if (line.startsWith('docker exec')) return { exitCode: 0, stdout: 'hello\n' }

    return line.startsWith('docker ') ? { exitCode: 0, stdout: '' } : undefined
  }

  return io
}
const dockerOf = (io: { ran: string[] }) => io.ran.filter(line => line.startsWith('docker '))
const NOT_YOURS = { deny: 'This tool is for the builder of the factory line.' }

test("the builder's command runs in its job's container, as one argument, in the job's folder", async () => {
  const job = build('41', 'container')
  const io = shellWorld([job], BOXED, false)
  rememberAgent('sh41', { jobId: job.id, role: 'builder', focus: '' })
  const name = `factory-job-${job.id}.${LABEL}`
  const command = 'cd src && npm test -- --watch=false; echo "$HOME" `id` $(ls) > /etc/x'

  expect(await onShell(io, { agentId: 'sh41', command })).toEqual({ result: 'exit 0\nhello\n' })
  // The container is made over the job's folder, then the command is one argument of the shell inside it.
  expect(dockerOf(io).map(line => line.split(' ').slice(0, 2).join(' '))).toEqual(['docker inspect', 'docker rm', 'docker run', 'docker exec'])
  expect(dockerOf(io).at(-1)).toBe(`docker exec -w ${wt(job)} ${name} sh -c ${command}`)
  expect(dockerOf(io)[2]).toContain(`-v ${wt(job)}:${wt(job)} `)
  expect(dockerOf(io)[2]).toContain(' node:22 sleep infinity')
  // Nothing of the command ran on this machine: beside docker, only the plugin's own reads.
  expect(io.ran.filter(line => !line.startsWith('docker ') && !line.startsWith('id -'))).toEqual(['git rev-parse --verify refs/remotes/origin/main^{commit}', `git show ${BASE}:.claude/factory.json`])
})

test('a command has 2 minutes, or what the builder asks for, 10 minutes at most', async () => {
  const job = build('42', 'container')
  const io = shellWorld([job])
  rememberAgent('sh42', { jobId: job.id, role: 'builder', focus: '' })
  const limitOf = async (timeout_ms?: unknown) => {
    await onShell(io, { agentId: 'sh42', command: 'npm test', timeout_ms })

    return io.timeouts.at(-1)
  }
  expect([await limitOf(), await limitOf(300_000), await limitOf(9_000_000), await limitOf(5), await limitOf('soon'), await limitOf(-1)]).toEqual([120_000, 300_000, 600_000, 1_000, 120_000, 120_000])
  // The container that runs is used again: no second one is made.
  expect(dockerOf(io).some(line => line.startsWith('docker run'))).toBe(false)
})

test("the shell tool answers only the builder of a job that builds in a container", async () => {
  const boxed = build('43', 'container')
  const onHost = build('44')
  const gone = move(build('45', 'container'), 'gate', 'built', 2)
  const io = shellWorld([boxed, onHost, gone])
  rememberAgent('b43', { jobId: boxed.id, role: 'builder', focus: '' })
  rememberAgent('r43', { jobId: boxed.id, role: 'reviewer', focus: 'code' })
  rememberAgent('b44', { jobId: onHost.id, role: 'builder', focus: '' })
  rememberAgent('b45', { jobId: gone.id, role: 'builder', focus: '' })

  // The session's own model, an agent that is not the line's, a reviewer, a builder of a job on this machine, a builder whose job left Build.
  for (const agentId of [undefined, 'stranger', 'r43', 'b44', 'b45']) expect([agentId, await onShell(io, { agentId, command: 'ls' })]).toEqual([agentId, NOT_YOURS])
  expect(dockerOf(io)).toEqual([])
  expect(await onShell(io, { agentId: 'b43', command: 'ls' })).toEqual({ result: 'exit 0\nhello\n' })
  // A call with no command is not run.
  for (const command of [undefined, '', '   ', 7]) expect([command, await onShell(io, { agentId: 'b43', command })]).toEqual([command, { deny: 'The command was not run: give one command as text.' }])
})

test('a forbidden command is refused before any docker call, and is a fact', async () => {
  const job = build('46', 'container')
  const io = shellWorld([job])
  rememberAgent('b46', { jobId: job.id, role: 'builder', focus: '' })

  expect(await onShell(io, { agentId: 'b46', command: 'cd pkg && npm publish' })).toEqual({ deny: 'This command is forbidden in this repository.' })
  expect(dockerOf(io)).toEqual([])
  expect((await drainFacts(io, '/r')).map(fact => (fact.kind === 'refusal' ? [fact.agentId, fact.command] : null))).toEqual([['b46', 'npm publish']])
  // The fence gives the same answer when the engine asks it first.
  expect(await onToolCheck(io, { agentId: 'b46', tool: 'mcp__factory__sh', input: { command: 'npm publish' } })).toEqual({ decision: 'deny', reason: 'This command is forbidden in this repository.' })
  expect(await onToolCheck(io, { agentId: 'b46', tool: 'mcp__factory__sh', input: { command: 'npm test' } })).toEqual({ decision: 'allow' })
  expect((await onToolCheck(io, { agentId: 'b46', tool: 'Bash', input: { command: 'npm test' } }))?.decision).toBe('deny')
})

test('with no container the command is not run, and the builder is told why', async () => {
  const job = build('47', 'container')
  // The settings name no container any more.
  const bare = shellWorld([job], '{"factory": {}}')
  // (The settings are read again after a few seconds.)
  bare.time = 30_000
  rememberAgent('b47', { jobId: job.id, role: 'builder', focus: '' })
  expect(await onShell(bare, { agentId: 'b47', command: 'ls' })).toEqual({ deny: 'The command was not run: the settings name no container.' })
  expect(dockerOf(bare)).toEqual([])
  // The base branch names a container that the person did not approve.
  const quiet = shellWorld([job], BOXED, true, [])
  quiet.time = 60_000
  expect(await onShell(quiet, { agentId: 'b47', command: 'ls' })).toEqual({ deny: 'The command was not run: the container settings are not approved.' })
  expect(dockerOf(quiet)).toEqual([])
  // The base branch cannot be read.
  const blind = world([job], { '/r/.claude/factory.json': BOXED })
  blind.time = 90_000
  expect(await onShell(blind, { agentId: 'b47', command: 'ls' })).toEqual({ deny: 'The command was not run: no branch origin/main.' })
  // Docker is not on the machine.
  const none = shellWorld([job])
  none.time = 120_000
  const answer = none.answer
  none.answer = argv => (argv[0] === 'docker' ? undefined : answer?.(argv))
  expect(await onShell(none, { agentId: 'b47', command: 'ls' })).toEqual({ deny: 'The command was not run: docker is not on this machine.' })
})

test("the container is the base branch's: the file in the person's checkout names no image", async () => {
  const job = build('48', 'container')
  const io = shellWorld([job], BOXED, false)
  io.time = 150_000
  io.files['/r/.claude/factory.json'] = '{"factory": {"container": {"image": "evil:1"}}}'
  rememberAgent('b48', { jobId: job.id, role: 'builder', focus: '' })
  expect(await onShell(io, { agentId: 'b48', command: 'ls' })).toEqual({ result: 'exit 0\nhello\n' })
  expect(dockerOf(io).find(line => line.startsWith('docker run'))).toContain(' node:22 sleep infinity')
  expect(dockerOf(io).some(line => line.includes('evil'))).toBe(false)
})
