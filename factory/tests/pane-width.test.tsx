import { expect, mock, test } from 'claude-code/testing'

import { FULL, PANE, stored } from './kit'

test('a pane 24 columns wide draws the model with no row past its width', async ($, on) => {
  on('state.get', () => stored(FULL))
  mock.clock(on, { now: 5000 })

  const ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, bodyColumns: 24 },
    surface: 'terminal',
  })

  expect(await ui.find({ type: 'Text', text: /PROJ-12/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /TASK/ })).toBeDefined()
  for (const row of await ui.findAll({ type: 'Text' })) {
    expect((row.text ?? '').length).toBeLessThanOrEqual(24)
  }
  await ui.unmount()
})
