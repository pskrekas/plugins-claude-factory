import { expect, test } from 'claude-code/testing'

import {
  IllegalMove,
  STAGES,
  TRANSITIONS,
  addSpend,
  isActive,
  isFinished,
  isWaiting,
  jobIdOf,
  move,
  newJob,
  parseJob,
} from '../core/job'
import type { Stage } from '../core/job'

const job = () => newJob({ id: 'PROJ-12', title: 'Add dark mode!' }, 1000)
const walk = (stages: Stage[]) => stages.reduce((j, to) => move(j, to, 'ok', 1), job())

test('a new job', async () => {
  const j = job()
  expect(j.id).toBe('proj-12-add-dark-mode')
  expect([j.stage, j.round, j.itemId, j.createdAt, j.costUsd, j.agentMs]).toEqual([
    'intake',
    1,
    'PROJ-12',
    1000,
    null,
    0,
  ])
  expect([j.version, j.granted, j.spend, j.stageMs]).toEqual([1, { rounds: 0, usd: 0, minutes: 0 }, [], {}])
  expect(j.history).toEqual([{ at: 1000, from: null, to: 'intake', reason: 'started' }])
})

test('job ids are short, plain and never empty', async () => {
  expect(jobIdOf('12', 'Add dark mode')).toBe('12-add-dark-mode')
  expect(jobIdOf('#7', '  Ünïcode & symbols!!  ')).toBe('7-n-code-symbols')
  expect(jobIdOf('!!', '??')).toBe('job')
  expect(jobIdOf('PROJ-1', 'x'.repeat(200)).length).toBeLessThanOrEqual(60)
  expect(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(jobIdOf('PROJ-1', 'a b - c -'))).toBe(true)
  expect(jobIdOf('../../etc', 'passwd')).toBe('etc-passwd')
})

test('the happy path, one round', async () => {
  const j = walk(['spec', 'build', 'gate', 'review', 'approve', 'ready', 'done'])
  expect([j.stage, j.round, j.history.length]).toEqual(['done', 1, 8])
  expect(isFinished(j)).toBe(true)
})

test('a loop back to build is a new round and says who sent it back', async () => {
  const atGate = walk(['spec', 'build', 'gate'])
  const back = move(atGate, 'build', 'gate failed', 4, { sentBack: { by: 'gate', why: '2 tests failed' } })
  expect([back.stage, back.round, back.sentBack]).toEqual(['build', 2, { by: 'gate', why: '2 tests failed' }])
  // A loop with no reason is refused.
  expect(() => move(move(back, 'gate', 'ok', 5), 'build', 'again', 6)).toThrow(IllegalMove)
  // The first build of a job is not a loop.
  expect(walk(['spec', 'build']).round).toBe(1)
})

test('illegal moves throw and change nothing', async () => {
  const j = job()
  expect(() => move(j, 'review', 'skip', 1)).toThrow(IllegalMove)
  expect(() => move(move(j, 'rejected', 'no', 1), 'spec', 'back', 2)).toThrow(IllegalMove)
  expect(j.stage).toBe('intake')
  expect(j.history.length).toBe(1)
})

test('a job that waits goes back only where it stopped', async () => {
  expect(() => move(job(), 'needs-info', 'a question', 1)).toThrow(IllegalMove)
  expect(() => move(job(), 'needs-info', 'a question', 1, { question: undefined })).toThrow(IllegalMove)
  const info = move(job(), 'needs-info', 'a question', 1, { question: 'Which font?' })
  expect([info.stoppedIn, info.question, isWaiting(info)]).toEqual(['intake', 'Which font?', true])
  expect(() => move(info, 'spec', 'x', 2)).toThrow(IllegalMove)
  const back = move(info, 'intake', 'answered', 2)
  expect([back.stage, back.stoppedIn, back.question]).toEqual(['intake', null, null])

  // Stopped at intake because the risk is too high: the person lets it go on to spec.
  const risky = move(job(), 'needs-human', 'risk medium', 1, { question: 'Risk is medium. Build it?' })
  expect(risky.stoppedIn).toBe('spec')
  expect(move(risky, 'spec', 'approved', 2).stage).toBe('spec')

  const stuck = move(walk(['spec', 'build', 'gate', 'review']), 'needs-human', 'round limit', 2, {
    question: '3 rounds with no pass.',
  })
  expect(stuck.stoppedIn).toBe('review')
  expect(move(stuck, 'rejected', 'dropped', 3).stage).toBe('rejected')
  expect(isWaiting(walk(['spec', 'build', 'gate', 'review', 'approve', 'ready']))).toBe(true)
})

