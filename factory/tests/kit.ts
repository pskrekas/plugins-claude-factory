// Shared by the test files: the pane's mount request and a /factory command input.
import type { CommandRunInput } from 'claude-code'

export const PANE = {
  plugin: 'factory',
  component: 'Pane',
  requestId: 'factory',
  props: {
    title: 'Factory',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// The engine stamps `origin` and `presentation` in a session; a test leaves them out.
export function cmd(args: string): CommandRunInput {
  return { command: 'factory', args } as CommandRunInput
}
