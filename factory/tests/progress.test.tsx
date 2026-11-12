import { expect, test } from 'claude-code/testing'

import { matchGlob, nameOf, parseOwed, parseProgress } from '../core/progress'
import { parseSettings } from '../core/settings'
import { START, cmd, engine, paneText } from './kit'

const P = { done: '^- \\[x\\]', open: '^- \\[ \\]', blocked: 'BLOCKED' }

test('checkboxes give a percent', async () => {
  expect(parseProgress('- [x] a\n- [x] b\n- [ ] c\ntext', P)).toEqual({
    done: 2,
    open: 1,
    percent: 67,
    blocked: null,
  })
})

test('no boxes give no percent', async () => {
  expect(parseProgress('hello', P).percent).toBe(null)
})

test('the last blocked line is kept, cleaned', async () => {
  expect(parseProgress('- [ ] a\n## BLOCKED: disk is full\n', P).blocked).toBe('disk is full')
  expect(parseProgress('BLOCKED: one\n- Task 2: BLOCKED after step 1 - two\n', P).blocked).toBe(
    'Task 2: BLOCKED after step 1 - two',
  )
  expect(parseProgress('BLOCKED: ' + 'x'.repeat(200), P).blocked?.length).toBe(80)
})

test('a later resume clears the block', async () => {
  expect(parseProgress('BLOCKED: x\nRESUMED 12:00\n', P).blocked).toBe(null)
  expect(parseProgress('BLOCKED: x\nUNBLOCKED\n- [ ] a', P).blocked).toBe(null)
})

test('owed counts open boxes', async () => {
  expect(parseOwed('- [ ] a\n- [x] b\n  - [ ] c')).toEqual({ open: 2 })
})

test('name comes from the heading, else the folder', async () => {
  expect(nameOf('# Plan A\n', 'docs/plans/a/progress.md')).toBe('Plan A')
  expect(nameOf('no heading', 'docs/plans/a/progress.md')).toBe('a')
  expect(nameOf('no heading', 'progress.md')).toBe('progress.md')
})

test('glob matches one segment', async () => {
  expect(
    matchGlob('docs/*/progress.md', ['docs/a/progress.md', 'docs/a/b/progress.md', 'docs/x.md']),
  ).toEqual(['docs/a/progress.md'])
  expect(matchGlob('docs/*.md', ['docs/x.md', 'docs/y.txt', 'docsXx.md'])).toEqual(['docs/x.md'])
})

test('a path that leaves the repo is refused by the settings', async () => {
  for (const files of ['../x/*.md', '/etc/*', '~/notes/*.md', 'a/../../b.md', 'a\\\\b.md']) {
    const { settings, error } = parseSettings(JSON.stringify({ progress: { files } }))
    expect(settings.progress).toBe(null)
    expect(error).toBe('progress: path must be inside the repo')
  }
  expect(parseSettings('{"owed": "../owed.md"}')).toEqual({
    settings: parseSettings(null).settings,
    error: 'owed: path must be inside the repo',
  })
})

const SETTINGS = '{"progress": {"files": "docs/*/progress.md"}, "owed": ".claude/owed.md"}'

test('the pane shows progress files and the owed count', async ($, on) => {
  engine(on, {
    files: {
      '/r/.claude/factory.json': SETTINGS,
      '/r/docs/a/progress.md': '# Plan A\n- [x] a\n- [ ] b',
      '/r/docs/b/progress.md': '# Plan B\n- [x] a\nBLOCKED: no disk',
      '/r/docs/readme.md': '- [ ] not a progress file',
      '/r/.claude/owed.md': '- [ ] x',
    },
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows.find(row => /^Plan A\s+50%$/.test(row))).toBeDefined()
  expect(rows.find(row => /^Plan B\s+100%$/.test(row))).toBeDefined()
  expect(rows).toContain('BLOCKED: no disk')
  expect(rows.some(row => row.includes('not a progress file'))).toBe(false)
  expect(rows).toContain('OWED BY YOU 1')
})

test('progress shows while the settings wait for approval, and runs nothing', async ($, on) => {
  const world = engine(on, {
    files: {
      '/r/.claude/factory.json':
        '{"progress": {"files": "docs/*/progress.md"}, "checks": [{"name": "a", "run": ["x"]}]}',
      '/r/docs/a/progress.md': '# Plan A\n- [x] a\n- [ ] b',
    },
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows).toContain('SETTINGS NOT APPROVED')
  expect(rows.find(row => /^Plan A\s+50%$/.test(row))).toBeDefined()
  expect(world.ran).toEqual([])
})

test('a missing progress folder shows nothing and no error', async ($, on) => {
  engine(on, { files: { '/r/.claude/factory.json': SETTINGS } })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows).not.toContain('PROGRESS')
  expect(rows.some(row => row.includes('failed'))).toBe(false)
})
