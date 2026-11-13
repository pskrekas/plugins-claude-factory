// Shared by the test files: the pane's mount request and a /factory command input.
import type { CommandRunInput, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

import type { McpResult } from '../core/mcp-tracker'
import { emptyModel } from '../core/model'
import { stateFolderOf } from '../core/state-path'
import type { FactoryView, JobView, PanelModel } from '../core/model'

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
  return { value: { value: { shape: 'panel-5', value: model }, version: 1 } }
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
    // What the store holds at the start.
    store?: Record<string, unknown>
    // What an MCP tool answers (a result, or a promise of one). Undefined, or no
    // `mcp` at all, rejects as the engine does for a tool that is not connected.
    mcp?: (server: string, tool: string, args: Record<string, unknown>) => unknown
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
    // What each command got on its standard input.
    stdins: [] as (string | undefined)[],
    paths: [] as (string | undefined)[],
    // The PATH of the git call that asks where the repo starts.
    probePaths: [] as (string | undefined)[],
    agents: (world.agents ?? []) as unknown[],
    isOpen: false,
    // The pane is on screen: placed, and the tab the surface shows.
    isPlaced: true,
    isShownTab: true,
    // The working tree the session is in, and the main checkout when it differs.
    root: '/r',
    repoRoot: null as string | null,
    // What git says is the top of the working tree. By default git is honest:
    // the nearest folder above the session's that holds a `.git`.
    gitTop: null as string | null,
    // True when git refuses the repository (a `.git` another user owns).
    gitRefuses: false,
    cwds: [] as (string | undefined)[],
    // The agent types the plugin registered, and the agents it started.
    registered: [] as { name: string; tools?: readonly string[]; model?: string }[],
    // The tools the plugin registered.
    tools: [] as { name: string; inputSchema?: unknown }[],
    // The commands the plugin registered, with their description.
    commands: [] as { name: string; description?: string }[],
    spawned: [] as { type: string; description: string; cwd?: string }[],
    clock: mock.clock(on, { now: world.now ?? 0 }),
    // Every $.mcp.call: the server, the tool and the arguments.
    mcpCalls: [] as [string, string, Record<string, unknown>][],
  }
  mock.store(on, world.store)
  on('mcp.call', async (_, e) => {
    seen.mcpCalls.push([e.server, e.tool, e.args])
    const answer = await world.mcp?.(e.server, e.tool, e.args)
    // A hook that throws is skipped: a refusal is how the call rejects here.
    if (answer === undefined) return { deny: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` }

    return { value: answer as never }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.322', base: '2.1.322' } as never }))
  on('command.register', (_, e) => {
    seen.commands.push(e as { name: string; description?: string })

    return { value: { command: 'factory' } }
  })
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
  on('session.id', () => ({ value: 'session-1' }))
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
  on('agent.spawn', (_, e) => {
    seen.spawned.push({ type: e.subagentType, description: e.description, cwd: (e as { cwd?: string }).cwd })

    return { model: 'm', agentId: `a${seen.spawned.length}` } as never
  })
  on('agent.register', (_, e) => {
    seen.registered.push(e as { name: string; tools?: readonly string[]; model?: string })

    return { value: { agent: 'factory:' + e.name } as never }
  })
  on('agent.offer', () => ({ isOffered: true }) as never)
  on('tool.register', (_, e) => {
    seen.tools.push(e as { name: string; inputSchema?: unknown })

    return { value: { tool: 'mcp__factory__' + e.name } as never }
  })
  on('tool.check', () => ({ decision: 'ask' }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('session.repo', () => ({
    value: { root: seen.repoRoot ?? seen.root, remote: world.remote ?? null } as never,
  }))
  on('session.cwd', () => ({ value: seen.root }))
  const real = (path: string) => world.links?.[path] ?? path
  // Folders that `mkdir` made: a folder exists before a file is in it.
  const made = new Set<string>()
  const isDir = (path: string) =>
    made.has(path.replace(/\/$/, '')) ||
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
  on('fs.exists', (_, e) => ({ value: seen.files[real(e.path)] !== undefined || isDir(real(e.path)) }))
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
  on('env.get', (_, e) => ({
    value: e.name === 'PATH' ? (world.path ?? '/usr/bin:/bin') : e.name === 'HOME' ? '/home/me' : undefined,
  }))
  on('process.run', (_, e) => {
    if (e.argv.join(' ') === 'git rev-parse --show-toplevel') {
      seen.probePaths.push(e.init?.env?.PATH)
      const from = e.init?.cwd ?? seen.root
      const dirs = from.split('/').map((_, i, parts) => parts.slice(0, parts.length - i).join('/') || '/')
      const honest = dirs.find(dir => seen.files[real(`${dir}/.git`)] !== undefined || isDir(real(`${dir}/.git`)))
      const top = seen.gitTop ?? honest
      if (seen.gitRefuses || top === undefined) {
        return { value: { exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership' } as never }
      }

      return { value: { exitCode: 0, stdout: top + '\n', stderr: '' } as never }
    }
    // The file commands of the store are acted out on the file map, and not counted as runs.
    const plain = e.argv.filter(arg => arg !== '-p' && arg !== '-f')
    const ok = (isOk: boolean) => ({ value: { exitCode: isOk ? 0 : 1, stdout: '', stderr: '' } as never })
    if (plain[0] === 'mkdir' && plain[1] !== undefined) {
      made.add(plain[1])

      return ok(true)
    }
    if (plain[0] === 'mv' && plain[1] !== undefined && plain[2] !== undefined) {
      const [from, to] = [plain[1], plain[2]]
      const moved = Object.keys(seen.files).filter(file => file === from || file.startsWith(from + '/'))
      for (const file of moved) {
        seen.files[to + file.slice(from.length)] = seen.files[file] ?? ''
        delete seen.files[file]
      }

      return ok(moved.length > 0)
    }
    if (plain[0] === 'rm' && plain[1] === '-r' && plain[2] !== undefined) {
      const gone = plain[2]
      for (const file of Object.keys(seen.files).filter(name => name.startsWith(gone + '/'))) delete seen.files[file]

      return ok(true)
    }
    if (plain[0] === 'rm' && plain[1] !== undefined) {
      delete seen.files[plain[1]]

      return ok(true)
    }
    seen.cwds.push(e.init?.cwd)
    seen.stdins.push(e.init?.stdin)
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

// An Io held in memory, for code that takes an Io and needs no engine: a file
// map, a session id, a clock. `git ls-files` says whether .factory is tracked.
export function fakeIo(
  world: {
    files?: Record<string, string>
    // Folders made with mkdir, shared by the sessions of one test.
    dirs?: Map<string, number>
    session?: string
    now?: number
    stateDir?: string
    // Paths that are symbolic links.
    links?: Set<string>
    // A path whose real place is another one.
    reals?: Record<string, string>
    remote?: string | null
  } = {},
) {
  const files = world.files ?? {}
  const dirs = world.dirs ?? new Map<string, number>()
  const isDir = (path: string) => dirs.has(path) || Object.keys(files).some(file => file.startsWith(path + '/'))
  const io = {
    files,
    session: world.session ?? 'session-1',
    time: world.now ?? 0,
    model: emptyModel(),
    reads: [] as string[],
    ran: [] as string[],
    stdins: [] as (string | undefined)[],
    // Where each command ran, with which time limit and which environment.
    cwds: [] as (string | undefined)[],
    timeouts: [] as (number | undefined)[],
    envs: [] as (Record<string, string> | undefined)[],
    // A program whose next run fails, to test what a failure leaves behind.
    failNext: null as string | null,
    // Answers for commands the fake does not act out itself (git, gh).
    answer: null as
      | ((argv: string[]) => { exitCode: number; stdout: string; stderr?: string; isCut?: boolean; failed?: 'timeout' | 'other' } | undefined)
      | null,
    now: async () => io.time,
    root: async () => '/r',
    remote: async () => world.remote ?? null,
    sessionId: async () => io.session,
    stateDir: async () => world.stateDir ?? '/state',
    stat: async (path: string) => {
      const text = files[path]
      const realPath = world.reals?.[path] ?? path
      if (text !== undefined) return { kind: 'file' as const, size: text.length, mtimeMs: 0, realPath }

      return isDir(path) ? { kind: 'dir' as const, size: 0, mtimeMs: dirs.get(path) ?? 0, realPath } : null
    },
    isLink: async (path: string) => world.links?.has(path) ?? false,
    readFile: async (path: string) => {
      io.reads.push(path)

      return files[path] ?? null
    },
    listDir: async (path: string) => {
      const names = new Set<string>()
      for (const file of Object.keys(files)) {
        if (!file.startsWith(path + '/')) continue
        const rest = file.slice(path.length + 1)
        names.add(rest.includes('/') ? rest.split('/')[0] + '/' : rest)
      }

      return [...names]
    },
    // Every path a file was written to directly (not moved to).
    written: [] as string[],
    writeFile: async (path: string, text: string) => {
      io.written.push(path)
      files[path] = text
    },
    run: async (argv: string[], init?: { cwd?: string; timeoutMs?: number; stdin?: string; env?: Record<string, string> }) => {
      io.ran.push(argv.join(' '))
      io.stdins.push(init?.stdin)
      io.cwds.push(init?.cwd)
      io.timeouts.push(init?.timeoutMs)
      io.envs.push(init?.env)
      const done = (ok: boolean) => ({ exitCode: ok ? 0 : 1, stdout: '', stderr: '' })
      if (io.failNext === argv[0]) {
        io.failNext = null

        return done(false)
      }
      const given = io.answer?.(argv)
      if (given !== undefined) {
        // A command that ran past its time, or broke, as the real `run` reports it.
        if (given.failed !== undefined) return { failed: given.failed }

        return { exitCode: given.exitCode, stdout: given.stdout, stderr: given.stderr ?? '', ...(given.isCut ? { isCut: true } : {}) }
      }
      const args = argv.filter(arg => arg !== '-p' && arg !== '-f')
      const [program, a, b] = args
      // `find <folder> … -iname .git -print`: every entry below the folder that is named `.git`, by any case.
      if (program === 'find' && a !== undefined) {
        const hits = new Set<string>()
        for (const file of Object.keys(files)) {
          if (!file.startsWith(a + '/')) continue
          const parts = file.slice(a.length + 1).split('/')
          parts.forEach((part, i) => {
            if (part.toLowerCase() === '.git') hits.add(`${a}/${parts.slice(0, i + 1).join('/')}`)
          })
        }

        return { exitCode: 0, stdout: [...hits].sort().map(hit => hit + '\n').join(''), stderr: '' }
      }
      // mkdir makes a folder only if nothing is there: it is the atomic step of the lock.
      if (program === 'mkdir' && a !== undefined) {
        if (argv.includes('-p') && isDir(a)) return done(true)
        if (isDir(a) || files[a] !== undefined) return done(false)
        dirs.set(a, io.time)
        // With -p the folders above it are made too, as mkdir does.
        if (argv.includes('-p')) {
          for (let up = a.slice(0, a.lastIndexOf('/')); up !== '' && !isDir(up); up = up.slice(0, up.lastIndexOf('/'))) dirs.set(up, io.time)
        }

        return done(true)
      }
      if (program === 'mv' && a !== undefined && b !== undefined) {
        // One file: a rename over whatever is there.
        if (files[a] !== undefined) {
          files[b] = files[a] ?? ''
          delete files[a]

          return done(true)
        }
        if (!isDir(a)) return done(false)
        for (const file of Object.keys(files).filter(name => name.startsWith(a + '/'))) {
          files[b + file.slice(a.length)] = files[file] ?? ''
          delete files[file]
        }
        dirs.delete(a)
        dirs.set(b, io.time)

        return done(true)
      }
      if (program === 'rm' && a === '-r' && b !== undefined) {
        for (const file of Object.keys(files).filter(name => name.startsWith(b + '/'))) delete files[file]
        // A file or a link of that name goes too.
        delete files[b]
        world.links?.delete(b)
        dirs.delete(b)

        return done(true)
      }
      // rm -f of one file.
      if (program === 'rm' && a !== undefined) {
        delete files[a]

        return done(true)
      }

      return { failed: 'not-found' as const }
    },
    store: new Map<string, unknown>(),
    storeGet: async (key: string) => io.store.get(key),
    storeSet: async (key: string, value: unknown) => {
      io.store.set(key, value)
    },
    getModel: async () => io.model,
    updateModel: async (change: (model: PanelModel) => PanelModel) => {
      io.model = change(io.model)

      return io.model
    },
    status: () => undefined,
    toasts: [] as string[],
    toast: (text: string) => {
      io.toasts.push(text)
    },
    sounds: 0,
    sound: () => {
      io.sounds += 1
    },
    // Every MCP call (server, tool, arguments), and what a tool answers: by
    // default, as for a server that is not connected.
    mcpCalls: [] as [string, string, Record<string, unknown>][],
    mcpAnswer: null as ((server: string, tool: string, args: Record<string, unknown>) => McpResult | undefined) | null,
    mcp: async (server: string, tool: string, args: Record<string, unknown>, _timeoutMs: number): Promise<McpResult> => {
      io.mcpCalls.push([server, tool, args])

      return io.mcpAnswer?.(server, tool, args) ?? { failed: 'no-server', why: 'no such tool on a connected server' }
    },
    // The session's agents, as the engine lists them.
    agentList: [] as { id: string; status: string; type: string; description: string }[],
    agents: async () => io.agentList as never,
    isPaneDrawn: async () => true,
  }

  return io
}

const jobView = (over: Partial<JobView> & Pick<JobView, 'itemId' | 'stage'>): JobView => ({
  title: 'A job',
  stoppedIn: null,
  round: 1,
  maxRounds: 3,
  sentBack: null,
  question: null,
  prNumber: null,
  minutes: 0,
  costUsd: null,
  work: null,
  tries: 0,
  ...over,
})

// A factory with two running jobs (one on the gate's loop) and two that wait.
export const VIEW: FactoryView = {
  jobs: [
    jobView({ itemId: 'PROJ-12', stage: 'review', minutes: 9, costUsd: 2.1 }),
    jobView({
      itemId: 'PROJ-13',
      stage: 'build',
      round: 2,
      sentBack: { by: 'gate', why: '2 tests failed' },
      minutes: 14,
      costUsd: 3.4,
    }),
    jobView({ itemId: 'PROJ-14', stage: 'needs-info', stoppedIn: 'intake', question: 'Which default font?' }),
    jobView({ itemId: 'PROJ-10', stage: 'ready', prNumber: 51 }),
  ],
  counts: [4, 0, 0, 1, 0, 1, 0, 2],
  running: 2,
  waiting: 2,
  moreRunning: 0,
  moreWaiting: 0,
  queue: 4,
  slots: 2,
  today: { done: 3, minutes: 41, costUsd: 9.8, firstRound: 2, finished: 3 },
  note: null,
  lock: 'mine',
  holder: null,
  isStopped: false,
  claimed: [],
  plan: [],
  models: { intake: 'opus', spec: 'sonnet', builder: 'sonnet', reviewer: 'haiku', approver: 'sonnet' },
}

// Where the factory keeps the state of the repo at /r: under the person's home
// (the kit's HOME is /home/me), never in the repo.
export const STATE = '/home/me/.local/state/claude-factory/' + stateFolderOf('/r')
