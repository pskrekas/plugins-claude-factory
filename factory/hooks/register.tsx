import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import { rowsOf } from '../core/layout'
import type { Tone } from '../core/layout'
import { emptyModel } from '../core/model'
import { PANE, TITLE } from './state'

// Change the tag when PanelModel's fields change: it declines what an earlier
// version stored, which outlives a reload.
const panel = atom({ plugin: 'factory', key: 'panel' } as const, emptyModel(), {
  shape: 'panel-1',
})

const MINIMUM = [2, 1, 322] as const

// Theme keys, so the colours follow the person's theme.
const COLOR: Record<Tone, string | undefined> = {
  plain: undefined,
  dim: undefined,
  head: undefined,
  good: 'success',
  warn: 'warning',
  bad: 'error',
}

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
    const columns = Math.max(1, e.props.bodyColumns ?? e.viewport?.columns ?? 60)
    const rows = rowsOf(model, columns, await $.clock.now())

    return (
      <Box flexDirection="column">
        {rows.map(row => {
          const gap = Math.max(1, columns - row.left.length - row.right.length)

          return (
            <Text bold={row.tone === 'head'} dimColor={row.tone === 'dim'} color={COLOR[row.tone]}>
              {row.left}
              {row.right !== '' && ' '.repeat(gap)}
              {row.right !== '' && (
                <Text dimColor={row.rightTone === 'dim'} color={COLOR[row.rightTone]}>
                  {row.right}
                </Text>
              )}
            </Text>
          )
        })}
      </Box>
    )
  })
}
