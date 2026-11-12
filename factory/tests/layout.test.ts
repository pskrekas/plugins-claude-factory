import { expect, test } from 'claude-code/testing'

import { fit, rowsOf, statusText } from '../core/layout'
import { emptyModel } from '../core/model'
import { FULL } from './kit'

test('an empty model draws only the no-settings line', async () => {
  expect(rowsOf(emptyModel(), 60, 0).map(r => r.left)).toEqual([
    'No settings file. Run /factory init.',
  ])
})

test('every section appears, in order, with its rows', async () => {
  const rows = rowsOf(FULL, 60, 5000)
  expect(rows.filter(r => r.tone === 'head').map(r => r.left)).toEqual([
    'TASK',
    'PROGRESS',
    'CHECKS',
    'PORTS',
    'MORE',
  ])
  const text = rows.map(r => r.left + '|' + r.right)
  expect(text).toContain('PROJ-12 Add dark mode|open')
  expect(text).toContain('PR 51 · build green · 1 approval|ok')
  expect(text).toContain('Plan A|50%')
  expect(text).toContain('BLOCKED: disk is full|')
  expect(text).toContain('cloud account|other@example.com')
  expect(text).toContain('database :5432|DOWN')
  expect(text).toContain('WORKTREES 2 · 1 merged, remove?|')
  expect(text).toContain('OWED BY YOU 3|')
  expect(text[text.length - 1]).toBe('read 4 s ago|')
})

test('a task with no item shows its branch', async () => {
  const task = { id: null, branch: 'feat/x', title: null, state: null, pr: null, note: null }
  const text = rowsOf({ ...FULL, task }, 60, 5000).map(r => r.left + '|' + r.right)
  expect(text).toContain('feat/x|')
})

test('running agents are listed with their minutes, six at most', async () => {
  const agents = Array.from({ length: 8 }, (_, i) => ({
    id: 'a' + i,
    label: 'agent ' + i,
    kind: 'builder',
    isRunning: true,
    startedAt: 5000 - 120_000,
  }))
  const text = rowsOf({ ...FULL, agents }, 60, 5000).map(r => r.left + '|' + r.right)
  expect(text).toContain('agent 0 builder|2 m')
  expect(text).toContain('+ 2 more|')
  expect(text.filter(t => t.startsWith('agent ')).length).toBe(6)
})

test('needed consent lists the commands and hides the repo sections', async () => {
  const rows = rowsOf({ ...FULL, consent: 'needed', pendingCommands: ['npm test'] }, 60, 0).map(
    r => r.left,
  )
  expect(rows.slice(0, 3)).toEqual([
    'SETTINGS NOT APPROVED',
    'npm test',
    'Run /factory approve to allow these commands.',
  ])
  expect(rows).not.toContain('CHECKS')
  expect(rows).not.toContain('PORTS')
  // The task and the progress files run no repo command: they stay.
  expect(rows).toContain('TASK')
  expect(rows).toContain('PROGRESS')
})

test('a settings error is one line', async () => {
  const text = rowsOf({ ...FULL, settingsError: 'not valid JSON' }, 60, 0).map(r => r.left)
  expect(text).toContain('settings: not valid JSON')
})

test('no row is wider than the pane, at 24 to 120 columns', async () => {
  for (let columns = 24; columns <= 120; columns++) {
    for (const r of rowsOf(FULL, columns, 5000)) {
      const width = r.left.length + (r.right ? 1 + r.right.length : 0)
      expect(width).toBeLessThanOrEqual(columns)
    }
  }
})

test('fit cuts the left side with an ellipsis', async () => {
  expect(fit('abcdefghij', 'ok', 8)).toEqual({ left: 'abcd…', right: 'ok' })
  expect(fit('abc', 'ok', 8)).toEqual({ left: 'abc', right: 'ok' })
})

test('status text', async () => {
  expect(statusText(FULL)).toBe('PROJ-12 · 50% · 1 check wrong · blocked')
  expect(statusText(emptyModel())).toBe(undefined)
})
