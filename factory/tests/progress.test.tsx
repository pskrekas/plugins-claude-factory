import { expect, test } from 'claude-code/testing'

import { matchGlob, nameOf, parseOwed, parseProgress } from '../core/progress'
import { parseSettings } from '../core/settings'
import { START, cmd, engine, paneText, settingsRuns } from './kit'

const P = { done: '- [x]', open: '- [ ]', blocked: 'BLOCKED' }

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

test('marks are plain text, not patterns, and nested boxes count', async () => {
  expect(parseProgress('  - [x] a\n- [ ] b\n.*', { done: '- [x]', open: '.*', blocked: 'BLOCKED' })).toEqual(
    { done: 1, open: 1, percent: 50, blocked: null },
  )
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

test('a glob with many stars is matched in no time', async () => {
  const name = 'a'.repeat(4000)
  const started = Date.now()
  expect(matchGlob('*a*a*a*a*a*a*a*a*a*a*a*a*b', [name])).toEqual([])
  expect(matchGlob('*a*a*a*a*a*a*a*a*a*a*a*a*b', [name + 'b'])).toEqual([name + 'b'])
  expect(Date.now() - started).toBeLessThan(200)
  expect(matchGlob('pre*mid*end', ['pre-mid-end', 'premidend', 'pre-end', 'xpre-mid-end'])).toEqual([
    'pre-mid-end',
    'premidend',
  ])
  expect(matchGlob('a*a', ['a', 'aa', 'aba'])).toEqual(['aa', 'aba'])
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
  expect(rows).toContain('SETTINGS NOT APPROVED · 1 command')
  expect(rows.find(row => /^Plan A\s+50%$/.test(row))).toBeDefined()
  expect(settingsRuns(world)).toEqual([])
})

test('a missing progress folder shows nothing and no error', async ($, on) => {
  engine(on, { files: { '/r/.claude/factory.json': SETTINGS } })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows).not.toContain('PROGRESS')
  expect(rows.some(row => row.includes('failed'))).toBe(false)
})

test('a progress file that is a link to a file outside the repo is not read', async ($, on) => {
  const world = engine(on, {
    files: {
      '/r/.claude/factory.json': SETTINGS,
      '/r/docs/a/progress.md': '',
      '/secret/key': '# SECRET\n- [x] a\nBLOCKED: token 123',
      '/r/.claude/owed.md': '',
      '/secret/owed': '- [ ] a\n- [ ] b',
    },
    links: { '/r/docs/a/progress.md': '/secret/key', '/r/.claude/owed.md': '/secret/owed' },
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows.some(row => row.includes('SECRET') || row.includes('token'))).toBe(false)
  expect(rows.some(row => row.includes('OWED'))).toBe(false)
  expect(world.reads.some(path => path.includes('secret'))).toBe(false)
})

test('a file over 1 MiB is skipped without reading it', async ($, on) => {
  const world = engine(on, {
    files: {
      '/r/.claude/factory.json': SETTINGS,
      '/r/docs/a/progress.md': '# Big\n' + '- [x] a\n'.repeat(140_000),
    },
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  expect((await paneText($)).some(row => row.startsWith('Big'))).toBe(false)
  expect(world.reads).not.toContain('/r/docs/a/progress.md')
})

test('a settings file that is a link to a file outside the repo is not used', async ($, on) => {
  const world = engine(on, {
    files: { '/r/.claude/factory.json': '', '/elsewhere/s.json': '{"checks":[{"name":"a","run":["x"]}]}' },
    links: { '/r/.claude/factory.json': '/elsewhere/s.json' },
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows).toContain('No settings file. Run /factory init.')
  expect(settingsRuns(world)).toEqual([])
})

test('the eight newest progress files show, and the rest are counted', async ($, on) => {
  const files: Record<string, string> = { '/r/.claude/factory.json': SETTINGS }
  const mtimes: Record<string, number> = {}
  for (let i = 1; i <= 10; i++) {
    const path = `/r/docs/2026-01-${String(i).padStart(2, '0')}/progress.md`
    files[path] = `# Plan ${i}\n- [x] a\n- [ ] b`
    mtimes[path] = i * 1000
  }
  engine(on, { files, mtimes })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($)
  const plans = rows.filter(row => row.startsWith('Plan ')).map(row => row.split(/\s+/)[1])
  expect(plans).toEqual(['10', '9', '8', '7', '6', '5', '4', '3'])
  expect(rows).toContain('+ 2 more')
})
