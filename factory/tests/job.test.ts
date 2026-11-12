import { expect, test } from 'claude-code/testing'

import {
  IllegalMove,
  STAGES,
  TRANSITIONS,
  addSpend,
  clearWork,
  endWork,
  failStation,
  grant,
  isActive,
  isFinished,
  isWaiting,
  jobIdOf,
  move,
  newJob,
  noteRefusal,
  noteResult,
  parseJob,
  reject,
  resume,
  startWork,
  stop,
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

test('a file without the new fields still reads, with the defaults', async () => {
  const { branch, itemUrl, asker, refusals, feedback, ...old } = job()
  expect([branch, itemUrl, asker, refusals, feedback]).toEqual([null, null, null, 0, 0])
  const read = parseJob(JSON.stringify(old), old.id)
  expect([read?.branch, read?.itemUrl, read?.asker, read?.refusals, read?.feedback]).toEqual([null, null, null, 0, 0])
  const id = job().id
  expect(parseJob(JSON.stringify({ ...job(), refusals: -1 }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), feedback: 1.5 }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), asker: 'nobody' }), id)).toBe(null)
  // A job's branch is factory/<its own id>, nothing else.
  expect(parseJob(JSON.stringify({ ...job(), branch: 'main' }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), branch: 'factory/other-job' }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), branch: 'factory/' + id }), id)?.branch).toBe('factory/' + id)
  expect(parseJob(JSON.stringify({ ...job(), itemUrl: 'u'.repeat(900) }), id)?.itemUrl?.length).toBe(300)
})

test('a job can be rejected from any stage it is alive in', async () => {
  const paths: Stage[][] = [
    [],
    ['spec'],
    ['spec', 'build'],
    ['spec', 'build', 'gate'],
    ['spec', 'build', 'gate', 'review'],
    ['spec', 'build', 'gate', 'review', 'approve'],
    ['spec', 'build', 'gate', 'review', 'approve', 'ready'],
  ]
  for (const stages of paths) expect(reject(walk(stages), 'dropped', 5).stage).toBe('rejected')
  expect(reject(stop(job(), { question: 'q', asker: 'intake' }, 1), 'dropped', 2).stage).toBe('rejected')
  expect(() => reject(reject(job(), 'x', 1), 'again', 2)).toThrow(IllegalMove)
  expect(() => reject(walk(['spec', 'build', 'gate', 'review', 'approve', 'ready', 'done']), 'late', 2)).toThrow(IllegalMove)
})

test('a limit can stop a job in spec or build, and it goes back there', async () => {
  const stopped = stop(walk(['spec', 'build']), { question: 'cost limit for the day', asker: 'limit' }, 9)
  expect([stopped.stage, stopped.stoppedIn, stopped.asker, stopped.question]).toEqual([
    'needs-human',
    'build',
    'limit',
    'cost limit for the day',
  ])
  const back = resume(stopped, 'the person said go on', 10)
  expect([back.stage, back.round, back.asker, back.question, back.stoppedIn]).toEqual(['build', 1, null, null, null])
  expect(stop(walk(['spec']), { question: 'q', asker: 'limit' }, 9).stoppedIn).toBe('spec')
  expect(parseJob(JSON.stringify(stopped), stopped.id)).toEqual(stopped)
})

test('a job with no rounds left stops at the gate and resumes in build, as a new round', async () => {
  const failed = { ...walk(['spec', 'build', 'gate']), sentBack: { by: 'gate' as const, why: '2 tests failed' } }
  const stopped = stop(failed, { question: 'round limit: 3 rounds with no pass', asker: 'limit', resumeAt: 'build' }, 9)
  expect(stopped.stoppedIn).toBe('build')
  const back = resume(grant(stopped, { rounds: 1 }, 10), 'one more round', 11)
  expect([back.stage, back.round, back.granted.rounds, back.sentBack?.by]).toEqual(['build', 2, 1, 'gate'])
  expect(() => stop(failed, { question: 'q', asker: 'limit', resumeAt: 'ready' }, 9)).toThrow(IllegalMove)
})

test('a limit that stops a job in the middle of a round does not start a new round', async () => {
  const again = move(walk(['spec', 'build', 'gate']), 'build', 'checks failed', 5, { sentBack: { by: 'gate', why: 'x' } })
  expect(again.round).toBe(2)
  const stopped = stop(again, { question: 'cost limit for the job', asker: 'limit' }, 9)
  const back = resume(grant(stopped, { usd: 10 }, 10), 'the person said go on', 11)
  // Still round 2: the gate has not judged it again.
  expect([back.stage, back.round, back.sentBack?.by]).toEqual(['build', 2, 'gate'])
})

test('intake asks the author; resume goes back to intake', async () => {
  const asked = stop(job(), { question: 'Which font?', asker: 'intake' }, 2)
  expect([asked.stage, asked.stoppedIn, asked.asker]).toEqual(['needs-info', 'intake', 'intake'])
  expect(resume(asked, 'answered', 3).stage).toBe('intake')
  expect(() => resume(job(), 'x', 1)).toThrow(IllegalMove)
  expect(() => resume(walk(['spec', 'build', 'gate', 'review', 'approve', 'ready']), 'x', 1)).toThrow(IllegalMove)
  // Stopped at intake for its risk: a person lets it go on to spec.
  const risky = stop(job(), { question: 'Risk is medium. Build it?', asker: 'intake', resumeAt: 'spec' }, 2)
  expect([risky.stage, risky.stoppedIn]).toEqual(['needs-human', 'spec'])
})

