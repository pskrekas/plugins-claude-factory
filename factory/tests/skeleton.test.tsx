import { expect, test } from 'claude-code/testing'

import { PANE, cmd } from './kit'

test('the pane mounts on every surface and says there is no settings file', async ($, on) => {
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /No settings file/ }))?.text).toBe(
      'No settings file. Run /factory init.',
    )
    await ui.unmount()
  }
})

test('/factory opens the pane and /factory close closes it', async ($, on) => {
  const seen: string[] = []
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.open', (_, e) => {
    seen.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    seen.push('close:' + e.id)
    return { value: undefined }
  })

  expect((await $.command.run(cmd(''))).text).toBe('Factory pane opened.')
  expect((await $.command.run(cmd('close'))).text).toBe('Factory pane closed.')
  expect(seen).toEqual(['factory', 'close:factory'])
})
