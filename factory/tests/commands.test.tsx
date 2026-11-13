import { expect, test } from 'claude-code/testing'

import { addSpend, move, newJob, stop } from '../core/job'
import type { Job } from '../core/job'
import { lockText } from '../core/lock'
import { storeKey } from '../core/consent'
import { mcpLines, parseMcpTracker } from '../core/mcp-tracker'
import type { McpTracker } from '../core/mcp-tracker'
import { trackerCheck } from '../hooks/commands'
import { START, STATE, cmd, engine, fakeIo } from './kit'
import { GOOD } from './mcp-good'

const NOW = 1_000_000
const SETTINGS = '{"tracker": {"kind": "github"}, "factory": {"forbiddenCommentWords": ["acme"]}}'
const file = (j: Job) => ({ [`${STATE}/jobs/${j.id}/job.json`]: JSON.stringify(j) })
const base = (id: string) => newJob({ id, title: 'A thing' }, NOW)
const walk = (id: string, stages: Job['stage'][]) => stages.reduce((j, to) => move(j, to, 'ok', NOW), base(id))
const readJob = (world: { files: Record<string, string> }, j: Job) =>
  JSON.parse(world.files[`${STATE}/jobs/${j.id}/job.json`] ?? 'null') as Job | null

// gh and git answer 0 unless the test says otherwise.
// Like the real gh, it refuses a label that the repository does not have yet.
function tools(fail: string[] = []) {
  let hasLabels = false

  return (argv: readonly string[]) => {
    const line = argv.join(' ')
    if (argv[0] !== 'gh' && argv[0] !== 'git') return undefined
    if (fail.some(start => line.startsWith(start))) return { exitCode: 1, stdout: '', stderr: 'it broke' }
    if (line.startsWith('gh label create')) hasLabels = true
    if (line.startsWith('gh issue edit') && !hasLabels) {
      return { exitCode: 1, stdout: '', stderr: "'factory:in-progress' not found" }
    }
    if (line.startsWith('gh pr view')) {
      return { exitCode: 0, stdout: JSON.stringify({ number: 21, state: 'OPEN', isDraft: true, url: 'u', statusCheckRollup: [] }) }
    }

    return { exitCode: 0, stdout: '' }
  }
}

function world(on: Parameters<typeof engine>[0], jobs: Job[], extra: Record<string, string> = {}, fail: string[] = []) {
  const files = { '/r/.claude/factory.json': SETTINGS, ...Object.assign({}, ...jobs.map(file)), ...extra }

  return engine(on, { files, remote: 'git@github.com:a/b.git', run: tools(fail), now: NOW })
}
const factoryRuns = (w: { ran: string[] }) =>
  w.ran.filter(line => (line.startsWith('gh issue') && !line.startsWith('gh issue list') && !line.startsWith('gh issue view')) || line.startsWith('gh pr c') || line.startsWith('git worktree remove'))

test('/factory run and /factory plan are a person\'s own, and need a tracker', async ($, on) => {
  engine(on, { files: {}, run: tools(), now: NOW })
  await $.session.start(START)
  expect((await $.command.run(cmd('run', 'sdk'))).text).toBe('Only a person can do this. Type the command at the prompt.')
  expect((await $.command.run(cmd('run 12', 'plugin'))).text).toBe('Only a person can do this. Type the command at the prompt.')
  expect((await $.command.run(cmd('run'))).text).toBe('/factory run needs a tracker in the settings (github, azure-boards or mcp).')
  expect((await $.command.run(cmd('plan', 'sdk'))).text).toBe('Only a person can do this. Type the command at the prompt.')
  expect((await $.command.run(cmd('plan'))).text).toBe('/factory plan needs a tracker in the settings (github, azure-boards or mcp).')
})

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

  expect((await $.command.run(cmd('answer 14 Use the handwriting font.'))).text).toBe('14 goes on in intake. Run /factory run to go on.')
  const now = readJob(w, asked)
  expect([now?.stage, now?.question, now?.feedback]).toEqual(['intake', null, 1])
  expect(w.files[`${STATE}/jobs/${asked.id}/files/feedback-1.md`]).toBe('Use the handwriting font.')
  expect(factoryRuns(w)).toEqual(['gh issue edit 14 --add-label factory:in-progress --remove-label factory:needs-human -R a/b'])
})

