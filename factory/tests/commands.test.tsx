import { expect, test } from 'claude-code/testing'

import { addSpend, move, newJob, stop } from '../core/job'
import type { Job } from '../core/job'
import { lockText } from '../core/lock'
import { START, STATE, cmd, engine } from './kit'

const NOW = 1_000_000
const SETTINGS = '{"tracker": {"kind": "github"}, "factory": {"forbiddenCommentWords": ["acme"]}}'
const file = (j: Job) => ({ [`${STATE}/jobs/${j.id}/job.json`]: JSON.stringify(j) })
const base = (id: string) => newJob({ id, title: 'A thing' }, NOW)
const walk = (id: string, stages: Job['stage'][]) => stages.reduce((j, to) => move(j, to, 'ok', NOW), base(id))
const readJob = (world: { files: Record<string, string> }, j: Job) =>
  JSON.parse(world.files[`${STATE}/jobs/${j.id}/job.json`] ?? 'null') as Job | null

// gh and git answer 0 unless the test says otherwise.
const tools = (fail: string[] = []) => (argv: readonly string[]) => {
  const line = argv.join(' ')
  if (argv[0] !== 'gh' && argv[0] !== 'git') return undefined
  if (fail.some(start => line.startsWith(start))) return { exitCode: 1, stdout: '', stderr: 'it broke' }
  if (line.startsWith('gh pr view')) {
    return { exitCode: 0, stdout: JSON.stringify({ number: 21, state: 'OPEN', isDraft: true, url: 'u', statusCheckRollup: [] }) }
  }

  return { exitCode: 0, stdout: '' }
}

function world(on: Parameters<typeof engine>[0], jobs: Job[], extra: Record<string, string> = {}, fail: string[] = []) {
  const files = { '/r/.claude/factory.json': SETTINGS, ...Object.assign({}, ...jobs.map(file)), ...extra }

  return engine(on, { files, remote: 'git@github.com:a/b.git', run: tools(fail), now: NOW })
}
const factoryRuns = (w: { ran: string[] }) =>
  w.ran.filter(line => (line.startsWith('gh issue') && !line.startsWith('gh issue list') && !line.startsWith('gh issue view')) || line.startsWith('gh pr c') || line.startsWith('git worktree remove'))

test('stop sets the flag; only a person can', async ($, on) => {
  const w = world(on, [])
  await $.session.start(START)

  expect((await $.command.run(cmd('stop', 'sdk'))).text).toBe('Only a person can do this. Type the command at the prompt.')
  expect(w.files[`${STATE}/stop`]).toBe(undefined)
  expect((await $.command.run(cmd('stop'))).text).toBe('The line starts no new station. Running agents finish theirs.')
  expect(w.files[`${STATE}/stop`]).toBe('stop\n')
})

test('answer resumes a job that asked a question', async ($, on) => {
  const asked = stop(base('14'), { question: 'Which font?', asker: 'intake' }, NOW)
  const w = world(on, [asked])
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 14 Use the handwriting font.'))).text).toBe('14 goes on in intake.')
  const now = readJob(w, asked)
  expect([now?.stage, now?.question, now?.feedback]).toEqual(['intake', null, 1])
  expect(w.files[`${STATE}/jobs/${asked.id}/files/feedback-1.md`]).toBe('Use the handwriting font.')
  expect(factoryRuns(w)).toEqual(['gh issue edit 14 --add-label factory:in-progress --remove-label factory:needs-human'])
})

test('answer on a job stopped for rounds grants one and sends it to Build, round 2', async ($, on) => {
  const failed = { ...walk('12', ['spec', 'build', 'gate']), sentBack: { by: 'gate' as const, why: '2 tests failed' } }
  const stopped = stop(failed, { question: 'round limit: 3 rounds with no pass', asker: 'limit', resumeAt: 'build' }, NOW)
  const w = world(on, [stopped])
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 12'))).text).toBe('12 goes on in build.')
  const now = readJob(w, stopped)
  expect([now?.stage, now?.round, now?.granted.rounds, now?.feedback]).toEqual(['build', 2, 1, 0])
})

test('answer on a job stopped for cost grants the job limit again', async ($, on) => {
  const spent = addSpend(walk('12', ['spec', 'build']), 'build', 60_000, 10.5, NOW)
  const stopped = stop(spent, { question: 'cost limit for the job', asker: 'limit' }, NOW)
  const w = world(on, [stopped])
  await $.session.start(START)
  await $.command.run(cmd('answer 12 go on'))

  expect(readJob(w, stopped)?.granted).toEqual({ rounds: 0, usd: 10, minutes: 0 })
})

test('answer with text sends a ready job back to Build; with no text it changes nothing', async ($, on) => {
  const ready = { ...walk('10', ['spec', 'build', 'gate', 'review', 'approve', 'ready']), pr: { number: 21, url: 'u' } }
  const w = world(on, [ready])
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 10'))).text).toBe(
    '10 is ready. Merge its pull request, or give it text to change something.',
  )
  expect(readJob(w, ready)?.stage).toBe('ready')
  expect((await $.command.run(cmd('answer 10 Make the button blue.'))).text).toBe('10 goes back to Build, round 2.')
  const now = readJob(w, ready)
  expect([now?.stage, now?.round, now?.sentBack]).toEqual(['build', 2, { by: 'you', why: 'Make the button blue.' }])
})

