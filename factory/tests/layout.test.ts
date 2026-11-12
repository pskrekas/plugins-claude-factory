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
    'SETTINGS NOT APPROVED · 1 command',
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

test('a right side as wide as the pane is cut to half, and the name stays', async () => {
  expect(fit('cloud account', 'other.person@example.com', 24)).toEqual({
    left: 'cloud acco…',
    right: 'other.perso…',
  })
  const model = {
    ...FULL,
    checks: [{ name: 'cloud account', state: 'wrong' as const, got: 'other.person@example.com' }],
  }
  for (let columns = 8; columns <= 60; columns++) {
    for (const r of rowsOf(model, columns, 5000)) {
      expect(r.left.length + (r.right ? 1 + r.right.length : 0)).toBeLessThanOrEqual(columns)
      if (r.right !== '' && columns >= 12) expect(r.left.length).toBeGreaterThan(0)
    }
  }
})

test('progress files that are not listed are counted', async () => {
  const text = rowsOf({ ...FULL, progressMore: 2 }, 60, 5000).map(r => r.left)
  expect(text[text.indexOf('BLOCKED: disk is full') + 1]).toBe('+ 2 more')
  expect(rowsOf(FULL, 60, 5000).map(r => r.left)).not.toContain('+ 0 more')
})

test('status text', async () => {
  expect(statusText(FULL)).toBe('PROJ-12 · 50% · 1 check wrong · blocked')
  expect(statusText(emptyModel())).toBe(undefined)
})

test('a long pending command is wrapped over rows, never cut', async () => {
  const command = 'sh -c ' + 'x'.repeat(100)
  const rows = rowsOf({ ...FULL, consent: 'needed', pendingCommands: [command] }, 40, 0)
  const end = rows.findIndex(r => r.left.startsWith('Run /factory approve'))
  const shown = rows.slice(1, end)
  expect(shown.map(r => r.left).join('')).toBe(command)
  expect(shown.every(r => r.left.length <= 40 && !r.left.includes('…'))).toBe(true)
})

test('control characters never reach a row', async () => {
  const model = {
    ...FULL,
    task: { ...FULL.task!, title: 'a\u001b[31mb\nc', state: 'o\rpen' },
    checks: [{ name: 'n\u0007ame', state: 'wrong' as const, got: '\u009b2Jgot' }],
    notes: ['no\u0000te\u007f'],
    settingsError: 'bad\u001b]0;x\u0007',
  }
  const text = rowsOf(model, 80, 0)
    .map(r => r.left + r.right)
    .join('')
  expect(/[\u0000-\u001f\u007f-\u009f]/.test(text)).toBe(false)
  expect(text).toContain('PROJ-12 a[31mbc')
  expect(text).toContain('2Jgot')
})

test('bidi, zero-width and line-separator characters never reach a row', async () => {
  const model = { ...FULL, task: { ...FULL.task!, title: 'ab‮cd​ e﻿⁦f' } }
  const text = rowsOf(model, 80, 0)
    .map(r => r.left)
    .join('|')
  expect(text).toContain('PROJ-12 abcdef')
})