test('every stage is in the table and the table names only stages', async () => {
  for (const stage of STAGES) for (const to of TRANSITIONS[stage]) expect(STAGES).toContain(to)
  expect(Object.keys(TRANSITIONS).sort()).toEqual([...STAGES].sort())
  expect(isActive(job())).toBe(true)
  expect(isActive(walk(['rejected']))).toBe(false)
})

test('a job file is checked field by field', async () => {
  const folder = 'proj-12-add-dark-mode'
  const good = JSON.stringify(job())
  expect(parseJob(good, folder)).toEqual(job())
  expect(parseJob(good, 'other-folder')).toBe(null)
  expect(parseJob('', folder)).toBe(null)
  expect(parseJob('{ half', folder)).toBe(null)
  expect(parseJob('[]', folder)).toBe(null)
  const bad = [
    { stage: 'nonsense' },
    { round: 0 },
    { agentMs: -1 },
    { history: 'x' },
    { costUsd: 'free' },
    { createdAt: null },
    { surfaces: [1] },
    { sentBack: { by: 'nobody', why: 'x' } },
    { pr: { number: 'x', url: 'u' } },
    { stoppedIn: 'nowhere' },
    // A stage a job can only wait in must say where it goes back to, and only
    // to a stage the table allows; a job that does not wait must not say one.
    { stage: 'needs-human', stoppedIn: 'ready', question: 'q' },
    { stage: 'needs-human', stoppedIn: 'build', question: 'q' },
    { stage: 'needs-info', stoppedIn: null, question: 'q' },
    { stage: 'needs-info', stoppedIn: 'intake', question: null },
    { stage: 'review', stoppedIn: 'review' },
    { version: 2 },
    { granted: { rounds: -1, usd: 0, minutes: 0 } },
    { spend: [{ day: 'today', ms: 1, usd: 1 }] },
    { stageMs: { nonsense: 5 } },
    { pr: { number: 1.5, url: 'u' } },
  ]
  for (const change of bad) expect(parseJob(JSON.stringify({ ...job(), ...change }), folder)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), id: '../etc' }), '../etc')).toBe(null)
})

test('long text in a job file is cut', async () => {
  const text = JSON.stringify({
    ...job(),
    title: 't'.repeat(5000),
    question: 'q'.repeat(5000),
    sentBack: { by: 'gate', why: 'w'.repeat(5000) },
    history: Array.from({ length: 300 }, (_, i) => ({ at: i, from: null, to: 'intake', reason: 'r'.repeat(900) })),
  })
  const long = parseJob(text, 'proj-12-add-dark-mode')
  expect([long?.title.length, long?.question?.length, long?.sentBack?.why.length]).toEqual([200, 500, 300])
  expect([long?.history.length, long?.history[0]?.at, long?.history[0]?.reason.length]).toEqual([100, 200, 200])
})

test('text that a move sets is cut, and an unset field is left as it is', async () => {
  const asked = move(job(), 'needs-info', 'r', 1, { question: 'q'.repeat(300_000) })
  expect(asked.question?.length).toBe(500)
  const atGate = walk(['spec', 'build', 'gate'])
  const back = move(atGate, 'build', 'r', 2, { sentBack: { by: 'gate', why: 'w'.repeat(5000) }, risk: undefined })
  expect(back.sentBack?.why.length).toBe(300)
  expect(back.risk).toBe(null)
  expect(parseJob(JSON.stringify(asked), asked.id)).toEqual(asked)
  expect(parseJob(JSON.stringify(back), back.id)).toEqual(back)
})

test('spend is added per day and per station, and one unpriced piece makes the job unpriced', async () => {
  const day1 = new Date(2026, 0, 15, 23, 50).getTime()
  const day2 = new Date(2026, 0, 16, 0, 10).getTime()
  let j = addSpend(job(), 'intake', 60_000, 0.5, day1)
  j = addSpend(j, 'spec', 120_000, 1.25, day1)
  j = addSpend(j, 'spec', 30_000, 0.25, day2)
  expect([j.agentMs, j.costUsd, j.updatedAt]).toEqual([210_000, 2, day2])
  expect(j.spend).toEqual([
    { day: '2026-01-15', ms: 180_000, usd: 1.75 },
    { day: '2026-01-16', ms: 30_000, usd: 0.25 },
  ])
  expect(j.stageMs).toEqual({ intake: 60_000, spec: 150_000 })
  const unpriced = addSpend(j, 'build', 1000, null, day2)
  expect([unpriced.costUsd, unpriced.spend[1]]).toEqual([null, { day: '2026-01-16', ms: 31_000, usd: null }])
  expect(addSpend(unpriced, 'build', 1000, 3, day2).costUsd).toBe(null)
  expect(parseJob(JSON.stringify(unpriced), unpriced.id)).toEqual(unpriced)
})
