import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import { emptyModel } from '../core/model'
import { PANE, TITLE } from './state'

// Change the tag when PanelModel's fields change: it declines what an earlier
// version stored, which outlives a reload.
const panel = atom({ plugin: 'factory', key: 'panel' } as const, emptyModel(), {
  shape: 'panel-1',
})

const MINIMUM = [2, 1, 322] as const

// True when `version` (2.1.322, 2.1.322-dev.…) is at least MINIMUM.
function isSupported(version: string): boolean {
  const parts = (version.split('-')[0] ?? '').split('.').map(Number)
  for (const [i, want] of MINIMUM.entries()) {
    const have = parts[i] ?? 0
    if (have !== want) return have > want
  }

  return true
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const version = await $.session
      .version()
      .then(v => v.version)
      .catch(() => null)
    if (version !== null && !isSupported(version)) {
      $.ui.log('factory: needs Claude Code 2.1.322 or later')

      return started
    }
    await $.command.register({
      name: 'factory',
      description: 'Open the Factory work panel (close | init | approve)',
    })
    if (options.openOnStart === true) void $.ui.open({ id: PANE, title: TITLE })

    return started
  })

  on('command.run', { command: 'factory' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') {
      await $.ui.open({ id: PANE, title: TITLE })

      return { text: 'Factory pane opened.' }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Factory pane closed.' }
    }

    return { text: `Unknown: /factory ${arg}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const model = await read($, panel)

    return (
      <Box flexDirection="column">
        {model.consent === 'none' && <Text dimColor>No settings file. Run /factory init.</Text>}
      </Box>
    )
  })
}