test('answer on a job stopped for rounds grants one and sends it to Build, round 2', async ($, on) => {
  const failed = { ...walk('12', ['spec', 'build', 'gate']), sentBack: { by: 'gate' as const, why: '2 tests failed' } }
  const stopped = stop(failed, { question: 'round limit: 3 rounds with no pass', asker: 'limit', resumeAt: 'build' }, NOW)
  const w = world(on, [stopped])
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 12'))).text).toBe('12 goes on in build. Run /factory run to go on.')
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
  expect((await $.command.run(cmd('answer 10 Make the button blue.'))).text).toBe('10 goes back to Build, round 2. Run /factory run to go on.')
  const now = readJob(w, ready)
  expect([now?.stage, now?.round, now?.sentBack]).toEqual(['build', 2, { by: 'you', why: 'Make the button blue.' }])
})

test('what sent a ready job back is the start of what the person said', async ($, on) => {
  const ready = { ...walk('10', ['spec', 'build', 'gate', 'review', 'approve', 'ready']), pr: { number: 21, url: 'u' } }
  const w = world(on, [ready])
  await $.session.start(START)
  const long = 'Make it blue. '.repeat(60)

  await $.command.run(cmd(`answer 10 ${long}`))
  expect(readJob(w, ready)?.sentBack?.why.length).toBe(300)
  expect(w.files[`${STATE}/jobs/${ready.id}/files/feedback-1.md`]).toBe(long.trim())
})

test('reject of an item the tracker says is claimed, with no job here, writes to the tracker only', async ($, on) => {
  const issues = JSON.stringify([
    { number: 31, title: 'Lost', state: 'OPEN', labels: [{ name: 'factory' }, { name: 'factory:in-progress' }] },
    { number: 4, title: 'Fonts', state: 'OPEN', labels: [{ name: 'factory' }] },
  ])
  const answer = tools()
  const files = { '/r/.claude/factory.json': SETTINGS }
  const w = engine(on, {
    files,
    remote: 'git@github.com:a/b.git',
    run: argv => (argv.join(' ').startsWith('gh issue list') ? { exitCode: 0, stdout: issues } : answer(argv)),
    now: NOW,
  })
  await $.session.start(START)

  // An item in the queue, or one the tracker does not know, has nothing to reject.
  expect((await $.command.run(cmd('reject 4 no'))).text).toBe('No job for 4.')
  expect((await $.command.run(cmd('reject 99 no'))).text).toBe('No job for 99.')
  expect(factoryRuns(w)).toEqual([])

  expect((await $.command.run(cmd('reject 31 Its folder is lost.'))).text).toBe('31 is rejected. The reason is on the item.')
  expect(factoryRuns(w)).toEqual([
    'gh issue comment 31 --body-file - -R a/b',
    'gh issue close 31 --reason not planned -R a/b',
    'gh issue edit 31 --remove-label factory:in-progress --remove-label factory:needs-human -R a/b',
  ])
  expect(w.stdins[w.ran.indexOf('gh issue comment 31 --body-file - -R a/b')]).toBe('The factory dropped this: Its folder is lost.')
  expect(Object.keys(w.files).some(name => name.includes('/jobs/') || name.includes('/retired/'))).toBe(false)
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
    'gh issue comment 12 --body-file - -R a/b',
    'gh pr close 21 -R a/b',
    'gh issue close 12 --reason not planned -R a/b',
    'gh issue edit 12 --remove-label factory:in-progress --remove-label factory:needs-human -R a/b',
    `git worktree remove --force ${STATE}/worktrees/${job.id}`,
  ])
  expect(w.stdins[w.ran.indexOf('gh issue comment 12 --body-file - -R a/b')]).toBe('The factory dropped this: Not worth building.')
  expect(readJob(w, job)).toBe(null)
  const retired = Object.keys(w.files).find(name => name.startsWith(`${STATE}/retired/${job.id}.`) && name.endsWith('job.json'))
  expect((JSON.parse(w.files[retired ?? ''] ?? '{}') as Job).stage).toBe('rejected')
})

test('a reject that fails at the pull request leaves the job as it was, and a second run finishes', async ($, on) => {
  const job = { ...walk('12', ['spec', 'build']), pr: { number: 21, url: 'u' } }
  const fail = ['gh pr close']
  const failing = world(on, [job], {}, fail)
  await $.session.start(START)

  expect((await $.command.run(cmd('reject 12 no'))).text).toBe(
    '12 was not rejected: close the pull request failed (gh: it broke). Run the command again.',
  )
  expect(readJob(failing, job)?.stage).toBe('build')

  fail.length = 0
  expect((await $.command.run(cmd('reject 12 no'))).text).toBe('12 is rejected. The reason is on the item.')
  expect(readJob(failing, job)).toBe(null)
})

