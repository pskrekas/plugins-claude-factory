import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { briefOf } from '../core/brief'
import { safePath } from '../core/checks'
import { rowsOf } from '../core/layout'
import type { Tone } from '../core/layout'
import { emptyModel } from '../core/model'
import { failureOf } from '../core/run'
import type { Io } from './io'
import { init } from './init'
import { approve, refresh, refreshAgents } from './refresh'
import { PANE, TITLE } from './state'

// Change the tag when PanelModel's fields change: it declines what an earlier
// version stored, which outlives a reload.
const panel = atom({ plugin: 'factory', key: 'panel' } as const, emptyModel(), {
  shape: 'panel-1',
})

const MINIMUM = [2, 1, 322] as const
const REFRESH_MS = 60_000
const NOT_READY = 'Factory is not ready. Start a new session.'
const ONLY_A_PERSON = 'Only a person can approve. Type /factory approve at the prompt.'
const GIT_TOP_MS = 5_000

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
  // Built in `session.start`, which runs before the first prompt and again
  // after every reload. See hooks/io.ts for why it exists.
  let io: Io | null = null
  let brief: string | null = null

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

    // The top of the working tree, found once per session folder. In a linked
    // worktree `$.session.repo()` names the main checkout, which is not where
    // this session's files and branch are.
    const tops = new Map<string, string>()
    const root = async () => {
      const at = await $.session.root().catch(() => $.session.cwd())
      const known = tops.get(at)
      if (known !== undefined) return known
      const env = { PATH: safePath(await $.env.get('PATH').catch(() => undefined), at) }
      const top = await $.process
        .run(['git', 'rev-parse', '--show-toplevel'], { cwd: at, env, timeoutMs: GIT_TOP_MS })
        .then(done => (done.exitCode === 0 ? done.stdout.trim() : ''))
        .catch(() => '')
      const found = top !== '' ? top : at
      tops.set(at, found)

      return found
    }
    io = {
      now: () => $.clock.now(),
      root,
      // The repository this working tree belongs to, as git itself names it:
      // its common `.git` folder. A linked worktree has the same one as the
      // main checkout, so they share approvals; another repository cloned
      // inside this one has its own, so it never does. Outside git, or when
      // git cannot say, the working tree's own path.
      consentKey: async () => {
        const at = await root()
        const env = { PATH: safePath(await $.env.get('PATH').catch(() => undefined), at) }
        const dir = await $.process
          .run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: at,
            env,
            timeoutMs: GIT_TOP_MS,
          })
          .then(done => (done.exitCode === 0 ? done.stdout.trim() : ''))
          .catch(() => '')

        return dir.startsWith('/') ? dir : at
      },
      remote: () =>
        $.session
          .repo()
          .then(repo => repo?.remote ?? null)
          .catch(() => null),
      stat: path =>
        $.fs
          .stat(path, { resolve: true })
          .then(found =>
            found.realPath === undefined
              ? null
              : {
                  kind: found.kind,
                  size: found.size,
                  mtimeMs: found.mtimeMs,
                  realPath: found.realPath,
                },
          )
          .catch(() => null),
      isLink: path =>
        $.fs
          .stat(path)
          .then(found => found.isLink)
          .catch(() => false),
      readFile: path =>
        $.fs
          .read(path)
          .then(text => (typeof text === 'string' ? text : null))
          .catch(() => null),
      listDir: path =>
        $.fs
          .list(path)
          .then(entries => entries.map(entry => entry.name + (entry.kind === 'dir' ? '/' : '')))
          .catch(() => []),
      writeFile: (path, text) => $.fs.write(path, text),
      run: async (argv, init) => {
        const path = await $.env.get('PATH').catch(() => undefined)
        const env = { PATH: safePath(path, await root()) }

        return $.process
          .run(argv, { ...init, env })
          .then(done => ({ exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr }))
          .catch(failureOf)
      },
      storeGet: key => $.store.get(key).catch(() => undefined),
      storeSet: (key, value) => $.store.set(key, value),
      getModel: () => read($, panel),
      updateModel: async change => {
        let result = emptyModel()
        await update($, panel, model => {
          result = change(model)

          return result
        })

        return result
      },
      status: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      sound: () => {
        if (options.sound !== false) void $.audio.play({ asset: 'fx/alert.wav' }).catch(() => undefined)
      },
      agents: () => $.agent.list().catch(() => []),
      isPaneDrawn: () =>
        $.ui
          .panes()
          .then(panes => panes.some(pane => pane.id === PANE && pane.isPlaced && pane.isShown))
          .catch(() => false),
    }
    const ready = io

    await $.command.register({
      name: 'factory',
      description: 'Open the Factory work panel (close | init | approve)',
    })
    // One quick read now, so the status line and the session brief have the
    // branch and the progress before the first prompt. It runs no `gh` and no
    // command from the settings file.
    // The brief is built here, once: it is part of the system prompt, and a
    // system prompt that changes during a session loses the prompt cache.
    brief = await refresh(ready, { isLight: true })
      .then(briefOf)
      .catch(() => null)
    if (options.openOnStart === true) {
      void $.ui.open({ id: PANE, title: TITLE }).then(() => refresh(ready))
    }
    // Slow reads run once a minute, and only while the pane is on screen.
    $.clock.every(REFRESH_MS, () => {
      void ready
        .isPaneDrawn()
        .then(isDrawn => (isDrawn ? refresh(ready) : undefined))
        .catch(() => undefined)
    })

    return started
  })

  // The session brief: the last section of the system prompt, with the text
  // built at session start. It reads nothing: a brief must not delay a prompt.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (brief === null) return composed

    return {
      ...composed,
      sections: [...composed.sections, { id: 'factory:brief', text: brief, scope: 'session' }],
    }
  })

  // An agent that starts or ends shows at once: this reads the agent list only.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (io !== null) void refreshAgents(io).catch(() => undefined)

    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (io !== null && e.agentId !== undefined) void refreshAgents(io).catch(() => undefined)

    return done
  })

  on('command.run', { command: 'factory' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Factory pane closed.' }
    }
    if (io === null) return { text: NOT_READY }
    if (arg === '') {
      await $.ui.open({ id: PANE, title: TITLE })
      await refresh(io)

      return { text: 'Factory pane opened.' }
    }
    if (arg === 'approve') {
      // An approval is the person's own act: only their Enter at the prompt counts.
      if (e.origin?.kind !== 'composer') return { text: ONLY_A_PERSON }
      // Their command opens the pane, so the commands can be drawn and read.
      await $.ui.open({ id: PANE, title: TITLE })

      return { text: await approve(io) }
    }
    if (arg === 'init') return { text: await init(io) }

    return { text: 'Commands: /factory, /factory close, /factory init, /factory approve' }
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
