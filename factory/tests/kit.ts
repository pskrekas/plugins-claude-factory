// Shared by the test files: the pane's mount request and a /factory command input.
import type { CommandRunInput } from 'claude-code'

import { emptyModel } from '../core/model'
import type { PanelModel } from '../core/model'

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

// A model with every section filled.
export const FULL: PanelModel = {
  ...emptyModel(),
  consent: 'approved',
  task: {
    id: 'PROJ-12',
    branch: 'feat/PROJ-12-x',
    title: 'Add dark mode',
    state: 'open',
    note: null,
    pr: { number: 51, state: 'open', isDraft: false, build: 'green', approvals: 1, url: 'u' },
  },
  progress: [{ name: 'Plan A', path: 'p', done: 7, open: 7, percent: 50, blocked: 'disk is full' }],
  checks: [{ name: 'cloud account', state: 'wrong', got: 'other@example.com' }],
  ports: [{ name: 'database', port: 5432, state: 'down' }],
  worktrees: [
    { path: '/a', branch: 'main', isMerged: false },
    { path: '/b', branch: 'x', isMerged: true },
  ],
  owed: { open: 3 },
  readAt: 1000,
}

// What `state.get` answers for the panel atom holding `model`.
export function stored(model: PanelModel) {
  return { value: { value: { shape: 'panel-1', value: model }, version: 1 } }
}
