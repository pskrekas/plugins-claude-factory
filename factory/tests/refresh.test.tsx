import { expect, test } from 'claude-code/testing'

import { START, cmd, engine, paneText, settingsRuns } from './kit'

const CHECK = '{"checks":[{"name":"a","run":["x"]}]}'

test('a settings file with a check asks for approval and runs nothing', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)

  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows).toContain('SETTINGS NOT APPROVED')
  expect(rows).toContain('x')
  expect(settingsRuns(world)).toEqual([])
})

test('approve allows the commands the panel showed', async ($, on) => {
  engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)

  await $.command.run(cmd(''))
  expect((await $.command.run(cmd('approve'))).text).toBe('Approved 1 command:\nx')
  expect(await paneText($)).not.toContain('SETTINGS NOT APPROVED')
})

test('approve before the commands were shown approves nothing', async ($, on) => {
  engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)

  expect((await $.command.run(cmd('approve'))).text).toBe(
    'Not approved yet. The settings file names 1 command:\nx\nRun /factory approve again to allow it.',
  )
  expect(await paneText($)).toContain('SETTINGS NOT APPROVED')
  expect((await $.command.run(cmd('approve'))).text).toBe('Approved 1 command:\nx')
})

test('a changed command asks again', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)

  await $.command.run(cmd(''))
  await $.command.run(cmd('approve'))
  world.files['/r/.claude/factory.json'] = '{"checks":[{"name":"a","run":["x","--force"]}]}'
  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows).toContain('SETTINGS NOT APPROVED')
  expect(rows).toContain('x --force')
})

test('a file that changes after it was shown is not approved by the old screen', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)

  await $.command.run(cmd(''))
  world.files['/r/.claude/factory.json'] = '{"checks":[{"name":"a","run":["y"]}]}'

  expect((await $.command.run(cmd('approve'))).text).toBe(
    'The settings file changed. It now names 1 command:\ny\nRun /factory approve again to allow it.',
  )
  expect(await paneText($)).toContain('SETTINGS NOT APPROVED')
})

test('approve with nothing to approve says so', async ($, on) => {
  engine(on, { files: {} })
  await $.session.start(START)

  expect((await $.command.run(cmd('approve'))).text).toBe('Nothing to approve.')
})

test('broken settings show one line and the pane still draws', async ($, on) => {
  engine(on, { files: { '/r/.claude/factory.json': '{ nope' } })
  await $.session.start(START)

  await $.command.run(cmd(''))

  expect(await paneText($)).toContain('settings: not valid JSON')
})

test('a read sets the time and the status line', async ($, on) => {
  const world = engine(on, { files: {}, now: 7000 })
  await $.session.start(START)

  await $.command.run(cmd(''))

  expect(await paneText($)).toContain('read 0 s ago')
  expect(world.status.length).toBeGreaterThan(0)
})

test('commands shown for one repo are never approved for another', async ($, on) => {
  const world = engine(on, {
    files: {
      '/r/.claude/factory.json': CHECK,
      '/other/.claude/factory.json': '{"checks":[{"name":"a","run":["evil"]}]}',
    },
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  // The session moves to another repo after the panel showed the first one's command.
  world.root = '/other'
  expect((await $.command.run(cmd('approve'))).text).toBe(
    'Not approved yet. The settings file names 1 command:\nevil\nRun /factory approve again to allow it.',
  )
  expect((await $.command.run(cmd('approve'))).text).toBe('Approved 1 command:\nevil')

  // The first repo's command was shown, but never approved.
  world.root = '/r'
  await $.command.run(cmd(''))
  expect(await paneText($)).toContain('SETTINGS NOT APPROVED')
  expect(world.ran).not.toContain('x')
})