test('grant adds and never goes below zero', async () => {
  const granted = grant(grant(job(), { rounds: 2, usd: 5 }, 1), { rounds: -5, minutes: 30 }, 2)
  expect(granted.granted).toEqual({ rounds: 0, usd: 5, minutes: 30 })
  expect([granted.updatedAt, granted.stage]).toEqual([2, 'intake'])
})

const WORK = { agentId: 'a1', role: 'builder' as const, focus: '', startedAt: 5 }

test('the stations a job has in flight', async () => {
  const one = startWork(walk(['spec', 'build']), WORK, 6)
  expect([one.work, one.updatedAt]).toEqual([[WORK], 6])
  const two = startWork(one, { ...WORK, agentId: 'a2', role: 'reviewer', focus: 'code' }, 7)
  expect(endWork(two, 'a1', 8).work.map(work => work.agentId)).toEqual(['a2'])
  expect(endWork(two, 'unknown', 8).work.length).toBe(2)
  expect(clearWork(two, 9).work).toEqual([])
  // A job has at most eight; the ninth is not added.
  const full = Array.from({ length: 9 }, (_, i) => i).reduce((j, i) => startWork(j, { ...WORK, agentId: `a${i}` }, 10), job())
  expect(full.work.length).toBe(8)
})

test('a station that failed is counted, and every move starts clean', async () => {
  const failed = failStation(startWork(walk(['spec']), WORK, 1), 2)
  expect([failed.tries, failed.work.length]).toEqual([1, 1])
  expect(move(failed, 'build', 'ok', 3)).toEqual(expect.objectContaining({ tries: 0, work: [] }))
  expect(stop(failed, { question: 'q', asker: 'station' }, 4)).toEqual(expect.objectContaining({ tries: 0, work: [], asker: 'station' }))
})

test('a refused command is counted, and the same one twice is seen', async () => {
  const once = noteRefusal(job(), 'git push origin main', 1)
  expect([once.isRepeat, once.job.refusals, once.job.refused]).toEqual([false, 1, ['git push origin main']])
  const twice = noteRefusal(once.job, 'git push origin main', 2)
  expect([twice.isRepeat, twice.job.refusals, twice.job.refused]).toEqual([true, 2, ['git push origin main']])
  expect(noteRefusal(once.job, 'git  push\torigin main\u001b[2J', 2).isRepeat).toBe(false)
  // The newest ten are kept, each cut to 200 characters.
  const many = Array.from({ length: 14 }, (_, i) => `c${i} ${'x'.repeat(300)}`).reduce((j, c) => noteRefusal(j, c, 3).job, job())
  expect([many.refusals, many.refused.length, many.refused[0]?.startsWith('c4 '), many.refused[9]?.length]).toEqual([14, 10, true, 200])
})

test('a job file without work, refused and tries reads with the defaults; a bad one is not a job', async () => {
  const { work, refused, tries, ...old } = job()
  expect([work, refused, tries]).toEqual([[], [], 0])
  const read = parseJob(JSON.stringify(old), old.id)
  expect([read?.work, read?.refused, read?.tries]).toEqual([[], [], 0])
  const id = job().id
  const withWork = startWork(noteRefusal(job(), 'x', 1).job, WORK, 2)
  expect(parseJob(JSON.stringify(withWork), id)).toEqual(withWork)
  expect(parseJob(JSON.stringify({ ...job(), work: [{ ...WORK, role: 'boss' }] }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), work: [{ ...WORK, agentId: '' }] }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), work: [{ ...WORK, focus: '../x' }] }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), work: Array.from({ length: 9 }, () => WORK) }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), refused: [5] }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), tries: -1 }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), asker: 'fence' }), id)?.asker).toBe('fence')
})

test('the answers of a station are kept on the job until it moves', async () => {
  const ok = { role: 'reviewer' as const, focus: 'code', answer: { kind: 'ok' as const }, why: null }
  const bad = { role: 'reviewer' as const, focus: 'ui', answer: null, why: 'wrote no file' }
  const two = noteResult(noteResult(walk(['spec', 'build', 'gate', 'review']), ok, 5), bad, 6)
  expect(two.results).toEqual([ok, bad])
  expect(parseJob(JSON.stringify(two), two.id)).toEqual(two)
  // A second answer of the same reviewer replaces the first.
  expect(noteResult(two, { ...bad, answer: { kind: 'changes' }, why: null }, 7).results.map(r => r.answer?.kind ?? null)).toEqual(['ok', 'changes'])
  expect(move(two, 'approve', 'ok', 8).results).toEqual([])
  expect(clearWork(startWork(two, WORK, 8), 9)).toEqual(expect.objectContaining({ work: [], results: [] }))
  const { results, ...old } = job()
  expect([results, parseJob(JSON.stringify(old), old.id)?.results]).toEqual([[], []])
  const id = job().id
  expect(parseJob(JSON.stringify({ ...job(), results: [{ ...ok, answer: { kind: 'maybe' } }] }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), results: [{ ...ok, role: 'boss' }] }), id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), results: Array.from({ length: 9 }, () => ok) }), id)).toBe(null)
  const accept = { role: 'intake' as const, focus: '', answer: { kind: 'accept' as const, risk: 'low' as const, surfaces: ['ui'] }, why: null }
  expect(parseJob(JSON.stringify(noteResult(job(), accept, 3)), id)?.results).toEqual([accept])
})
