import { expect, test } from 'claude-code/testing'

import { rowsOf } from '../core/layout'
import type { Row } from '../core/layout'
import { cutTo, displayWidth } from '../core/rows'
import { STATIONS, countsFor, countsOf, factoryRows, jobRows, lineRows } from '../core/line'
import type { FactoryView } from '../core/model'
import { FULL, VIEW } from './kit'

const textOf = (row: Row) => (row.cells ? row.cells.map(cell => cell.text).join(' ') : row.left)
// The width a row takes on screen: a wide character (CJK, emoji) takes two columns.
const widthOf = (row: Row) =>
  row.cells ? displayWidth(textOf(row)) : displayWidth(row.left) + (row.right ? 1 + displayWidth(row.right) : 0)
const EMPTY: FactoryView = {
  jobs: [],
  counts: [0, 0, 0, 0, 0, 0, 0, 0],
  running: 0,
  waiting: 0,
  moreRunning: 0,
  moreWaiting: 0,
  queue: null,
  slots: 2,
  today: { done: 0, minutes: 0, costUsd: null, firstRound: 0, finished: 0 },
  note: null,
  lock: 'free',
  holder: null,
  isStopped: false,
  claimed: [],
  plan: [],
}

test('the stations and their counts', async () => {
  expect(STATIONS).toEqual(['Queue', 'Intake', 'Spec', 'Build', 'Gate', 'Review', 'Approve', 'You'])
  expect(countsOf(VIEW)).toEqual([4, 0, 0, 1, 0, 1, 0, 2])
  expect(countsOf(EMPTY)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(countsFor(VIEW.jobs, 4)).toEqual([4, 0, 0, 1, 0, 1, 0, 2])
})

test('the wide line: stations, counts under them, the loops', async () => {
  const rows = lineRows(VIEW, 80)
  expect(rows.map(textOf)).toEqual([
    ' Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You',
    '   4        0        0        1       0        1          0        2',
    '                              ^       │        │',
    '                              ├─fail──┘        │',
    '                              └─── changes ────┘',
  ])
  expect(rows[0]?.tone).toBe('head')
  expect(rows[1]?.cells?.at(-1)).toEqual({ text: '       2', tone: 'bad' })
  // PROJ-13 is back at Build from the gate: the gate's loop is lit, the reviewers' is not.
  expect(rows.slice(2).map(row => row.tone)).toEqual(['warn', 'warn', 'dim'])
})

test('the loops light up only while a job is on them', async () => {
  const calm = { ...VIEW, jobs: VIEW.jobs.map(job => ({ ...job, sentBack: null })) }
  const none = { ...EMPTY, queue: 0, counts: [0, 0, 0, 0, 0, 0, 0, 0] }
  expect(lineRows(calm, 80).slice(2).map(row => row.tone)).toEqual(['dim', 'dim', 'dim'])
  const review = {
    ...VIEW,
    jobs: VIEW.jobs.map(job => (job.sentBack ? { ...job, sentBack: { by: 'review' as const, why: 'x' } } : job)),
  }
  expect(lineRows(review, 80).slice(2).map(row => row.tone)).toEqual(['warn', 'warn', 'warn'])
  expect(lineRows(none, 80)[1]?.cells?.at(-1)?.tone).toBe('dim')
})

test('the short line', async () => {
  expect(lineRows(VIEW, 40).map(textOf)).toEqual(['Q4 I0 S0 B1 G0 R1 A0 You2', '↺ gate'])
  expect(lineRows(VIEW, 40)[1]?.tone).toBe('warn')
  expect(lineRows({ ...VIEW, jobs: [], counts: [4, 0, 0, 0, 0, 0, 0, 0] }, 40).map(textOf)).toEqual([
    'Q4 I0 S0 B0 G0 R0 A0 You0',
  ])
  expect(lineRows(VIEW, 24).map(textOf)[0]).toBe('Q4 I0 S0 B1 G0 R1 A0 Y2')
  // Too narrow for every station: the empty ones go first, then the ones at
  // the start of the line. The count of jobs that wait for the person stays.
  const busy = { ...VIEW, counts: [12, 3, 4, 5, 6, 7, 8, 9] }
  expect(lineRows(busy, 24).map(textOf)[0]).toBe('Q12 I3 S4 B5 G6 R7 A8 Y9')
  expect(lineRows(busy, 20).map(textOf)[0]).toBe('I3 S4 B5 G6 R7 A8 Y9')
  expect(lineRows(busy, 8).map(textOf)[0]).toBe('R7 A8 Y9')
  expect(lineRows(busy, 6).map(textOf)[0]).toBe('A8 Y9')
  expect(lineRows(busy, 2).map(textOf)[0]).toBe('Y9')
  expect(lineRows({ ...VIEW, counts: [4, 0, 0, 1, 0, 1, 0, 2] }, 12).map(textOf)[0]).toBe('Q4 B1 R1 Y2')
})

test('a job row: one cell per station, then round, sender, time and cost', async () => {
  const rows = jobRows(VIEW.jobs[1]!, 80)
  expect(rows[0]?.cells?.map(cell => cell.text.trim())).toEqual(['PROJ-13', 'done', 'done', 'now', 'fail', '-', '-'])
  expect(rows[0]?.cells?.map(cell => cell.tone)).toEqual(['plain', 'good', 'good', 'head', 'warn', 'dim', 'dim'])
  expect(rows[1]?.left).toBe('↺ round 2 of 3 · gate sent it back: 2 tests failed · 14 m · $3.40')

  const first = jobRows(VIEW.jobs[0]!, 80)
  expect(first[0]?.cells?.map(cell => cell.text.trim())).toEqual(['PROJ-12', 'done', 'done', 'done', 'done', 'now', '-'])
  expect(first[1]?.left).toBe('round 1 of 3 · 9 m · $2.10')
  expect(jobRows({ ...VIEW.jobs[0]!, costUsd: null }, 80)[1]?.left).toBe('round 1 of 3 · 9 m · cost unknown')
})

test('a job row when the reviewers sent it back, and when it waits', async () => {
  const changes = { ...VIEW.jobs[1]!, sentBack: { by: 'review' as const, why: 'code: one gap' } }
  expect(jobRows(changes, 80)[0]?.cells?.map(cell => cell.text.trim())).toEqual([
    'PROJ-13', 'done', 'done', 'now', '-', 'changes', '-',
  ])
  const waits = { ...VIEW.jobs[2]!, stage: 'needs-human' as const, stoppedIn: 'review' as const }
  expect(jobRows(waits, 80)[0]?.cells?.map(cell => cell.text.trim())).toEqual([
    'PROJ-14', 'done', 'done', 'done', 'done', 'you', '-',
  ])
})

test('narrow job rows use short words, then one plain row', async () => {
  expect(jobRows(VIEW.jobs[1]!, 50)[0]?.cells?.map(cell => cell.text.trim())).toEqual([
    'PROJ-13', 'ok', 'ok', 'now', 'fail', '-', '-',
  ])
  const narrow = jobRows(VIEW.jobs[1]!, 30)
  expect(narrow[0]?.cells).toBe(undefined)
  expect([narrow[0]?.left, narrow[0]?.right]).toEqual(['PROJ-13', 'build'])
})

test('the whole section, in order', async () => {
  const rows = factoryRows(VIEW, 80)
  const text = rows.map(row => (row.cells ? textOf(row) : row.left + '|' + row.right))
  const at = (line: string) => text.indexOf(line)
  expect(text[0]).toBe('FACTORY|2 of 2 slots busy')
  expect(at(' Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You|')).toBe(1)
  expect(at('NEEDS YOU (2)|')).toBeGreaterThan(at('round 1 of 3 · 9 m · $2.10|'))
  expect(at('PROJ-14  Which default font?|')).toBe(at('NEEDS YOU (2)|') + 1)
  expect(at('PROJ-10  PR 51 is ready. You merge.|')).toBe(at('NEEDS YOU (2)|') + 2)
  expect(at('QUEUE  4 items with the mark|')).toBe(at('NEEDS YOU (2)|') + 3)
  expect(at('TODAY  3 done · 41 m · $9.80 · 2 of 3 passed in round 1|')).toBe(text.length - 1)
  // A waiting job has no row of cells.
  expect(text.some(line => line.startsWith('PROJ-14 ') && !line.includes('Which'))).toBe(false)
})

test('small cases of the section', async () => {
  expect(factoryRows(EMPTY, 80)).toEqual([])
  const queued = factoryRows({ ...EMPTY, queue: 1 }, 80).map(row => row.left)
  expect(queued).toContain('QUEUE  1 item with the mark')
  expect(queued).not.toContain('NEEDS YOU (0)')
  const noted = factoryRows({ ...EMPTY, note: '2 job files skipped' }, 80).map(row => row.left)
  expect(noted.at(-1)).toBe('2 job files skipped')
  // A queue of nothing and no job: the section takes no room.
  expect(factoryRows({ ...EMPTY, queue: 0 }, 80)).toEqual([])
  const unpriced = { ...EMPTY, today: { done: 0, minutes: 5, costUsd: null, firstRound: 0, finished: 1 } }
  expect(factoryRows(unpriced, 80).at(-1)?.left).toBe('TODAY  0 done · 5 m · cost unknown')
})

test('no row of the section is wider than the pane, at 24 to 120 columns', async () => {
  for (let columns = 24; columns <= 120; columns++) {
    for (const row of factoryRows(VIEW, columns)) expect(widthOf(row)).toBeLessThanOrEqual(columns)
  }
})

test('hostile text in a job is cleaned and cut', async () => {
  const bad = '\u001b[2J' + 'x'.repeat(5000) + '‮'
  const view = {
    ...VIEW,
    jobs: VIEW.jobs.map(job => ({
      ...job,
      itemId: 'P\u001bROJ',
      title: bad,
      question: job.question === null ? null : bad,
      sentBack: job.sentBack === null ? null : { ...job.sentBack, why: bad },
    })),
  }
  for (const columns of [24, 40, 60, 80]) {
    for (const row of factoryRows(view, columns)) {
      expect(widthOf(row)).toBeLessThanOrEqual(columns)
      expect(/[\p{Cc}\p{Cf}]/u.test(textOf(row) + row.right)).toBe(false)
    }
  }
})

test('the section sits after TASK in the pane', async () => {
  const heads = rowsOf({ ...FULL, factory: VIEW }, 80, 5000)
    .filter(row => row.tone === 'head' && !row.cells)
    .map(row => row.left)
  expect(heads.slice(0, 3)).toEqual(['TASK', 'FACTORY', ' Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You'])
  expect(rowsOf(FULL, 80, 5000).map(row => row.left)).not.toContain('FACTORY')
})

test('the job cells have a header row', async () => {
  const text = factoryRows(VIEW, 80).map(textOf)
  const header = text.findIndex(line => line.trim().startsWith('INTAKE'))
  expect(text[header]).toBe('          INTAKE  SPEC    BUILD   GATE    REVIEW  APPROVE')
  expect(text[header + 1]?.startsWith('PROJ-12 ')).toBe(true)
  // Each word starts where its column of cells starts.
  const cells = factoryRows(VIEW, 80)[header + 1]?.cells ?? []
  expect(text[header + 1]?.indexOf('now')).toBe(text[header]?.indexOf('REVIEW'))
  expect(cells.length).toBe(7)
  expect(factoryRows(VIEW, 50).map(textOf)).toContain('          INT  SPEC BLD  GATE REV  APR ')
  expect(factoryRows(VIEW, 30).map(textOf).some(line => line.includes('INT'))).toBe(false)
  expect(factoryRows({ ...VIEW, jobs: VIEW.jobs.slice(2), running: 0 }, 80).map(textOf).some(line => line.includes('INTAKE'))).toBe(false)
})

test('a long item id keeps its end', async () => {
  const row = jobRows({ ...VIEW.jobs[0]!, itemId: 'PLATFORM-1234' }, 80)[0]
  expect(row?.cells?.[0]?.text).toBe('…ORM-1234')
})

test('with more jobs than the view holds, the counts are of all jobs', async () => {
  const many = {
    ...VIEW,
    counts: [4, 0, 0, 8, 0, 0, 0, 22],
    running: 8,
    waiting: 22,
    moreRunning: 6,
    moreWaiting: 20,
  }
  const text = factoryRows(many, 80).map(row => (row.cells ? textOf(row) : row.left + '|' + row.right))
  expect(text[0]).toBe('FACTORY|8 of 2 slots busy')
  expect(text).toContain('NEEDS YOU (22)|')
  expect(lineRows(many, 80)[1]?.cells?.at(-1)?.text.trim()).toBe('22')
  // Each "more" line sits under the list it cuts.
  expect(text.indexOf('+ 6 more running|')).toBe(text.indexOf('NEEDS YOU (22)|') - 1)
  expect(text.indexOf('+ 20 more wait|')).toBe(text.indexOf('PROJ-10  PR 51 is ready. You merge.|') + 1)
})

test('the head row says who runs the line, and that it is stopped', async () => {
  const head = (over: Partial<FactoryView>) => {
    const row = factoryRows({ ...VIEW, ...over }, 80)[0]

    return `${row?.left}|${row?.right}`
  }
  expect(head({ lock: 'mine' })).toBe('FACTORY|2 of 2 slots busy')
  expect(head({ lock: 'theirs', holder: '/somewhere/else' })).toBe('FACTORY|another session runs the line')
  expect(head({ lock: 'free' })).toBe('FACTORY|no session runs the line')
  // With no job at a station nobody needs to run the line.
  expect(head({ lock: 'free', running: 0, jobs: VIEW.jobs.slice(2) })).toBe('FACTORY|')
  expect(head({ lock: 'mine', isStopped: true })).toBe('FACTORY|2 of 2 slots busy · stopped')
  expect(head({ lock: 'theirs', isStopped: true })).toBe('FACTORY|another session runs the line · stopped')
  expect(head({ lock: 'free', running: 0, jobs: VIEW.jobs.slice(2), isStopped: true })).toBe('FACTORY|stopped')
})

test('an item the tracker says is claimed, with no job here, is a row under NEEDS YOU', async () => {
  const view = { ...VIEW, claimed: ['31', '32\u001b[2J'], waiting: 4, counts: [4, 0, 0, 1, 0, 1, 0, 4] }
  const text = factoryRows(view, 120).map(row => (row.cells ? textOf(row) : row.left))
  const at = text.indexOf('NEEDS YOU (4)')
  expect(at).toBeGreaterThan(0)
  expect(text.slice(at + 1, at + 5)).toEqual([
    'PROJ-14  Which default font?',
    'PROJ-10  PR 51 is ready. You merge.',
    '31  claimed in the tracker, no job here. /factory reject 31 <reason>, or run it again.',
    '32[2J  claimed in the tracker, no job here. /factory reject 32[2J <reason>, or run it again.',
  ])
  expect(lineRows(view, 80)[1]?.cells?.at(-1)?.text.trim()).toBe('4')
  // Only claimed items: the section still shows.
  const only = factoryRows({ ...EMPTY, claimed: ['31'], waiting: 1, counts: [0, 0, 0, 0, 0, 0, 0, 1] }, 120).map(row => row.left)
  expect(only[0]).toBe('FACTORY')
  expect(only).toContain('NEEDS YOU (1)')
})

test('the rows of a plan: what Intake said of each item, and how many would run', async () => {
  const plan = [
    { itemId: '4', verdict: 'accept' as const, risk: 'low' as const, note: '' },
    { itemId: '5', verdict: 'accept' as const, risk: 'high' as const, note: 'above the limit (low)' },
    { itemId: '6', verdict: 'needs-info' as const, risk: null, note: 'Which font?' },
    { itemId: '7', verdict: 'reject' as const, risk: null, note: 'Three features.\u001b[2J' },
    { itemId: '9', verdict: 'failed' as const, risk: null, note: 'The intake failed twice: wrote no file' },
  ]
  const text = factoryRows({ ...EMPTY, plan }, 120).map(row => row.left)
  expect(text[0]).toBe('FACTORY')
  expect(text.slice(text.indexOf('PLAN'))).toEqual([
    'PLAN',
    '4  accept · risk low',
    '5  accept · risk high · above the limit (low)',
    '6  asks: Which font?',
    '7  reject: Three features.[2J',
    '9  failed: The intake failed twice: wrote no file',
    '1 item would run now. /factory run starts the line.',
  ])
  // While an Intake still runs, the count is not said yet.
  const going = factoryRows({ ...EMPTY, plan: [...plan, { itemId: '8', verdict: 'running', risk: null, note: '' }] }, 120).map(row => row.left)
  expect(going.slice(-2)).toEqual(['9  failed: The intake failed twice: wrote no file', '8  Intake runs'])
  expect(factoryRows({ ...EMPTY, plan: [] }, 120)).toEqual([])
})

test('the width of text on screen', async () => {
  expect(displayWidth('abc')).toBe(3)
  expect(displayWidth('字字')).toBe(4)
  expect(displayWidth('a😀b')).toBe(4)
  expect(displayWidth('e\u0301')).toBe(1)
  expect(cutTo('abcdef', 4)).toBe('abc…')
  expect(cutTo('abc', 4)).toBe('abc')
  expect(cutTo('字字字字', 5)).toBe('字字…')
  expect(cutTo('a😀😀😀', 4)).toBe('a😀…')
  expect(cutTo('abc', 0)).toBe('')
  // A cut never leaves half of an emoji.
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cutTo('😀😀😀😀', 5))).toBe(false)
})

test('wide characters in a job do not push a row past the pane', async () => {
  const wide = '字'.repeat(200) + '😀'.repeat(50)
  const view = {
    ...VIEW,
    jobs: VIEW.jobs.map(job => ({
      ...job,
      itemId: '問題-12',
      question: job.question === null ? null : wide,
      sentBack: job.sentBack === null ? null : { ...job.sentBack, why: wide },
    })),
  }
  for (let columns = 24; columns <= 100; columns++) {
    for (const row of factoryRows(view, columns)) expect(widthOf(row)).toBeLessThanOrEqual(columns)
  }
})
