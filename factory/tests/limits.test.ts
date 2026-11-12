import { expect, test } from 'claude-code/testing'

import { FACTORY_DEFAULTS as F } from '../core/factory-settings'
import { newJob } from '../core/job'
import type { Job } from '../core/job'
import { canStart, freeSlots, isSameDay, limitOf, todayOf } from '../core/limits'
import { routeOf } from '../core/route'

const NOON = new Date(2026, 0, 15, 12).getTime()
const DAY = 86_400_000
const job = (id: string, over: Partial<Job> = {}): Job => ({ ...newJob({ id, title: 't' }, NOON), ...over })

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

test('the first limit a job has reached', async () => {
  expect(limitOf(job('1'), [], F, NOON)).toBe(null)
  expect(limitOf(job('1', { round: 4 }), [], F, NOON)).toBe('round limit')
  expect(limitOf(job('1', { round: 3 }), [], F, NOON)).toBe(null)
  expect(limitOf(job('1', { costUsd: 10.5 }), [], F, NOON)).toBe('cost limit for the job')
  const others = [job('2', { costUsd: 30 }), job('3', { costUsd: 25 })]
  expect(limitOf(job('1', { costUsd: 1 }), others, F, NOON)).toBe('cost limit for the day')
  const yesterday = others.map(j => ({ ...j, updatedAt: NOON - DAY }))
  expect(limitOf(job('1', { costUsd: 1 }), yesterday, F, NOON)).toBe(null)
  expect(limitOf(job('1', { agentMs: 61 * 60_000 }), [], F, NOON)).toBe('time limit for the job')
  expect(limitOf(job('1', { agentMs: 61 * 60_000, costUsd: 2 }), [], F, NOON)).toBe(null)
  const slow = [job('2', { agentMs: 200 * 60_000 }), job('3', { agentMs: 50 * 60_000 })]
  expect(limitOf(job('1'), slow, F, NOON)).toBe('time limit for the day')
})

test('the disk guard', async () => {
  expect([canStart(14.9, F), canStart(15, F), canStart(null, F)]).toEqual([false, true, true])
})

test("today's totals and the score", async () => {
  const jobs = [
    job('1', { stage: 'done', agentMs: 8 * 60_000, costUsd: 3.4 }),
    job('2', { stage: 'ready', round: 2, agentMs: 14 * 60_000, costUsd: 2.1 }),
    job('3', { stage: 'rejected', agentMs: 60_000, costUsd: 0.2 }),
    job('4', { stage: 'done', updatedAt: NOON - DAY, costUsd: 9 }),
    job('5', { stage: 'build', costUsd: 1 }),
  ]
  expect(todayOf(jobs, NOON)).toEqual({ done: 2, minutes: 23, costUsd: 6.7, firstRound: 1, finished: 3 })
  expect(todayOf([job('1', { stage: 'done' })], NOON).costUsd).toBe(null)
  expect(todayOf([], NOON)).toEqual({ done: 0, minutes: 0, costUsd: null, firstRound: 0, finished: 0 })
})
