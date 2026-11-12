import { expect, test } from 'claude-code/testing'

import { ancestorsOf, confirmedTop } from '../core/top'
import { START, cmd, engine, paneText } from './kit'

test('a folder and the folders above it, nearest first', async () => {
  expect(ancestorsOf('/a/b/c')).toEqual(['/a/b/c', '/a/b', '/a', '/'])
  expect(ancestorsOf('/')).toEqual(['/'])
  expect(ancestorsOf('/a/')).toEqual(['/a', '/'])
  expect(ancestorsOf('relative/x')).toEqual(['relative/x'])
  expect(ancestorsOf('/' + 'd/'.repeat(100)).length).toBe(40)
})

test('a top is used only when the walk and git agree on it', async () => {
  expect(confirmedTop('/r/sub', '/r', '/r')).toBe('/r')
  expect(confirmedTop('/r', '/r', '/r')).toBe('/r')
  // Git names another folder: the folder's own git config is not believed.
  expect(confirmedTop('/evil', '/evil', '/victim')).toBe('/evil')
  expect(confirmedTop('/evil/sub', '/evil', '/victim')).toBe('/evil/sub')
  // Git refuses the repository (a `.git` another user owns), or is missing.
  expect(confirmedTop('/tmp/work', '/tmp', null)).toBe('/tmp/work')
  // No `.git` above the session.
  expect(confirmedTop('/notes', null, null)).toBe('/notes')
  expect(confirmedTop('/notes', null, '/elsewhere')).toBe('/notes')
})

const CHECK = '{"checks":[{"name":"a","run":["x"]}], "owed": ".claude/owed.md"}'

test('a folder whose git config points at another repo does not read that repo', async ($, on) => {
  const world = engine(on, {
    files: {
      '/evil/.git/config': '[core]\n\tworktree = /victim\n',
      '/victim/.git/HEAD': 'x',
      '/victim/.claude/factory.json': CHECK,
      '/victim/.claude/owed.md': '- [ ] a\n- [ ] b',
    },
  })
  world.root = '/evil'
  world.gitTop = '/victim'
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows).toContain('No settings file. Run /factory init.')
  expect(rows.some(row => row.includes('OWED') || row.includes('SETTINGS NOT APPROVED'))).toBe(false)
  expect(world.reads.some(path => path.startsWith('/victim'))).toBe(false)
})

test('a folder whose git config points at a folder above it does not read that folder', async ($, on) => {
  const world = engine(on, {
    files: {
      '/home/me/downloads/evil/.git/config': '[core]\n\tworktree = /home/me\n',
      '/home/me/.claude/factory.json': CHECK,
      '/home/me/.claude/owed.md': '- [ ] a\n- [ ] b',
    },
  })
  world.root = '/home/me/downloads/evil'
  world.gitTop = '/home/me'
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows).toContain('No settings file. Run /factory init.')
  expect(world.reads.some(path => path.startsWith('/home/me/.claude'))).toBe(false)
})

test('a session started in a folder of the repo reads the repo top', async ($, on) => {
  const world = engine(on, {
    files: {
      '/r/.git/HEAD': 'x',
      '/r/packages/web/index.ts': 'x',
      '/r/.claude/factory.json': '{"owed": ".claude/owed.md"}',
      '/r/.claude/owed.md': '- [ ] a',
    },
  })
  world.root = '/r/packages/web'
  await $.session.start(START)
  await $.command.run(cmd(''))

  expect(await paneText($, 60)).toContain('OWED BY YOU 1')
})

test('outside any repository the session folder is the top', async ($, on) => {
  const world = engine(on, {
    files: { '/notes/today/.claude/factory.json': '{"owed": ".claude/owed.md"}', '/notes/today/.claude/owed.md': '- [ ] a' },
  })
  world.root = '/notes/today'
  await $.session.start(START)
  await $.command.run(cmd(''))

  expect(await paneText($, 60)).toContain('OWED BY YOU 1')
})

test('a .git that another user put in a shared folder is not used', async ($, on) => {
  const world = engine(on, {
    files: {
      '/tmp/.git/HEAD': 'x',
      '/tmp/.claude/factory.json': CHECK,
      '/tmp/.claude/owed.md': '- [ ] a',
      '/tmp/work/notes.md': 'x',
    },
  })
  world.root = '/tmp/work'
  world.gitRefuses = true
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows).toContain('No settings file. Run /factory init.')
  expect(world.reads.some(path => path.startsWith('/tmp/.claude'))).toBe(false)
})

test('the git call that asks where the repo starts never finds a program inside the repo', async ($, on) => {
  const world = engine(on, {
    files: { '/r/.git/HEAD': 'x', '/r/packages/web/index.ts': 'x' },
    // The session is in a subfolder; the repo's own tools are on the PATH.
    path: '/usr/bin:/r/node_modules/.bin:/r/packages/web/bin:.:/opt/x',
  })
  world.root = '/r/packages/web'
  await $.session.start(START)
  await $.command.run(cmd(''))

  expect(world.probePaths.length).toBeGreaterThan(0)
  expect(world.probePaths.every(path => path === '/usr/bin:/opt/x')).toBe(true)
  expect(world.paths.every(path => path === '/usr/bin:/opt/x')).toBe(true)
})