test('answer on a job that runs, or on no job, says so and changes nothing', async ($, on) => {
  const running = walk('7', ['spec'])
  const w = world(on, [running])
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 7 hello'))).text).toBe('7 does not wait for you (it is in spec).')
  expect((await $.command.run(cmd('answer 99 hello'))).text).toBe('No job for 99.')
  expect((await $.command.run(cmd('answer'))).text).toBe('Say which job: /factory answer <id> [text]')
  for (const id of ['../x', '--help', 'a b']) {
    expect((await $.command.run(cmd(`answer ${id}`))).text?.startsWith('No job for')).toBe(true)
  }
  expect(factoryRuns(w)).toEqual([])
  expect(readJob(w, running)?.stage).toBe('spec')
})

test('reject comments, closes the pull request, sets the state, removes the worktree and retires the job', async ($, on) => {
  const job = { ...walk('12', ['spec', 'build']), pr: { number: 21, url: 'u' }, branch: 'factory/12-a-thing' }
  const w = world(on, [job], { [`${STATE}/worktrees/${job.id}/README.md`]: 'x' })
  await $.session.start(START)

  expect((await $.command.run(cmd('reject 12 Not worth building.'))).text).toBe('12 is rejected. The reason is on the item.')
  expect(factoryRuns(w)).toEqual([
    'gh issue comment 12 --body-file -',
    'gh pr close 21',
    'gh issue edit 12 --remove-label factory:in-progress --remove-label factory:needs-human',
    'gh issue close 12 --reason not planned',
    `git worktree remove --force ${STATE}/worktrees/${job.id}`,
  ])
  expect(w.stdins[w.ran.indexOf('gh issue comment 12 --body-file -')]).toBe('The factory dropped this: Not worth building.')
  expect(readJob(w, job)).toBe(null)
  const retired = Object.keys(w.files).find(name => name.startsWith(`${STATE}/retired/${job.id}.`) && name.endsWith('job.json'))
  expect((JSON.parse(w.files[retired ?? ''] ?? '{}') as Job).stage).toBe('rejected')
})

test('a reject that fails at the pull request leaves the job as it was, and a second run finishes', async ($, on) => {
  const job = { ...walk('12', ['spec', 'build']), pr: { number: 21, url: 'u' } }
  const failing = world(on, [job], {}, ['gh pr close'])
  await $.session.start(START)

  expect((await $.command.run(cmd('reject 12 no'))).text).toBe(
    '12 was not rejected: close the pull request failed (gh: it broke). Run the command again.',
  )
  expect(readJob(failing, job)?.stage).toBe('build')
})

test('a reject needs a reason, and a reason with a forbidden word runs nothing', async ($, on) => {
  const job = walk('12', ['spec'])
  const w = world(on, [job])
  await $.session.start(START)

  expect((await $.command.run(cmd('reject 12'))).text).toBe('A reason is needed: /factory reject <id> <reason>')
  expect((await $.command.run(cmd('reject 12 says ACME'))).text).toBe(
    '12 was not rejected: comment on the item failed (the comment was not sent: a forbidden word). Run the command again.',
  )
  expect((await $.command.run(cmd('reject 12 no', 'plugin'))).text).toBe('Only a person can do this. Type the command at the prompt.')
  expect(factoryRuns(w)).toEqual([])
  expect(readJob(w, job)?.stage).toBe('spec')
})

test('with another session holding the lock, a command changes nothing and says who', async ($, on) => {
  const asked = stop(base('14'), { question: 'Which font?', asker: 'intake' }, NOW)
  const w = world(on, [asked], { [`${STATE}/lock.1/holder`]: lockText('other-session', NOW - 1000, '/somewhere/else') })
  await $.session.start(START)

  const text = 'Another session runs the line (/somewhere/else). Nothing was changed.'
  expect((await $.command.run(cmd('answer 14 hello'))).text).toBe(text)
  expect((await $.command.run(cmd('reject 14 no'))).text).toBe(text)
  expect((await $.command.run(cmd('stop'))).text).toBe(text)
  expect(readJob(w, asked)?.stage).toBe('needs-info')
  expect(factoryRuns(w)).toEqual([])
})

test('with no tracker the job still changes, and the answer says nothing was written to one', async ($, on) => {
  const asked = stop(base('14'), { question: 'Which font?', asker: 'intake' }, NOW)
  const w = engine(on, { files: file(asked), run: tools(), now: NOW })
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 14 hello'))).text).toBe(
    '14 goes on in intake. No tracker is set: nothing was written to one.',
  )
  expect(readJob(w, asked)?.stage).toBe('intake')
  expect(w.ran.some(line => line.startsWith('gh issue edit'))).toBe(false)
})

test('a command leaves the lock free again', async ($, on) => {
  const w = world(on, [])
  await $.session.start(START)
  await $.command.run(cmd('stop'))

  expect(Object.keys(w.files).some(name => name.includes('/lock.'))).toBe(false)
})
