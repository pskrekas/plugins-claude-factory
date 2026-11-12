import { expect, test } from 'claude-code/testing'

import { listIssues, parseGhIssueList } from '../adapters/github-issues'
import { FACTORY_DEFAULTS as F } from '../core/factory-settings'
import { addSpend, move, newJob } from '../core/job'
import type { Job } from '../core/job'
import { parseSettings } from '../core/settings'
import { viewOf } from '../hooks/readers/factory'
import { START, STATE, cmd, engine, paneText } from './kit'

const NOON = new Date(2026, 0, 15, 12).getTime()
const job = (id: string, over: Partial<Job> = {}): Job => ({ ...newJob({ id, title: 'A thing' }, NOON), ...over })
const file = (j: Job) => ({ [`${STATE}/jobs/${j.id}/job.json`]: JSON.stringify(j) })

const ISSUES = JSON.stringify([
  { number: 4, title: 'Fonts', state: 'OPEN', labels: [{ name: 'factory' }] },
  { number: 5, title: 'Walls', state: 'OPEN', labels: [{ name: 'factory' }, { name: 'factory:needs-human' }] },
  { number: 6, title: 'Dark', state: 'OPEN', labels: [{ name: 'factory' }, { name: 'bug' }] },
])

test('a list of issues from gh', async () => {
  expect(parseGhIssueList(ISSUES)).toEqual([
    { id: '4', title: 'Fonts', state: 'open', labels: ['factory'] },
    { id: '5', title: 'Walls', state: 'open', labels: ['factory', 'factory:needs-human'] },
    { id: '6', title: 'Dark', state: 'open', labels: ['factory', 'bug'] },
  ])
  expect(parseGhIssueList('not json')).toEqual([])
  expect(parseGhIssueList('{"number": 1}')).toEqual([])
  expect(parseGhIssueList('[{"number": "x"}, 5, null]')).toEqual([])
})

test('the queue leaves out the items the factory already has', async () => {
  const ran: string[] = []
  const run = async (argv: string[]) => {
    ran.push(argv.join(' '))

    return { exitCode: 0, stdout: ISSUES, stderr: '' }
  }
  expect((await listIssues(run, 'factory')).items).toEqual([
    { id: '4', title: 'Fonts', state: 'open' },
    { id: '6', title: 'Dark', state: 'open' },
  ])
  expect(ran).toEqual(['gh issue list --label factory --state open --limit 100 --json number,title,state,labels'])
  expect((await listIssues(async () => ({ failed: 'not-found' as const }), 'factory')).items).toBe(null)
})

test('a mark that could be read as an option is refused everywhere', async () => {
  const ran: string[] = []
  const run = async (argv: string[]) => {
    ran.push(argv.join(' '))

    return { exitCode: 0, stdout: '[]', stderr: '' }
  }
  for (const mark of ['--web', '-R x', '', 'a'.repeat(51), 'a\nb']) {
    expect((await listIssues(run, mark)).items).toBe(null)
    expect(parseSettings(JSON.stringify({ tracker: { kind: 'github', mark } })).error).toBe('tracker: wrong type')
  }
  expect(ran).toEqual([])
  expect(parseSettings('{"tracker": {"kind": "github", "mark": "factory:web"}}').error).toBe(null)
})

test('the view: running jobs, then waiting ones, twenty at most', async () => {
  const many = Array.from({ length: 25 }, (_, i) => job(String(i), { stage: 'build', updatedAt: NOON + i }))
  const waits = job('w', { stage: 'ready', pr: { number: 51, url: 'u' }, agentMs: 150_000 })
  const view = viewOf([waits, ...many], F, 3, null, NOON)
  expect(view?.jobs.length).toBe(20)
  expect([view?.running, view?.waiting, view?.moreRunning, view?.moreWaiting]).toEqual([25, 1, 6, 0])
  expect(view?.counts).toEqual([3, 0, 0, 25, 0, 0, 0, 1])
  expect(view?.jobs[0]?.itemId).toBe('24')
  // The job that waits is always in the view: it needs the person.
  expect(view?.jobs.at(-1)?.itemId).toBe('w')

  const waiting = Array.from({ length: 22 }, (_, i) => job('w' + i, { stage: 'ready', updatedAt: NOON + i }))
  const crowd = viewOf([...many.slice(0, 8), ...waiting], F, null, null, NOON)
  expect([crowd?.running, crowd?.waiting, crowd?.moreRunning, crowd?.moreWaiting]).toEqual([8, 22, 0, 10])
  expect(crowd?.counts.at(-1)).toBe(22)
  expect(view?.queue).toBe(3)
  expect(view?.slots).toBe(2)

  const small = viewOf([waits, job('a', { stage: 'review', round: 2 })], F, null, null, NOON)
  expect(small?.jobs.map(j => [j.itemId, j.stage, j.round, j.maxRounds, j.prNumber, j.minutes])).toEqual([
    ['a', 'review', 2, 3, null, 0],
    ['w', 'ready', 1, 3, 51, 3],
  ])
})

