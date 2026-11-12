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

// A /factory command as the person typed it (`composer`), or as it came from
// somewhere else. The engine stamps `presentation` in a session; a test leaves it out.
export function cmd(args: string, kind = 'composer'): CommandRunInput {
  return { command: 'factory', args, origin: { kind } } as CommandRunInput
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
    // A path that is a symbolic link, and the real path it leads to.
    links?: Record<string, string>
    path?: string
    // Last change of a file, for the newest-first order.
    mtimes?: Record<string, number>
  },
) {
  const seen = {
    files: world.files,
    ran: [] as string[],
    status: [] as (string | undefined)[],
    toasts: [] as string[],
    sounds: 0,
    writes: [] as string[],
    reads: [] as string[],
    paths: [] as (string | undefined)[],
    agents: (world.agents ?? []) as unknown[],
    isOpen: false,
    // The pane is on screen: placed, and the tab the surface shows.
    isPlaced: true,
    isShownTab: true,
    // The working tree the session is in, and the main checkout when it differs.
    root: '/r',
    repoRoot: null as string | null,
    cwds: [] as (string | undefined)[],
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
    value: (seen.isOpen
      ? [{ id: 'factory', title: 'Factory', isShown: seen.isShownTab, isFocused: false, isPlaced: seen.isPlaced }]
      : []) as never,
  }))
  on('session.root', () => ({ value: seen.root }))
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
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }) as never)
  on('agent.list', () => ({ value: seen.agents as never }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }) as never)
  on('turn.complete', () => ({}) as never)
  on('session.repo', () => ({
    value: { root: seen.repoRoot ?? seen.root, remote: world.remote ?? null } as never,
  }))
  on('session.cwd', () => ({ value: seen.root }))
  const real = (path: string) => world.links?.[path] ?? path
  const isDir = (path: string) =>
    Object.keys(seen.files).some(file => file.startsWith(path.replace(/\/$/, '') + '/'))
  on('fs.stat', (_, e) => {
    // Without `resolve`, a link is described as the link itself.
    if (e.resolve !== true && world.links?.[e.path] !== undefined) {
      return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: true } as never }
    }
    const target = real(e.path)
    const text = seen.files[target]
    if (text === undefined && !isDir(target)) throw new Error('ENOENT: no such file ' + e.path)

    return {
      value: {
        kind: text === undefined ? 'dir' : 'file',
        size: text?.length ?? 0,
        mtimeMs: world.mtimes?.[target] ?? 0,
        isLink: target !== e.path,
        realPath: target,
      } as never,
    }
  })
  on('fs.read', (_, e) => {
    seen.reads.push(e.path)
    const text = seen.files[real(e.path)]
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
  on('env.get', (_, e) => ({ value: e.name === 'PATH' ? (world.path ?? '/usr/bin:/bin') : undefined }))
  on('process.run', (_, e) => {
    // The top of the working tree: answered here, and not counted as a run.
    if (e.argv.join(' ') === 'git rev-parse --show-toplevel') {
      return { value: { exitCode: 0, stdout: seen.root + '\n', stderr: '' } as never }
    }
    seen.cwds.push(e.init?.cwd)
    seen.ran.push(e.argv.join(' '))
    seen.paths.push(e.init?.env?.PATH)
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

// The commands that came from a settings file: everything but the plugin's own
// `git` and `gh` reads.
export function settingsRuns(world: { ran: string[] }): string[] {
  return world.ran.filter(line => !line.startsWith('git ') && !line.startsWith('gh '))
}

// The whole input of `prompt.compose`, which a test must give.
export const COMPOSE = {
  model: 'm',
  promptModel: 'm',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as never
