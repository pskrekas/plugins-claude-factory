import { expect, test } from 'claude-code/testing'

import { FACTORY_DEFAULTS as F } from '../core/factory-settings'
import { addSpend, newJob } from '../core/job'
import type { Job, Stage } from '../core/job'
import { canStart, freeSlots, isSameDay, limitOf, roundsLeft, todayOf } from '../core/limits'
import { routeOf } from '../core/route'

const NOON = new Date(2026, 0, 15, 12).getTime()
const DAY = 86_400_000
const job = (id: string, over: Partial<Job> = {}): Job => ({ ...newJob({ id, title: 't' }, NOON), ...over })
// A job that spent `minutes` and `usd` at `at`, then is in `stage`.
const spent = (id: string, minutes: number, usd: number | null, at = NOON, stage: Stage = 'build'): Job => ({
  ...addSpend(job(id), 'build', minutes * 60_000, usd, at),
  stage,
})

test('reviewers come from the risk and the surfaces, once each', async () => {
  expect(routeOf('low', [], F)).toEqual({ reviewers: ['code'], isOverRisk: false })
  expect(routeOf('medium', ['ui', 'security', 'ui', 'other'], F)).toEqual({
    reviewers: ['code', 'ux', 'ui', 'security'],
    isOverRisk: true,
  })
  expect(routeOf('high', [], { ...F, maxRisk: 'high' }).isOverRisk).toBe(false)
  expect(routeOf('high', [], { ...F, maxRisk: 'medium' }).isOverRisk).toBe(true)
  const same = { ...F, reviewers: { ...F.reviewers, low: ['code', 'ux'], ui: ['ux', 'ui'] } }
  expect(routeOf('low', ['ui'], same).reviewers).toEqual(['code', 'ux', 'ui'])
})

test('free slots', async () => {
  const jobs = [job('1'), job('2', { stage: 'ready' }), job('3', { stage: 'build' })]
  expect(freeSlots(jobs, F)).toBe(0)
  expect(freeSlots(jobs, { ...F, slots: 5 })).toBe(3)
  expect(freeSlots([job('1'), job('2'), job('3')], F)).toBe(0)
})

test('the same local day', async () => {
  expect(isSameDay(NOON, NOON + 3_600_000)).toBe(true)
  expect(isSameDay(NOON, NOON - DAY)).toBe(false)
})

test('a job may loop back to build while it has rounds left', async () => {
  // Three rounds: a job in round 3 that fails does not get a fourth.
  expect([1, 2, 3, 4].map(round => roundsLeft(job('1', { round }), F))).toEqual([2, 1, 0, 0])
  // The person grants one more round.
  const granted = job('1', { round: 3, granted: { rounds: 1, usd: 0, minutes: 0 } })
  expect(roundsLeft(granted, F)).toBe(1)
  expect(roundsLeft({ ...granted, round: 4 }, F)).toBe(0)
})

test('the cost limit of a job, and what the person granted on top', async () => {
  expect(limitOf(job('1'), [], F, NOON)).toBe(null)
  expect(limitOf(spent('1', 5, 10), [], F, NOON)).toBe(null)
  expect(limitOf(spent('1', 5, 10.5), [], F, NOON)).toBe('cost limit for the job')
  const more = { ...spent('1', 5, 10.5), granted: { rounds: 0, usd: 5, minutes: 0 } }
  expect(limitOf(more, [], F, NOON)).toBe(null)
})

test('the cost limit of the day counts what was spent today, by any job', async () => {
  const others = [spent('2', 1, 30), spent('3', 1, 25, NOON, 'done')]
  expect(limitOf(spent('1', 1, 1), others, F, NOON)).toBe('cost limit for the day')
  // Paid yesterday, merged today: yesterday's money is not today's.
  const paidYesterday = others.map(j => ({ ...j, updatedAt: NOON }))
  const old = [spent('2', 1, 30, NOON - DAY), spent('3', 1, 25, NOON - DAY)].map(j => ({ ...j, updatedAt: NOON }))
  expect(limitOf(spent('1', 1, 1), old, F, NOON)).toBe(null)
  expect(paidYesterday.length).toBe(2)
  // Spent today, not touched since midnight is impossible; spent today and still running counts.
  expect(limitOf(spent('1', 1, 1), [spent('2', 1, 49.5)], F, NOON)).toBe('cost limit for the day')
  // The job itself is in the list: it is counted once.
  const self = spent('1', 1, 30)
  const roomy = { ...F, costLimitUsd: { job: 100, day: 50 } }
  expect(limitOf(self, [self, spent('2', 1, 20)], roomy, NOON)).toBe(null)
  expect(limitOf(self, [self, spent('2', 1, 20.5)], roomy, NOON)).toBe('cost limit for the day')
})

test('a job with no price is held to the time limits instead', async () => {
  expect(limitOf(spent('1', 61, null), [], F, NOON)).toBe('time limit for the job')
  expect(limitOf(spent('1', 60, null), [], F, NOON)).toBe(null)
  expect(limitOf(spent('1', 61, 2), [], F, NOON)).toBe(null)
  // A price of zero for real work is no price.
  expect(limitOf(spent('1', 61, 0), [], F, NOON)).toBe('time limit for the job')
  expect(limitOf(job('1'), [spent('2', 200, null), spent('3', 50, null)], F, NOON)).toBe('time limit for the day')
  const granted = { ...spent('1', 61, null), granted: { rounds: 0, usd: 0, minutes: 30 } }
  expect(limitOf(granted, [], F, NOON)).toBe(null)
})

test('the disk guard', async () => {
  expect([canStart(14.9, F), canStart(15, F), canStart(null, F)]).toEqual([false, true, true])
})

test("today's totals and the score", async () => {
  const jobs = [
    spent('1', 8, 3.4, NOON, 'done'),
    { ...spent('2', 14, 2.1, NOON, 'ready'), round: 2 },
    spent('3', 1, 0.2, NOON, 'rejected'),
    spent('4', 30, 9, NOON - DAY, 'done'),
    spent('5', 0, 1, NOON, 'build'),
    // Worked yesterday, merged today: it ended today, and cost nothing today.
    { ...spent('6', 20, 4, NOON - DAY, 'done'), updatedAt: NOON },
  ]
  expect(todayOf(jobs, NOON)).toEqual({ done: 3, minutes: 23, costUsd: 6.7, firstRound: 2, finished: 4 })
  expect(todayOf([spent('1', 5, null, NOON, 'done')], NOON).costUsd).toBe(null)
  expect(todayOf([], NOON)).toEqual({ done: 0, minutes: 0, costUsd: null, firstRound: 0, finished: 0 })
})
