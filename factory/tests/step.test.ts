import { expect, test } from 'claude-code/testing'

import type { Answer } from '../core/answer'
import { FACTORY_DEFAULTS as F } from '../core/factory-settings'
import type { Role } from '../core/factory-settings'
import { addSpend, move, newJob, noteResult, startWork } from '../core/job'
import type { Job, Stage } from '../core/job'
import { nextStep } from '../core/step'
import type { Facts } from '../core/step'

const NOW = 10 * 60_000
const base = newJob({ id: '12', title: 'Add dark mode' }, 1000)
const at = (stages: Stage[], from: Job = base): Job =>
  stages.reduce((job, to) => move(job, to, 'ok', 1, to === 'spec' ? { risk: 'low', surfaces: [], reviewers: ['code'] } : {}), from)
const facts = (over: Partial<Facts> = {}): Facts => ({ now: NOW, f: F, jobs: [], live: [], isStopped: false, gate: null, isRepeatRefusal: false, refused: '', ...over })
const said = (job: Job, role: Role, answer: Answer | null, focus = '', why: string | null = null) => noteResult(job, { role, focus, answer, why }, 2)
const working = (job: Job, role: Role, agentId = 'a1', focus = '', startedAt = NOW - 1000) => startWork(job, { agentId, role, focus, startedAt }, 2)
const PASS = { pass: true, why: null, needsPerson: false, sha: 'x' }
const FAIL = { pass: false, why: 'npm test failed', needsPerson: false, sha: 'x' }

test('a station with no agent yet starts its agent', async () => {
  expect(nextStep(base, facts())).toEqual({ do: 'spawn', agents: [{ role: 'intake', focus: '' }] })
  expect(nextStep(at(['spec']), facts())).toEqual({ do: 'spawn', agents: [{ role: 'spec', focus: '' }] })
  expect(nextStep(at(['spec', 'build']), facts())).toEqual({ do: 'spawn', agents: [{ role: 'builder', focus: '' }] })
  expect(nextStep(at(['spec', 'build', 'gate']), facts())).toEqual({ do: 'gate', which: 'fast' })
  expect(nextStep(at(['spec', 'build', 'gate', 'review', 'approve']), facts())).toEqual({ do: 'spawn', agents: [{ role: 'approver', focus: '' }] })
})

test('while its agent works, a job waits', async () => {
  expect(nextStep(working(base, 'intake'), facts({ live: ['a1'] }))).toEqual({ do: 'wait' })
  for (const stage of ['needs-info', 'needs-human', 'ready', 'done', 'rejected'] as const) {
    expect(nextStep({ ...base, stage }, facts())).toEqual({ do: 'wait' })
  }
})

test('an agent that is gone, or too slow, is a question at once: only a hook can start one again', async () => {
  const ask = { do: 'ask', question: 'The builder did not answer. /factory answer 12 starts it again.', asker: 'station' }
  const job = working(at(['spec', 'build']), 'builder')
  expect(nextStep(job, facts({ live: [] }))).toEqual(ask)
  const slow = working(at(['spec', 'build']), 'builder', 'a1', '', NOW - 31 * 60_000)
  expect(nextStep(slow, facts({ live: ['a1'] }))).toEqual(ask)
  expect(nextStep(slow, facts({ live: ['a1'], f: { ...F, stationTimeoutMin: 45 } }))).toEqual({ do: 'wait' })
  const review = working(at(['spec', 'build', 'gate', 'review']), 'reviewer', 'a2', 'code')
  expect(nextStep(review, facts())).toEqual({ ...ask, question: 'The reviewer (code) did not answer. /factory answer 12 starts it again.' })
})

test('an answer the line cannot read is one retry, then a question', async () => {
  const noAnswer = said(at(['spec']), 'spec', null, '', 'gave no answer the line can read')
  expect(nextStep(noAnswer, facts())).toEqual({ do: 'retry', why: 'gave no answer the line can read' })
  expect(nextStep({ ...noAnswer, tries: 1 }, facts())).toEqual({ do: 'ask', question: 'The spec failed twice: gave no answer the line can read', asker: 'station' })
  const noFile = said(at(['spec', 'build']), 'builder', { kind: 'done' }, '', 'wrote no file')
  expect(nextStep(noFile, facts())).toEqual({ do: 'retry', why: 'wrote no file' })
})