test('a reject whose clean-up fails is still a reject, and says what is left', async ($, on) => {
  const job = { ...walk('12', ['spec', 'build']), branch: 'factory/12-a-thing' }
  const w = world(on, [job], { [`${STATE}/worktrees/${job.id}/README.md`]: 'x' }, ['git worktree remove'])
  await $.session.start(START)

  expect((await $.command.run(cmd('reject 12 no'))).text).toBe(
    '12 is rejected. The reason is on the item. Not cleaned up: remove the worktree (git: it broke).',
  )
  // The tracker and the job agree: a second reject finds nothing to do.
  expect(readJob(w, job)).toBe(null)
  expect((await $.command.run(cmd('reject 12 no'))).text).toBe('No job for 12.')
})

test('a tracker that cannot be read is named, not taken for "no job"', async ($, on) => {
  const w = world(on, [], {}, ['gh issue list'])
  await $.session.start(START)

  expect((await $.command.run(cmd('reject 31 no'))).text).toBe(
    '31 was not rejected: read the tracker failed (gh: it broke). Run the command again.',
  )
  expect(factoryRuns(w)).toEqual([])
})

test('the state labels are made before the first state is written, and every gh call names the repository', async ($, on) => {
  const asked = stop(base('14'), { question: 'Which font?', asker: 'intake' }, NOW)
  const w = world(on, [asked])
  await $.session.start(START)
  await $.command.run(cmd('answer 14 The first one.'))

  const gh = w.ran.filter(line => line.startsWith('gh label') || line.startsWith('gh issue edit'))
  expect(gh).toEqual([
    'gh label create factory:in-progress --force --description The factory works on this -R a/b',
    'gh label create factory:needs-human --force --description The factory waits for a person -R a/b',
    'gh issue edit 14 --add-label factory:in-progress --remove-label factory:needs-human -R a/b',
  ])
})

test('a remote that names no GitHub repository gives no tracker: nothing is written anywhere else', async ($, on) => {
  const asked = stop(base('14'), { question: 'Which font?', asker: 'intake' }, NOW)
  const files = { '/r/.claude/factory.json': '{"tracker": {"kind": "github"}, "prHost": "github"}', ...file(asked) }
  const w = engine(on, { files, remote: 'https://example.com/a/b.git', run: tools(), now: NOW })
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 14 hello'))).text).toBe(
    '14 goes on in intake. No tracker is set: nothing was written to one. Run /factory run to go on.',
  )
  expect(w.ran.some(line => line.startsWith('gh '))).toBe(false)
})

test('an answer that cannot reach the tracker changes nothing and says so', async ($, on) => {
  const asked = stop(base('14'), { question: 'Which font?', asker: 'intake' }, NOW)
  const w = world(on, [asked], {}, ['gh issue edit'])
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 14 hello'))).text).toBe(
    '14 was not changed: set the tracker state failed (gh: it broke). Run the command again.',
  )
  expect(readJob(w, asked)?.stage).toBe('needs-info')
})

test('a question for the author needs text; a limit of the day is not lifted by an answer', async ($, on) => {
  const asked = stop(base('14'), { question: 'Which font?', asker: 'intake' }, NOW)
  // The job is under its own limit (10); with another job the day is over its limit (50).
  const spent = addSpend(walk('12', ['spec', 'build']), 'build', 60_000, 9, NOW)
  const other = addSpend(walk('13', ['spec']), 'spec', 60_000, 45, NOW)
  const day = stop(spent, { question: 'cost limit for the day', asker: 'limit' }, NOW)
  const w = world(on, [asked, day, other])
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 14'))).text).toBe('Give the answer as text: /factory answer 14 <text>')
  expect(readJob(w, asked)?.stage).toBe('needs-info')
  expect((await $.command.run(cmd('answer 12 go on'))).text).toBe(
    '12 is still at a limit (cost limit for the day). Nothing was changed.',
  )
  expect([readJob(w, day)?.stage, readJob(w, day)?.granted.usd]).toEqual(['needs-human', 0])
  expect(factoryRuns(w)).toEqual([])
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
  expect(readJob(w, asked)?.stage).toBe('needs-info')
  // The brake works from any session: it changes no job.
  expect((await $.command.run(cmd('stop'))).text).toBe('The line starts no new station. Running agents finish theirs.')
  expect(w.files[`${STATE}/stop`]).toBe('stop\n')
  expect(factoryRuns(w)).toEqual([])
})