test('the view: finished jobs show only in the totals, and nothing gives no view', async () => {
  const done = { ...addSpend(job('d'), 'build', 60_000, 1, NOON), stage: 'done' as const }
  const view = viewOf([done], F, null, null, NOON)
  expect(view?.jobs).toEqual([])
  expect(view?.today).toEqual({ done: 1, minutes: 1, costUsd: 1, firstRound: 1, finished: 1 })
  expect(viewOf([], F, null, null, NOON)).toBe(null)
  expect(viewOf([], F, 0, null, NOON)?.queue).toBe(0)
  expect(viewOf([], F, null, '2 job files skipped', NOON)?.note).toBe('2 job files skipped')
})

test('the view: who runs the line, the stop flag, and claimed items with no job', async () => {
  const build = job('12', { itemId: '12', stage: 'build' })
  const line = { lock: 'theirs' as const, holder: '/somewhere/else', isStopped: true, claimed: ['12', '31', '32'] }
  const view = viewOf([build], F, 0, null, NOON, line)
  expect([view?.lock, view?.holder, view?.isStopped]).toEqual(['theirs', '/somewhere/else', true])
  // An item with a job here is not "claimed with no job".
  expect(view?.claimed).toEqual(['31', '32'])
  expect([view?.running, view?.waiting, view?.counts.at(-1)]).toEqual([1, 2, 2])
  const many = viewOf([], F, null, null, NOON, { ...line, claimed: Array.from({ length: 30 }, (_, i) => String(100 + i)) })
  expect([many?.claimed.length, many?.waiting]).toEqual([10, 10])
  // With nothing said about the line, nobody runs it.
  expect(viewOf([build], F, null, null, NOON)).toEqual(
    expect.objectContaining({ lock: 'free', holder: null, isStopped: false, claimed: [] }),
  )
  expect(viewOf([], F, null, null, NOON, { ...line, claimed: ['31'] })?.claimed).toEqual(['31'])
  expect(viewOf([], F, null, null, NOON, { ...line, claimed: [] })).toBe(null)
})

test('the view: a plan job is a row of the plan, never a job of the line', async () => {
  const done = { verdict: 'accept' as const, risk: 'low' as const, note: '' }
  const planned = addSpend(job('4', { itemId: '4', stage: 'rejected', plan: done }), 'intake', 120_000, null, NOON)
  const running = job('5', { itemId: '5', stage: 'intake', plan: { verdict: 'running', risk: null, note: '' } })
  const view = viewOf([planned, running, job('12', { itemId: '12', stage: 'build' })], F, null, null, NOON)
  expect(view?.plan).toEqual([{ itemId: '4', ...done }, { itemId: '5', verdict: 'running', risk: null, note: '' }])
  expect([view?.jobs.map(one => one.itemId), view?.running, view?.waiting, view?.counts]).toEqual([['12'], 1, 0, [0, 0, 0, 1, 0, 0, 0, 0]])
  // What the plan's agents spent is in the day's total.
  expect(view?.today.minutes).toBe(2)
  expect(viewOf([planned], F, null, null, NOON)?.plan.length).toBe(1)
})