test('intake: accept, a risk above the limit, a question, a refusal', async () => {
  const accept = (risk: 'low' | 'high', surfaces: string[] = []) => said(base, 'intake', { kind: 'accept', risk, surfaces })
  expect(nextStep(accept('low', ['ui']), facts())).toEqual({
    do: 'move',
    to: 'spec',
    reason: 'accepted, risk low',
    set: { risk: 'low', surfaces: ['ui'], reviewers: ['code', 'ux', 'ui'] },
  })
  expect(nextStep(accept('high'), facts())).toEqual({
    do: 'ask',
    question: 'Risk high is above the limit (low).',
    asker: 'intake',
    resumeAt: 'spec',
    set: { risk: 'high', surfaces: [], reviewers: ['code'] },
  })
  expect(nextStep(said(base, 'intake', { kind: 'needs-info', question: 'Which font?' }), facts())).toEqual({ do: 'ask', question: 'Which font?', asker: 'intake' })
  expect(nextStep(said(base, 'intake', { kind: 'reject', reason: 'Three features.' }), facts())).toEqual({ do: 'move', to: 'rejected', reason: 'Three features.' })
})

test('spec and build move on; a stuck builder asks', async () => {
  expect(nextStep(said(at(['spec']), 'spec', { kind: 'done' }), facts())).toEqual({ do: 'move', to: 'build', reason: 'spec written' })
  expect(nextStep(said(at(['spec', 'build']), 'builder', { kind: 'done' }), facts())).toEqual({ do: 'move', to: 'gate', reason: 'built' })
  expect(nextStep(said(at(['spec', 'build']), 'builder', { kind: 'stuck', why: 'No database.' }), facts())).toEqual({
    do: 'ask',
    question: 'The builder is stuck: No database.',
    asker: 'station',
    resumeAt: 'build',
  })
})

test('the gate: a pass goes to review, a fail goes back, a protected path asks', async () => {
  const job = at(['spec', 'build', 'gate'])
  expect(nextStep(job, facts({ gate: PASS }))).toEqual({ do: 'move', to: 'review', reason: 'checks passed' })
  expect(nextStep(job, facts({ gate: FAIL }))).toEqual({ do: 'move', to: 'build', reason: 'checks failed', set: { sentBack: { by: 'gate', why: 'npm test failed' } } })
  expect(nextStep(job, facts({ gate: { pass: false, why: 'protected path: .github/x', needsPerson: true, sha: 'x' } }))).toEqual({
    do: 'ask',
    question: 'The gate needs you: protected path: .github/x',
    asker: 'gate',
    resumeAt: 'gate',
  })
})

test('the last round that fails asks the person, and says who sent it back', async () => {
  const third = { ...at(['spec', 'build', 'gate']), round: 3 }
  expect(nextStep(third, facts({ gate: FAIL }))).toEqual({
    do: 'ask',
    question: 'round limit: 3 rounds with no pass',
    asker: 'limit',
    resumeAt: 'build',
    set: { sentBack: { by: 'gate', why: 'npm test failed' } },
  })
  // One more round was granted.
  expect(nextStep({ ...third, granted: { rounds: 1, usd: 0, minutes: 0 } }, facts({ gate: FAIL })).do).toBe('move')
})

