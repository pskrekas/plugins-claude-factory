// Shared by the test files: the pane's mount request and a /factory command input.
import type { CommandRunInput, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

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

type Run = { exitCode: number; stdout: string; stderr?: string }

// What a test starts the session with, so the plugin's `session.start` hook runs.
export const START = { cwd: '/r', surface: 'terminal', isInteractive: true } as const

// Stands for the engine beneath the plugin: a file system held in memory, a
// clock, a store, a repo at /r, and commands answered by `run` (a command with
// no answer fails to start, as a missing program does).
export function engine(
  on: On,
  world: {
    files: Record<string, string>
    now?: number
    remote?: string | null
    run?: (argv: readonly string[]) => Run | undefined
    agents?: unknown[]
  },
) {
  const seen = {
    files: world.files,
    ran: [] as string[],
    status: [] as (string | undefined)[],
    toasts: [] as string[],
    sounds: 0,
    writes: [] as string[],
    isOpen: false,
    root: '/r',
    clock: mock.clock(on, { now: world.now ?? 0 }),
  }
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.322', base: '2.1.322' } as never }))
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.open', () => {
    seen.isOpen = true

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    seen.isOpen = false

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: (seen.isOpen ? [{ id: 'factory', title: 'Factory' }] : []) as never,
  }))
  on('ui.status', (_, e) => {
    seen.status.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('audio.play', () => {
    seen.sounds++

    return { value: undefined }
  })
  on('agent.list', () => ({ value: (world.agents ?? []) as never }))
  on('session.repo', () => ({ value: { root: seen.root, remote: world.remote ?? null } as never }))
  on('session.cwd', () => ({ value: seen.root }))
  on('fs.read', (_, e) => {
    const text = seen.files[e.path]
    if (text === undefined) throw new Error('ENOENT: no such file ' + e.path)

    return { value: text }
  })
  on('fs.write', (_, e) => {
    seen.files[e.path] = e.text
    seen.writes.push(e.path)

    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = (e.path ?? '').replace(/\/$/, '') + '/'
    const names = new Map<string, boolean>()
    for (const path of Object.keys(seen.files)) {
      if (!path.startsWith(dir)) continue
      const rest = path.slice(dir.length)
      const name = rest.split('/')[0] ?? ''
      names.set(name, rest.includes('/'))
    }
    if (names.size === 0) throw new Error('ENOENT: no such directory ' + e.path)

    return {
      value: [...names].map(([name, isDir]) => ({ name, kind: isDir ? 'dir' : 'file', size: 0, mtimeMs: 0 })) as never,
    }
  })
  on('process.run', (_, e) => {
    seen.ran.push(e.argv.join(' '))
    const answer = world.run?.(e.argv)
    if (answer === undefined) throw new Error('ENOENT: ' + e.argv[0])

    return {
      value: { exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr ?? '' } as never,
    }
  })

  return seen
}

// Every Text the pane draws on the terminal, top to bottom.
export async function paneText($: Engine, columns = 40): Promise<string[]> {
  const ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, bodyColumns: columns },
    surface: 'terminal',
  })
  const rows = (await ui.findAll({ type: 'Text' })).map(row => row.text ?? '')
  await ui.unmount()

  return rows
}