const CLAIMED = JSON.stringify([
  { number: 4, title: 'Fonts', state: 'OPEN', labels: [{ name: 'factory' }] },
  { number: 31, title: 'Lost', state: 'OPEN', labels: [{ name: 'factory' }, { name: 'factory:in-progress' }] },
])
const claimedWorld = (on: Parameters<typeof engine>[0], files: Record<string, string>) =>
  engine(on, {
    files: { '/r/.claude/factory.json': '{"tracker": {"kind": "github"}}', ...files },
    run: argv => (argv[0] === 'gh' && argv[1] === 'issue' && argv[2] === 'list' ? { exitCode: 0, stdout: CLAIMED } : undefined),
    now: NOON,
  })

test('an issue that is in progress in the tracker with no job file shows as claimed', async ($, on) => {
  claimedWorld(on, {})
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 120)
  expect(rows).toContain('NEEDS YOU (1)')
  expect(rows).toContain('31  claimed in the tracker, no job here. /factory reject 31 <reason>, or run it again.')
})

test('the same issue with a job file is a job, not a claimed item', async ($, on) => {
  claimedWorld(on, file(job('31-lost', { itemId: '31', stage: 'build' })))
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 120)
  expect(rows.some(row => row.includes('claimed in the tracker'))).toBe(false)
  expect(rows.some(row => row.startsWith('NEEDS YOU'))).toBe(false)
  expect(rows).toContain('no session runs the line')
})

test('the pane says when the line is stopped and when this session runs it', async ($, on) => {
  const w = engine(on, { files: file(job('12', { stage: 'build' })), now: NOON })
  await $.session.start(START)
  await $.command.run(cmd('stop'))
  await $.command.run(cmd(''))
  expect(w.files[`${STATE}/stop`]).toBe('stop\n')
  expect(await paneText($, 120)).toContain('no session runs the line · stopped')
})

test('the pane draws the jobs on disk', async ($, on) => {
  const review = move(move(move(move(job('12'), 'spec', 'ok', NOON), 'build', 'ok', NOON), 'gate', 'ok', NOON), 'review', 'ok', NOON)
  const ready = job('10', { stage: 'ready', pr: { number: 51, url: 'u' } })
  engine(on, { files: { ...file(review), ...file(ready) }, now: NOON })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 80)
  expect(rows.some(row => row.startsWith('FACTORY'))).toBe(true)
  expect(rows).toContain(' Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You')
  expect(rows).toContain('NEEDS YOU (1)')
  expect(rows).toContain('10  PR 51 is ready. You merge.')
  expect(rows).toContain('round 1 of 3 · 0 m · cost unknown')
})

test('the queue is counted from the tracker', async ($, on) => {
  const world = engine(on, {
    files: { '/r/.claude/factory.json': '{"tracker": {"kind": "github"}}' },
    run: argv => (argv[0] === 'gh' && argv[1] === 'issue' && argv[2] === 'list' ? { exitCode: 0, stdout: ISSUES } : undefined),
    now: NOON,
  })
  await $.session.start(START)
  expect(world.ran.some(line => line.startsWith('gh issue list'))).toBe(false)

  await $.command.run(cmd(''))
  expect(await paneText($, 80)).toContain('QUEUE  2 items with the mark')
})

test('a bad job file is counted, and the good one shows', async ($, on) => {
  const good = job('7', { stage: 'build' })
  engine(on, { files: { ...file(good), [`${STATE}/jobs/8-broken/job.json`]: '{ half' }, now: NOON })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 80)
  expect(rows).toContain('1 job file skipped')
  expect(rows.some(row => row.startsWith('7 '))).toBe(true)
})

test('job files that a repo brings are not shown', async ($, on) => {
  const fake = job('99', { stage: 'ready', pr: { number: 1, url: 'u' } })
  engine(on, { files: { [`/r/.factory/jobs/${fake.id}/job.json`]: JSON.stringify(fake) }, now: NOON })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 80)
  expect(rows.some(row => row.startsWith('FACTORY') || row.includes('ready'))).toBe(false)
})

test('with no tracker and no jobs there is no FACTORY section', async ($, on) => {
  const world = engine(on, { files: {} })
  await $.session.start(START)
  await $.command.run(cmd(''))

  expect((await paneText($, 80)).some(row => row.startsWith('FACTORY'))).toBe(false)
  expect(world.ran.some(line => line.startsWith('gh issue list'))).toBe(false)
})