test('with no tracker the job still changes, and the answer says nothing was written to one', async ($, on) => {
  const asked = stop(base('14'), { question: 'Which font?', asker: 'intake' }, NOW)
  const w = engine(on, { files: file(asked), run: tools(), now: NOW })
  await $.session.start(START)

  expect((await $.command.run(cmd('answer 14 hello'))).text).toBe(
    '14 goes on in intake. No tracker is set: nothing was written to one. Run /factory run to go on.',
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

// /factory tracker: reads the tracker and says what it understood, with no text of the tracker in the answer.
const MCP_LINES = mcpLines((parseMcpTracker(GOOD) as { ok: McpTracker }).ok, 'factory')
const SECRETS = ['Zebrafish title', 'Quokka description', 'Wombat Author', 'Narwhal comment', 'Pangolin Runner', 'Axolotl State', 'tracker.example.com']
function trackerWorld(opts: { tasks?: unknown[]; approved?: boolean; tracker?: unknown } = {}) {
  const settings = JSON.stringify({ tracker: opts.tracker ?? GOOD })
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x', '/r/.claude/factory.json': settings }, remote: 'git@github.com:a/b.git', now: 1_000_000 })
  if (opts.approved !== false) io.store.set(storeKey('/r/.git'), MCP_LINES)
  const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], isError: false })
  const tasks = opts.tasks ?? [{ id: 'PROJ-12', title: 'Zebrafish title', state: 'Axolotl State' }, { id: 'PROJ-14', title: 'x', state: 's' }, { id: 'PROJ-15', title: 'x', state: 's' }, { id: 'PROJ-16', title: 'x', state: 's' }]
  io.mcpAnswer = (_, tool, args) => {
    if (tool === 'find_tasks') return text({ tasks: JSON.stringify(args.states) === '["open"]' ? tasks : [{ id: 'PROJ-99', title: 'c', state: 'started' }] })
    if (tool === 'show_task') {
      if (args.task_id === 'PROJ-404') return { failed: 'no-server', why: 'gone' }
      const comments = [{ by: 'Wombat Author', text: 'Narwhal comment 1' }, { by: 'Stranger', text: 'Narwhal comment 2' }, { by: 'Pangolin Runner', text: 'Narwhal comment 3' }, { by: 'Stranger', text: 'Narwhal comment 4' }]

      return text({ title: 'Zebrafish title', description: 'Quokka description', made_by: 'Wombat Author', state: 'Axolotl State', labels: ['factory'], comments })
    }
    if (tool === 'who_am_i') return text({ name: 'Pangolin Runner' })

    return undefined
  }

  return io
}

test('/factory tracker says what it understood and holds no text of the tracker', async () => {
  const io = trackerWorld()
  const answer = await trackerCheck(io, null)
  expect(answer).toBe(
    [
      'Tracker: mcp',
      'Queue: 4 items (PROJ-12, PROJ-14, PROJ-15). Claimed: 1.',
      'Me: read.',
      'PROJ-12: title found (15 characters) · text found (18 characters) · author found · state found · address found',
      'PROJ-12: carries the mark: yes · 4 comments (2 of the author or the runner)',
    ].join('\n'),
  )
  const one = await trackerCheck(io, 'PROJ-12')
  expect(one).toBe(answer)
  expect(one.split('\n').slice(3)).toEqual([
    'PROJ-12: title found (15 characters) · text found (18 characters) · author found · state found · address found',
    'PROJ-12: carries the mark: yes · 4 comments (2 of the author or the runner)',
  ])
  for (const word of SECRETS) expect([word, answer.includes(word) || one.includes(word)]).toEqual([word, false])
  expect(one.length <= 1200).toBe(true)
  // It only reads.
  expect([...new Set(io.mcpCalls.map(call => call[1]))].sort()).toEqual(['find_tasks', 'show_task', 'who_am_i'])
})

test('/factory tracker on a GitHub world says kind github', async () => {
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x', '/r/.claude/factory.json': '{"tracker": {"kind": "github"}}' }, remote: 'git@github.com:a/b.git', now: 1_000_000 })
  io.store.set(storeKey('/r/.git'), ['[tracker] github a/b'])
  io.answer = argv => {
    const line = argv.join(' ')
    if (line.startsWith('gh issue list')) return { exitCode: 0, stdout: JSON.stringify([{ number: 7, title: 'Zebrafish title', state: 'OPEN', labels: [] }]) }
    if (line.startsWith('gh api user')) return { exitCode: 0, stdout: 'runner\n' }
    if (line.startsWith('gh issue view') && line.includes('--json labels')) return { exitCode: 0, stdout: JSON.stringify({ labels: [{ name: 'factory' }] }) }
    if (line.startsWith('gh issue view')) {
      const comments = [{ author: { login: 'Wombat' }, body: 'Narwhal one' }, { author: { login: 'x' }, body: 'Narwhal two' }]

      return { exitCode: 0, stdout: JSON.stringify({ number: 7, title: 'Zebrafish title', state: 'OPEN', body: 'Quokka body', author: { login: 'Wombat' }, comments, url: 'https://github.com/a/b/issues/7' }) }
    }

    return { exitCode: 0, stdout: '[]' }
  }
  const answer = await trackerCheck(io, null)
  expect(answer.split('\n')[0]).toBe('Tracker: github')
  expect(answer.includes('Queue: ')).toBe(true)
  const given = await trackerCheck(io, '7')
  for (const text of [answer, given]) {
    expect(text.split('\n').slice(3).map(line => line.slice(0, 36))).toEqual(['7: title found (15 characters) · tex', '7: carries the mark: yes · 2 comment'])
    for (const word of ['Zebrafish', 'Quokka', 'Wombat', 'Narwhal']) expect([word, text.includes(word)]).toEqual([word, false])
  }
})

