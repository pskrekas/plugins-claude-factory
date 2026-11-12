import { expect, test } from 'claude-code/testing'

import { OUT_FILE } from '../core/agents'
import { storeKey } from '../core/consent'
import type { Role } from '../core/factory-settings'
import { move, newJob, startWork } from '../core/job'
import { lockText } from '../core/lock'
import type { Job, Stage } from '../core/job'
import { stateFolderOf } from '../core/state-path'
import type { Spawn } from '../hooks/agent-events'
import { dropFact } from '../hooks/inbox'
import { answerJob, rejectJob } from '../hooks/commands'
import { isStopped, lockInfo, readJobs, setStop, takeLock } from '../hooks/jobs'
import { advance, watch } from '../hooks/line'
import { readRun, writeRun } from '../hooks/run'
import { startRun } from '../hooks/start'
import { fakeIo } from './kit'

const NOW = 1_700_000_000_000
const DIR = '/state/' + stateFolderOf('/r/.git')
const BASE = 'f'.repeat(40)
const SHA1 = '1'.repeat(40)
const SHA2 = '2'.repeat(40)
const SETTINGS = { tracker: { kind: 'github' }, gate: { fast: [['npm', 'test']], full: [['npm', 'run', 'build']] } }

type World = ReturnType<typeof lineWorld>
function lineWorld(opts: { queue?: string[]; jobs?: Job[]; settings?: object } = {}) {
  const settings = JSON.stringify({ ...SETTINGS, ...opts.settings })
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x', '/r/.claude/factory.json': settings }, remote: 'git@github.com:a/b.git', now: NOW })
  io.store.set(storeKey('/r/.git'), ['[gate] npm run build', '[gate] npm test'])
  // What the fake git, gh and npm answer; a test changes it as it goes.
  const state = { heads: [] as string[], head: SHA1, changed: 'src/a.ts\0', npm: 0, isMerged: false, fail: [] as string[], list: '[]' }
  const link = (path: string) => {
    const id = path.slice(path.lastIndexOf('/') + 1)
    io.files[`${path}/.git`] = `gitdir: /r/.git/worktrees/${id}\n`
    io.files[`/r/.git/worktrees/${id}/gitdir`] = `${path}/.git\n`
  }
  const ok = { exitCode: 0, stdout: '' }
  io.answer = argv => {
    const line = argv.join(' ')
    if (state.fail.some(start => line.startsWith(start))) return { exitCode: 1, stdout: '', stderr: 'it broke' }
    if (line.startsWith('gh issue view')) {
      const n = Number(argv[3])

      return { exitCode: 0, stdout: JSON.stringify({ number: n, title: `Item ${n}`, state: 'OPEN', body: 'Do it', author: { login: 'me' }, comments: [], url: `https://github.com/a/b/issues/${n}` }) }
    }
    if (line.startsWith('gh issue list')) return { exitCode: 0, stdout: state.list }
    if (line.startsWith('gh pr create')) return { exitCode: 0, stdout: 'https://github.com/a/b/pull/7\n' }
    if (line.startsWith('gh pr view')) {
      return { exitCode: 0, stdout: JSON.stringify({ number: 7, state: state.isMerged ? 'MERGED' : 'OPEN', isDraft: false, url: 'https://github.com/a/b/pull/7', statusCheckRollup: [] }) }
    }
    if (line.startsWith('git rev-parse --verify refs/heads/')) return { exitCode: 0, stdout: (state.heads.shift() ?? state.head) + '\n' }
    if (line.startsWith('git rev-parse --verify refs/remotes/')) return { exitCode: 0, stdout: BASE + '\n' }
    if (line.startsWith('git show')) return { exitCode: 0, stdout: settings }
    if (line.startsWith('git diff --name-only')) return { exitCode: 0, stdout: state.changed }
    if (line.startsWith('git diff --no-renames')) return { exitCode: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts\n+x' }
    if (line.startsWith('git worktree add') && argv.includes('-b')) link(argv[3] ?? '')
    if (line.startsWith('npm')) return { exitCode: state.npm, stdout: state.npm === 0 ? 'all good' : 'FAILED 2 tests' }
    if (line.startsWith('df ')) return { exitCode: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 900000000 1 500000000 1% /\n' }

    return argv[0] === 'git' || argv[0] === 'gh' ? ok : undefined
  }
  for (const job of opts.jobs ?? []) {
    io.files[`${DIR}/jobs/${job.id}/job.json`] = JSON.stringify(job)
    io.files[`${DIR}/worktrees/${job.id}/README.md`] = 'x'
    link(`${DIR}/worktrees/${job.id}`)
  }
  const started: { role: Role; description: string; agentId: string }[] = []
  const spawn: Spawn = async a => {
    const agentId = `a${started.length + 1}`
    started.push({ role: a.role, description: a.description, agentId })
    io.agentList.push({ id: agentId, status: 'running', type: `factory:${a.role}`, description: a.description })

    return { agentId }
  }

  return { io, state, started, spawn, queue: opts.queue ?? [] }
}
async function begin(w: World): Promise<void> {
  await takeLock(w.io, '/r', NOW)
  await writeRun(w.io, '/r', { version: 1, session: w.io.session, startedAt: NOW, queue: w.queue })
}
// The newest agent of a role ends its turn: its file is in `out/`, its answer is a fact.
async function ends(w: World, role: Role, line: string, focus = '', file: string | null = '## Summary\n- ok') {
  const agent = [...w.started].reverse().find(one => one.role === role && (focus === '' || one.description.includes(`:${focus} `)))
  if (agent === undefined) throw new Error(`no ${role} was started`)
  const jobId = agent.description.split(' ').at(-1) ?? ''
  if (file !== null) w.io.files[`${DIR}/jobs/${jobId}/out/${OUT_FILE[role](focus)}`] = file
  const listed = w.io.agentList.find(one => one.id === agent.agentId)
  if (listed) listed.status = 'completed'
  await dropFact(w.io, '/r', { kind: 'turn', agentId: agent.agentId, answer: line, ms: 60_000, usage: null, reason: 'answer', at: w.io.time })

  return advance(w.io, w.spawn)
}
const jobsOf = async (w: World) => (await readJobs(w.io, '/r')).jobs
const jobOf = async (w: World, item: string) => (await jobsOf(w)).find(job => job.itemId === item)
const lines = (w: World) => w.io.ran.filter(line => /^(git|gh|npm) /.test(line))
const inOrder = (all: string[], wanted: string[]) => {
  let at = -1
  for (const start of wanted) {
    const found = all.findIndex((line, i) => i > at && line.startsWith(start))
    if (found < 0) return `missing after line ${at}: ${start}`
    at = found
  }

  return 'ok'
}
const at = (item: string, stages: Stage[], over: Partial<Job> = {}): Job => ({
  ...stages.reduce((job, to) => move(job, to, 'ok', NOW, to === 'spec' ? { risk: 'low', surfaces: [], reviewers: ['code'] } : {}), newJob({ id: item, title: `Item ${item}` }, NOW)),
  branch: `factory/${newJob({ id: item, title: `Item ${item}` }, NOW).id}`,
  ...over,
})

test('one item goes from the queue to a ready pull request', async () => {
  const w = lineWorld({ queue: ['12'] })
  await begin(w)

  expect((await advance(w.io, w.spawn)).started).toBe(1)
  const id = (await jobOf(w, '12'))?.id ?? ''
  expect([(await jobOf(w, '12'))?.stage, w.started.map(one => one.role)]).toEqual(['intake', ['intake']])
  expect(w.io.files[`${DIR}/jobs/${id}/files/item.md`]).toContain('> Do it')

  await ends(w, 'intake', 'ACCEPT risk=low surfaces=none')
  expect([(await jobOf(w, '12'))?.stage, (await jobOf(w, '12'))?.reviewers]).toEqual(['spec', ['code']])
  await ends(w, 'spec', 'DONE')
  expect((await jobOf(w, '12'))?.stage).toBe('build')
  await ends(w, 'builder', 'DONE')
  // The plugin pushed, opened the draft, ran the fast gate, and started the reviewer.
  expect([(await jobOf(w, '12'))?.stage, (await jobOf(w, '12'))?.pr]).toEqual(['review', { number: 7, url: 'https://github.com/a/b/pull/7' }])
  expect(w.io.files[`${DIR}/jobs/${id}/files/round-1/diff.patch`]).toContain('+x')
  await ends(w, 'reviewer', 'OK', 'code')
  expect((await jobOf(w, '12'))?.stage).toBe('approve')
  w.state.head = SHA2 // the merge of the base made a new commit
  const last = await ends(w, 'approver', 'READY')

  expect(w.started.map(one => one.role)).toEqual(['intake', 'spec', 'builder', 'reviewer', 'approver'])
  expect(w.started.map(one => one.description)).toEqual([`factory intake ${id}`, `factory spec ${id}`, `factory builder ${id}`, `factory reviewer:code ${id}`, `factory approver ${id}`])
  const job = await jobOf(w, '12')
  expect([job?.stage, job?.round, job?.agentMs]).toEqual(['ready', 1, 300_000])
  expect(
    inOrder(lines(w), [
      'git fetch origin main',
      `git worktree add ${DIR}/worktrees/${id} -b factory/${id} refs/remotes/origin/main`,
      'gh issue edit 12 --add-label factory:in-progress',
      'gh issue comment 12',
      `git push origin ${SHA1}:refs/heads/factory/${id}`,
      `gh pr create --draft --head factory/${id} --base main --title 12: Item 12`,
      'gh issue comment 12',
      `git worktree add --detach ${DIR}/gate/${id} ${SHA1}`,
      'npm test',
      `git --git-dir=/r/.git/worktrees/${id} --work-tree=${DIR}/worktrees/${id} -c core.fsmonitor=false -c core.hooksPath=/dev/null merge --no-edit ${BASE}`,
      `git push origin ${SHA2}:refs/heads/factory/${id}`,
      `git worktree add --detach ${DIR}/gate/${id} ${SHA2}`,
      'npm run build',
      'gh pr ready 7',
      'gh issue comment 12',
      'gh issue edit 12 --add-label factory:needs-human',
    ]),
  ).toBe('ok')
  // The ready comment names the pull request.
  expect(w.io.stdins.some(text => text?.includes('https://github.com/a/b/pull/7') && text.includes('ready'))).toBe(true)
  // Nothing is left to do: the run ends and the lock is free.
  expect(last.isDone).toBe(true)
  expect(await readRun(w.io, '/r')).toBe(null)
  expect(w.io.toasts.at(-1)).toBe('The factory line finished: 1 ready, 0 need you, 0 rejected.')
})

test('a gate that fails sends the job back to Build as round 2, with the report in its files', async () => {
  const w = lineWorld({ jobs: [at('12', ['spec', 'build'])] })
  await begin(w)
  await advance(w.io, w.spawn)
  w.state.npm = 1
  await ends(w, 'builder', 'DONE')

  const job = await jobOf(w, '12')
  expect([job?.stage, job?.round, job?.sentBack]).toEqual(['build', 2, { by: 'gate', why: 'npm test failed' }])
  expect(w.io.files[`${DIR}/jobs/${job?.id}/files/round-1/checks.md`]).toContain('FAILED 2 tests')
  // The builder of round 2 is at work.
  expect([w.started.map(one => one.role), job?.work.length]).toEqual([['builder', 'builder'], 1])
})

test("a reviewer's CHANGES sends it back; then the gate and the reviewer run again", async () => {
  const w = lineWorld({ jobs: [at('12', ['spec', 'build', 'gate', 'review'])] })
  await begin(w)
  await advance(w.io, w.spawn)
  await ends(w, 'reviewer', 'CHANGES', 'code')
  expect([(await jobOf(w, '12'))?.stage, (await jobOf(w, '12'))?.round, (await jobOf(w, '12'))?.sentBack?.by]).toEqual(['build', 2, 'review'])
  w.state.head = SHA2
  await ends(w, 'builder', 'DONE')
  expect((await jobOf(w, '12'))?.stage).toBe('review')
  expect(w.started.map(one => one.role)).toEqual(['reviewer', 'builder', 'reviewer'])
  expect(lines(w).filter(line => line === 'npm test').length).toBe(1)
})

test('the last failed round asks the person: no agent starts, the item is told, a toast is given', async () => {
  const w = lineWorld({ jobs: [at('12', ['spec', 'build', 'gate'], { round: 3 })] })
  w.state.npm = 1
  await begin(w)
  await advance(w.io, w.spawn)

  const job = await jobOf(w, '12')
  expect([job?.stage, job?.question, job?.asker, job?.stoppedIn, job?.sentBack?.by]).toEqual(['needs-human', 'round limit: 3 rounds with no pass', 'limit', 'build', 'gate'])
  expect(w.started).toEqual([])
  expect(inOrder(lines(w), ['gh issue comment 12', 'gh issue edit 12 --add-label factory:needs-human'])).toBe('ok')
  expect(w.io.stdins).toContain('The factory needs a person: round limit: 3 rounds with no pass')
  expect([w.io.toasts.at(-2), w.io.sounds > 0]).toEqual(['Factory: 12 needs you.', true])
})

test('two slots: the third item waits in the queue until a job waits or ends', async () => {
  const w = lineWorld({ queue: ['1', '2', '3'] })
  await begin(w)
  await advance(w.io, w.spawn)
  expect([(await jobsOf(w)).map(job => job.itemId).sort(), (await readRun(w.io, '/r'))?.queue]).toEqual([['1', '2'], ['3']])
  // Item 1 is refused: its slot is free for item 3.
  w.started.pop()
  await ends(w, 'intake', 'REJECT: Not one piece of work.')
  expect([(await jobsOf(w)).map(job => job.itemId).sort(), (await readRun(w.io, '/r'))?.queue]).toEqual([['2', '3'], []])
  expect(inOrder(lines(w), ['gh issue comment 1 ', 'gh issue close 1 ', `git worktree remove --force ${DIR}/worktrees/1-item-1`])).toBe('ok')
  expect(w.io.stdins).toContain('The factory did not take this: Not one piece of work.')
})

test('a stopped line reads the turn that ended and starts no station', async () => {
  const w = lineWorld({ jobs: [at('12', ['spec'])] })
  await begin(w)
  await advance(w.io, w.spawn)
  await setStop(w.io, '/r', true)
  const result = await ends(w, 'spec', 'DONE')
  expect([(await jobOf(w, '12'))?.stage, w.started.map(one => one.role)]).toEqual(['build', ['spec']])
  // With no agent at work a stopped line is done.
  expect(result.isDone).toBe(true)
})

test('a tracker write that fails leaves the job in its stage, and the next call tries again', async () => {
  const w = lineWorld({ jobs: [at('12', ['spec', 'build', 'gate'], { round: 3 })] })
  w.state.npm = 1
  w.state.fail = ['gh issue comment']
  await begin(w)
  const first = await advance(w.io, w.spawn)
  expect([(await jobOf(w, '12'))?.stage, first.note]).toEqual(['gate', '12: the item could not be told (gh: it broke)'])
  w.state.fail = []
  await advance(w.io, w.spawn)
  expect((await jobOf(w, '12'))?.stage).toBe('needs-human')
})

test('a branch that moved after the gate is gated again, not reviewed', async () => {
  const w = lineWorld({ jobs: [at('12', ['spec', 'build'])] })
  await begin(w)
  await advance(w.io, w.spawn)
  // The push and the gate read the first commit; then the branch is at another one.
  w.state.heads = [SHA1, SHA1]
  w.state.head = SHA2
  await ends(w, 'builder', 'DONE')
  expect((await jobOf(w, '12'))?.stage).toBe('review')
  expect(lines(w).filter(line => line === 'npm test').length).toBe(2)
  expect(lines(w).filter(line => line.startsWith('git worktree add --detach')).map(line => line.split(' ').at(-1))).toEqual([SHA1, SHA2])
})

test('a merged pull request ends the job: done, the worktree removed, the job retired', async () => {
  const w = lineWorld({ jobs: [at('12', ['spec', 'build', 'gate', 'review', 'approve', 'ready'], { pr: { number: 7, url: 'u' } })] })
  await begin(w)
  await watch(w.io)
  expect((await jobOf(w, '12'))?.stage).toBe('ready')
  w.state.isMerged = true
  w.io.time += 301_000
  await watch(w.io)
  expect(await jobOf(w, '12')).toBe(undefined)
  expect(Object.keys(w.io.files).some(name => name.startsWith(`${DIR}/retired/12-item-12.`))).toBe(true)
  expect(inOrder(lines(w), ['gh pr view 7', 'gh issue edit 12 --remove-label', `git worktree remove --force ${DIR}/worktrees/12-item-12`])).toBe('ok')
  expect(w.started).toEqual([])
})

test('a second call while one is at work changes nothing; the one at work reads its fact', async () => {
  const w = lineWorld({ jobs: [at('12', ['spec'])] })
  await begin(w)
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const slow: Spawn = async a => {
    await held

    return w.spawn(a)
  }
  const first = advance(w.io, slow)
  // The first call is inside the spawn. A second one returns at once.
  for (let n = 0; n < 500; n++) await Promise.resolve()
  expect((await advance(w.io, w.spawn)).ran).toBe(false)
  expect(w.started).toEqual([])
  release()
  expect((await first).started).toBe(1)
})

test('the timer starts no agent: an agent that is gone makes its job ask', async () => {
  const gone = startWork(at('12', ['spec', 'build']), { agentId: 'gone', role: 'builder', focus: '', startedAt: NOW - 5000 }, NOW)
  const w = lineWorld({ jobs: [gone, at('13', ['spec'])] })
  await begin(w)
  await watch(w.io)

  const job = await jobOf(w, '12')
  expect([job?.stage, job?.question, job?.asker]).toEqual(['needs-human', 'The builder did not answer. /factory answer 12 starts it again.', 'station'])
  // Item 13 has a station to start. The timer leaves it for a hook.
  expect([(await jobOf(w, '13'))?.stage, (await jobOf(w, '13'))?.work, (await jobOf(w, '13'))?.results]).toEqual(['spec', [], []])
})

test('an answer the line cannot read starts the station once more, then asks', async () => {
  const w = lineWorld({ jobs: [at('12', ['spec'])] })
  await begin(w)
  await advance(w.io, w.spawn)
  await ends(w, 'spec', 'I think it is fine.')
  expect([w.started.map(one => one.role), (await jobOf(w, '12'))?.tries]).toEqual([['spec', 'spec'], 1])
  // The file of the first try is not taken for the second try's.
  expect(w.io.files[`${DIR}/jobs/12-item-12/out/spec.md`]).toBe(undefined)
  await ends(w, 'spec', 'DONE', '', null)
  const job = await jobOf(w, '12')
  expect([job?.stage, job?.question]).toEqual(['needs-human', 'The spec failed twice: wrote no file'])
})

test('the same command refused twice stops the job', async () => {
  const w = lineWorld({ jobs: [at('12', ['spec', 'build'])] })
  await begin(w)
  await advance(w.io, w.spawn)
  const agentId = w.started[0]?.agentId ?? ''
  await dropFact(w.io, '/r', { kind: 'refusal', agentId, command: 'git push origin main', at: NOW })
  await advance(w.io, w.spawn)
  expect([(await jobOf(w, '12'))?.stage, (await jobOf(w, '12'))?.refusals]).toEqual(['build', 1])
  await dropFact(w.io, '/r', { kind: 'refusal', agentId, command: 'git push origin main', at: NOW + 1 })
  await advance(w.io, w.spawn)
  const job = await jobOf(w, '12')
  expect([job?.stage, job?.question, job?.asker, job?.refusals]).toEqual(['needs-human', 'The fence refused the same command twice: git push origin main', 'fence', 2])
})

const ISSUES = JSON.stringify([
  { number: 4, title: 'Fonts', state: 'OPEN', labels: [{ name: 'factory' }] },
  { number: 5, title: 'Walls', state: 'OPEN', labels: [{ name: 'factory' }, { name: 'factory:needs-human' }] },
  { number: 6, title: 'Dark', state: 'OPEN', labels: [{ name: 'factory' }] },
])
const READY = { hasAgentTypes: true }

test('/factory run: what it needs before it starts', async () => {
  const noTracker = lineWorld({ settings: { tracker: undefined } })
  expect(await startRun(noTracker.io, noTracker.spawn, null, READY)).toBe('/factory run needs a GitHub tracker in the settings.')
  const noGate = lineWorld()
  noGate.io.store.set(storeKey('/r/.git'), [])
  expect(await startRun(noGate.io, noGate.spawn, null, READY)).toBe('No gate, no factory: gate commands are not approved. Approve them with /factory approve.')
  const empty = lineWorld({ settings: { gate: { fast: [], full: [] } } })
  expect(await startRun(empty.io, empty.spawn, null, READY)).toBe('No gate, no factory: no gate. Put the fast checks in gate.fast of the settings file on the base branch.')
  const noTypes = lineWorld()
  expect(await startRun(noTypes.io, noTypes.spawn, null, { hasAgentTypes: false })).toBe('The agent types of the line are not registered. Start a new session.')
  const taken = lineWorld()
  taken.io.files[`${DIR}/lock.1/holder`] = lockText('other', NOW - 1000, '/elsewhere')
  const busy = await startRun(taken.io, taken.spawn, null, READY)
  expect(busy.startsWith('Another session runs the line (')).toBe(true)
  expect(await startRun(taken.io, taken.spawn, '../x', READY)).toBe('Not an item id: /factory run [id]')
  for (const w of [noTracker, noGate, empty, noTypes, taken]) expect([w.started, await readRun(w.io, '/r')]).toEqual([[], null])
})

test('/factory run reads the queue once, keeps the lock, clears the stop flag and starts the first stations', async () => {
  const w = lineWorld()
  w.state.list = ISSUES
  await setStop(w.io, '/r', true)

  expect(await startRun(w.io, w.spawn, null, READY)).toBe('The line runs: 2 items in the queue, 0 jobs go on. /factory stop stops it.')
  expect(await isStopped(w.io, '/r')).toBe(false)
  expect((await lockInfo(w.io, '/r', NOW)).state).toBe('mine')
  // Two slots: both items are jobs in Intake, each with its agent.
  expect([(await jobsOf(w)).map(job => [job.itemId, job.stage]).sort(), w.started.map(one => one.role), (await readRun(w.io, '/r'))?.queue]).toEqual([
    [['4', 'intake'], ['6', 'intake']],
    ['intake', 'intake'],
    [],
  ])
})

test('/factory run <id> runs one item', async () => {
  const w = lineWorld()
  w.state.list = ISSUES
  expect(await startRun(w.io, w.spawn, '12', READY)).toBe('The line runs: 1 item in the queue, 0 jobs go on. /factory stop stops it.')
  expect((await jobsOf(w)).map(job => job.itemId)).toEqual(['12'])
  expect(w.io.ran.some(line => line.startsWith('gh issue list'))).toBe(false)
})

test('a new run goes on with the jobs of an earlier session: a station whose agent is gone starts again', async () => {
  const review = { ...at('12', ['spec', 'build', 'gate', 'review']), reviewers: ['code', 'security'] }
  const half = startWork({ ...review, results: [{ role: 'reviewer' as const, focus: 'code', answer: { kind: 'ok' as const }, why: null }] }, { agentId: 'old-agent', role: 'reviewer', focus: 'security', startedAt: NOW - 9000 }, NOW)
  const w = lineWorld({ jobs: [half] })
  expect(await startRun(w.io, w.spawn, null, READY)).toBe('The line runs: 0 items in the queue, 1 job goes on. /factory stop stops it.')
  const job = await jobOf(w, '12')
  // The answer that was kept stays; only the reviewer that was lost starts again.
  expect([job?.stage, job?.results.map(result => result.focus), job?.work.map(work => [work.focus, work.agentId])]).toEqual(['review', ['code'], [['security', 'a1']]])
  expect(w.started.map(one => one.description)).toEqual([`factory reviewer:security ${half.id}`])
})

test('/factory answer starts the station at once when the line runs, and says what to do when it does not', async () => {
  const asked = { ...at('12', ['spec']), stage: 'needs-human' as const, stoppedIn: 'spec' as const, question: 'The spec did not answer.', asker: 'station' as const }
  const idle = lineWorld({ jobs: [asked] })
  expect(await answerJob(idle.io, '12', '', idle.spawn)).toBe('12 goes on in spec. Run /factory run to go on.')
  expect(idle.started).toEqual([])

  const w = lineWorld({ jobs: [asked] })
  await begin(w)
  expect(await answerJob(w.io, '12', '', w.spawn)).toBe('12 goes on in spec.')
  expect([w.started.map(one => one.role), (await jobOf(w, '12'))?.work.length]).toEqual([['spec'], 1])
})

test("a reject also removes the gate's copy and the job's branch, so the item can run again", async () => {
  const job = startWork(at('12', ['spec', 'build']), { agentId: 'x1', role: 'builder', focus: '', startedAt: NOW }, NOW)
  const w = lineWorld({ jobs: [job] })
  w.io.files[`${DIR}/gate/${job.id}/README.md`] = 'x'
  expect(await rejectJob(w.io, '12', 'Not now.')).toBe('12 is rejected. The reason is on the item.')
  expect(inOrder(lines(w), [`git worktree remove --force ${DIR}/worktrees/${job.id}`, `git worktree remove --force ${DIR}/gate/${job.id}`, `git branch -D factory/${job.id}`])).toBe('ok')
  expect(await jobOf(w, '12')).toBe(undefined)
})
