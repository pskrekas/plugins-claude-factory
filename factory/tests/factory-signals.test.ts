import { expect, test } from 'claude-code/testing'

import { alertsFor } from '../core/alerts'
import { briefOf } from '../core/brief'
import { statusText } from '../core/layout'
import { FULL, VIEW } from './kit'

test('status text with jobs', async () => {
  expect(statusText({ ...FULL, factory: VIEW })).toBe(
    'PROJ-12 · factory 2 run, 2 need you · 50% · 1 check wrong · blocked',
  )
  const running = { ...VIEW, jobs: VIEW.jobs.filter(job => job.stage === 'review'), running: 1, waiting: 0 }
  expect(statusText({ ...FULL, factory: running })).toBe('PROJ-12 · factory 1 run · 50% · 1 check wrong · blocked')
  const waiting = { ...VIEW, jobs: VIEW.jobs.filter(job => job.stage === 'ready'), running: 0, waiting: 1 }
  expect(statusText({ ...FULL, factory: waiting })).toBe(
    'PROJ-12 · factory 0 run, 1 needs you · 50% · 1 check wrong · blocked',
  )
  expect(statusText({ ...FULL, factory: { ...VIEW, jobs: [], running: 0, waiting: 0 } })).toBe(
    'PROJ-12 · 50% · 1 check wrong · blocked',
  )
  // The numbers are of all jobs, not only of those the view holds.
  expect(statusText({ ...FULL, factory: { ...VIEW, running: 8, waiting: 22 } })).toContain('factory 8 run, 22 need you')
  expect(statusText({ ...FULL, task: null, progress: [], checks: [], factory: running })).toBe('factory 1 run')
})

const before = {
  ...FULL,
  factory: { ...VIEW, jobs: VIEW.jobs.map(job => ({ ...job, stage: 'review' as const, question: null })) },
}
const after = { ...FULL, factory: VIEW }
const BOTH = ['PROJ-14 needs you: Which default font?', 'PROJ-10: PR 51 is ready. You merge.']

test('a job that starts to wait alerts once', async () => {
  expect(alertsFor(before, after)).toEqual(BOTH)
  expect(alertsFor(after, after)).toEqual([])
  expect(alertsFor({ ...before, readAt: null }, after)).toEqual([])
})

test('a job that is new in the view and already waits alerts too', async () => {
  expect(alertsFor({ ...FULL, factory: { ...VIEW, jobs: [] } }, after)).toEqual(BOTH)
  expect(alertsFor({ ...FULL, factory: null }, after)).toEqual(BOTH)
})

test('a job alert is clean and short', async () => {
  const noisy = {
    ...FULL,
    factory: {
      ...VIEW,
      jobs: VIEW.jobs.map(job => (job.question ? { ...job, question: 'q\u001b[2J' + 'x'.repeat(900) } : job)),
    },
  }
  const [alert] = alertsFor(before, noisy)
  expect(alert?.startsWith('PROJ-14 needs you: q[2Jxxx')).toBe(true)
  expect(alert?.length).toBeLessThanOrEqual(160)
})

test('the brief counts the waiting jobs and holds no job text', async () => {
  const brief = briefOf({ ...FULL, factory: VIEW }) ?? ''
  expect(brief).toContain('Factory: 2 jobs wait for the user.')
  expect(brief).not.toContain('Which default font')
  expect(brief).not.toContain('PROJ-14')
  expect(briefOf({ ...FULL, factory: { ...VIEW, jobs: [], waiting: 0 } })).not.toContain('Factory:')
  const one = { ...VIEW, jobs: VIEW.jobs.filter(job => job.stage === 'ready'), waiting: 1 }
  expect(briefOf({ ...FULL, factory: one })).toContain('Factory: 1 job waits for the user.')
})
