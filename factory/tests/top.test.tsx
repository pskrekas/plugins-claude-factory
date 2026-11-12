import { expect, test } from 'claude-code/testing'

import { trustedTop } from '../core/top'
import { START, cmd, engine, paneText } from './kit'

test('the top of the working tree is trusted only when the session is inside it', async () => {
  expect(trustedTop('/r', '/r')).toBe('/r')
  expect(trustedTop('/r/packages/web', '/r')).toBe('/r')
  expect(trustedTop('/evil', '/victim')).toBe('/evil')
  expect(trustedTop('/r-other', '/r')).toBe('/r-other')
  expect(trustedTop('/r', '/r/sub')).toBe('/r')
  expect(trustedTop('/r', null)).toBe('/r')
  expect(trustedTop('/r', '')).toBe('/r')
  expect(trustedTop('/a/b', '/')).toBe('/a/b')
})

const CHECK = '{"checks":[{"name":"a","run":["x"]}], "owed": ".claude/owed.md"}'

test('a folder whose git config points at another repo does not read that repo', async ($, on) => {
  const world = engine(on, {
    files: {
      '/evil/readme': 'x',
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

test('a session started in a folder of the repo reads the repo top', async ($, on) => {
  const world = engine(on, {
    files: {
      '/r/packages/web/index.ts': 'x',
      '/r/.claude/factory.json': '{"owed": ".claude/owed.md"}',
      '/r/.claude/owed.md': '- [ ] a',
    },
  })
  world.root = '/r/packages/web'
  world.gitTop = '/r'
  await $.session.start(START)
  await $.command.run(cmd(''))

  expect(await paneText($, 60)).toContain('OWED BY YOU 1')
})
