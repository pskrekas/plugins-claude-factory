import { expect, test } from 'claude-code/testing'

import { OUT_FILE } from '../core/agents'
import { storeKey } from '../core/consent'
import type { Role } from '../core/factory-settings'
import { move, newJob, startWork } from '../core/job'
import type { Job, Stage } from '../core/job'
import { stateFolderOf } from '../core/state-path'
import type { Spawn } from '../hooks/agent-events'
import { dropFact } from '../hooks/inbox'
import { readJobs, setStop, takeLock, writeJob } from '../hooks/jobs'
import { advance, watch } from '../hooks/line'
import { readRun, writeRun } from '../hooks/run'
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
  const state = { heads: [] as string[], head: SHA1, changed: 'src/a.ts\0', npm: 0, isMerged: false, fail: [] as string[] }
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