test('review: every routed reviewer starts together, and the job waits for all of them', async () => {
  const job = { ...at(['spec', 'build', 'gate', 'review']), reviewers: ['code', 'security'] }
  expect(nextStep(job, facts())).toEqual({ do: 'spawn', agents: [{ role: 'reviewer', focus: 'code' }, { role: 'reviewer', focus: 'security' }] })
  const one = working(said(job, 'reviewer', { kind: 'ok' }, 'code'), 'reviewer', 'a2', 'security')
  expect(nextStep(one, facts({ live: ['a2'] }))).toEqual({ do: 'wait' })
  const both = said(said(job, 'reviewer', { kind: 'ok' }, 'code'), 'reviewer', { kind: 'ok' }, 'security')
  expect(nextStep(both, facts())).toEqual({ do: 'move', to: 'approve', reason: 'reviewers passed' })
  const changes = said(said(job, 'reviewer', { kind: 'changes' }, 'code'), 'reviewer', { kind: 'ok' }, 'security')
  expect(nextStep(changes, facts())).toEqual({ do: 'move', to: 'build', reason: 'changes asked', set: { sentBack: { by: 'review', why: '1 reviewer asked for changes' } } })
  expect(nextStep({ ...changes, round: 3 }, facts()).do).toBe('ask')
  // After a restart with one answer kept and no agent at work, only the missing reviewer starts.
  expect(nextStep(said(job, 'reviewer', { kind: 'ok' }, 'code'), facts())).toEqual({ do: 'spawn', agents: [{ role: 'reviewer', focus: 'security' }] })
  // A job with no reviewer goes on.
  expect(nextStep({ ...job, reviewers: [] }, facts())).toEqual({ do: 'move', to: 'approve', reason: 'no reviewer is routed' })
})

test('approve: a question, or the full checks and then ready', async () => {
  const job = at(['spec', 'build', 'gate', 'review', 'approve'])
  expect(nextStep(said(job, 'approver', { kind: 'ask', question: 'On by default?' }), facts())).toEqual({ do: 'ask', question: 'On by default?', asker: 'approve' })
  const ready = said(job, 'approver', { kind: 'ready' })
  expect(nextStep(ready, facts())).toEqual({ do: 'gate', which: 'full' })
  expect(nextStep(ready, facts({ gate: PASS }))).toEqual({ do: 'move', to: 'ready', reason: 'full checks passed' })
  expect(nextStep(ready, facts({ gate: FAIL }))).toEqual({ do: 'move', to: 'build', reason: 'full checks failed', set: { sentBack: { by: 'approve', why: 'npm test failed' } } })
  expect(nextStep(ready, facts({ gate: { ...FAIL, needsPerson: true } }))).toEqual({ do: 'ask', question: 'The gate needs you: npm test failed', asker: 'gate', resumeAt: 'approve' })
})

test('a limit asks before a station starts, and never while its agent works or after it answered', async () => {
  const spent = addSpend(at(['spec', 'build']), 'spec', 60_000, 11, NOW)
  expect(nextStep(spent, facts({ jobs: [spent] }))).toEqual({ do: 'ask', question: 'cost limit for the job', asker: 'limit' })
  expect(nextStep(working(spent, 'builder'), facts({ jobs: [spent], live: ['a1'] }))).toEqual({ do: 'wait' })
  expect(nextStep(said(spent, 'builder', { kind: 'done' }), facts({ jobs: [spent] })).do).toBe('move')
  const other = addSpend(at(['spec']), 'spec', 60_000, 49, NOW)
  const mine = addSpend(at(['spec', 'build']), 'spec', 60_000, 2, NOW)
  expect(nextStep(mine, facts({ jobs: [mine, { ...other, id: 'other' }] }))).toEqual({ do: 'ask', question: 'cost limit for the day', asker: 'limit' })
})

test('a stopped line starts nothing, and still reads what an agent answered', async () => {
  expect(nextStep(at(['spec']), facts({ isStopped: true }))).toEqual({ do: 'wait' })
  expect(nextStep(at(['spec', 'build', 'gate']), facts({ isStopped: true }))).toEqual({ do: 'wait' })
  expect(nextStep(said(at(['spec']), 'spec', { kind: 'done' }), facts({ isStopped: true }))).toEqual({ do: 'move', to: 'build', reason: 'spec written' })
  // The full checks merge, push and mark ready: not on a stopped line.
  const ready = said(at(['spec', 'build', 'gate', 'review', 'approve']), 'approver', { kind: 'ready' })
  expect(nextStep(ready, facts({ isStopped: true }))).toEqual({ do: 'wait' })
})

test('the same command refused twice stops the job', async () => {
  const job = working(at(['spec', 'build']), 'builder')
  expect(nextStep(job, facts({ live: ['a1'], isRepeatRefusal: true, refused: 'git push origin main' }))).toEqual({
    do: 'ask',
    question: 'The fence refused the same command twice: git push origin main',
    asker: 'fence',
  })
})
