import { expect, test } from 'claude-code/testing'

import { PANE, START, cmd, engine } from './kit'

test('the pane mounts on every surface and says there is no settings file', async ($, on) => {
  engine(on, { files: {} })
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /No settings file/ }))?.text).toBe(
      'No settings file. Run /factory init.',
    )
    await ui.unmount()
  }
})

test('/factory opens the pane and /factory close closes it', async ($, on) => {
  const world = engine(on, { files: {} })
  await $.session.start(START)

  expect((await $.command.run(cmd(''))).text).toBe('Factory pane opened.')
  expect(world.isOpen).toBe(true)
  expect((await $.command.run(cmd('close'))).text).toBe('Factory pane closed.')
  expect(world.isOpen).toBe(false)
})

test('a command before the session started says so and does not throw', async ($, on) => {
  engine(on, { files: {} })

  expect((await $.command.run(cmd(''))).text).toBe('Factory is not ready. Start a new session.')
})

test('the pane is read again each minute, only while it is open', async ($, on) => {
  const world = engine(on, { files: {} })
  await $.session.start(START)

  const atStart = world.status.length
  await world.clock.advance(60_000)
  expect(world.status.length).toBe(atStart)

  await $.command.run(cmd(''))
  const after = world.status.length
  await world.clock.advance(60_000)
  expect(world.status.length).toBe(after + 1)
})