test('/factory tracker refusals and failures', async () => {
  // No tracker.
  const none = fakeIo({ files: { '/r/.git/HEAD': 'x', '/r/.claude/factory.json': '{}' }, remote: 'git@github.com:a/b.git', now: 1_000_000 })
  expect(await trackerCheck(none, null)).toBe('No tracker in the settings.')
  // A tracker the settings name and the parser refused: a fixed sentence, no text of the file.
  const refused = fakeIo({ files: { '/r/.git/HEAD': 'x', '/r/.claude/factory.json': JSON.stringify({ tracker: { kind: 'mcp', server: 'Zebrafish', list: { tool: 'Quokka' } } }) }, remote: 'git@github.com:a/b.git', now: 1_000_000 })
  expect(await trackerCheck(refused, null)).toBe("The tracker in the settings file was refused. The pane's settings line says why.")
  // Not approved: the note says so, nothing is called.
  const quiet = trackerWorld({ approved: false })
  expect(await trackerCheck(quiet, null)).toBe("The MCP tracker's calls are not approved. Read them in the pane, then /factory approve.")
  expect(quiet.mcpCalls).toEqual([])
  // Not an id: no call at all.
  const w = trackerWorld()
  expect(await trackerCheck(w, 'bad id!')).toBe('Not an id.')
  expect(w.mcpCalls).toEqual([])
  // Empty queue.
  expect((await trackerCheck(trackerWorld({ tasks: [] }), null)).split('\n')[1]).toBe('Queue: 0 items. Nothing to read. Is the mark right?')
  // Scan fails.
  const down = trackerWorld()
  down.mcpAnswer = null
  const failed = (await trackerCheck(down, null)).split('\n')
  expect(failed[1]?.startsWith('Queue: not read (')).toBe(true)
  expect(failed[2]).toBe('Me: not known.')
  // A failed scan whose text is long, with newlines and a control character: one line, cut, no tail.
  const long = trackerWorld()
  const bad = `${'a\n'.repeat(125)}\u0007${'b'.repeat(10)} Tailword ${'c'.repeat(240)}`
  long.mcpAnswer = (_, tool) => (tool === 'find_tasks' ? { content: [{ type: 'text', text: bad }], isError: true } : undefined)
  const line = ((await trackerCheck(long, null)).split('\n')[1]) ?? ''
  expect([line.startsWith('Queue: not read ('), line.includes('Tailword'), line.length <= 'Queue: not read ()'.length + 200]).toEqual([true, false, true])
  expect(line.includes('\u0007')).toBe(false)
  // An item that cannot be read.
  expect((await trackerCheck(trackerWorld(), 'PROJ-404')).split('\n').at(-1)).toBe('PROJ-404: not read.')
  // A queue id that fails the id rule is counted, not shown.
  const odd = await trackerCheck(trackerWorld({ tasks: [{ id: 'Zebrafish title!', title: 't', state: 's' }, { id: 'PROJ-1', title: 't', state: 's' }] }), null)
  expect(odd.split('\n')[1]).toBe('Queue: 1 item (PROJ-1). Claimed: 1.')
})

test('/factory tracker is a plain command word, not a person-only one', async ($, on) => {
  engine(on, { files: { '/r/.claude/factory.json': '{}' }, now: 1_000_000 })
  await $.session.start(START)
  expect((await $.command.run(cmd('tracker', 'sdk'))).text).toBe('No tracker in the settings.')
  expect((await $.command.run(cmd('tracker PROJ-12', 'sdk'))).text).toBe('No tracker in the settings.')
  expect((await $.command.run(cmd('help'))).text?.includes('/factory tracker [id]')).toBe(true)
})
