import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { agentSpecs, typeOf } from '../core/agents'
import { briefOf } from '../core/brief'
import { safePath } from '../core/checks'
import { rowsOf } from '../core/layout'
import type { Tone } from '../core/layout'
import { emptyModel } from '../core/model'
import { displayWidth } from '../core/rows'
import { failureOf } from '../core/run'
import { stateBaseOf } from '../core/state-path'
import { ROLES } from '../core/factory-settings'
import { ancestorsOf, confirmedTop } from '../core/top'
import { checkedSpawn, isOwnReport, onSpawn, onToolCheck, onTurn, rememberAgent, spawnSettled } from './agent-events'
import type { Io } from './io'
import { answerJob, rejectJob, stopLine } from './commands'
import { init } from './init'
import type { Spawn } from './agent-events'
import { whereText } from './jobs'
import { advance, watch } from './line'
import { startPlan, startRun } from './start'
import { loadSettings } from './readers/settings'
import { approve, refresh, refreshAgents } from './refresh'
import { PANE, TITLE } from './state'

// Change the tag when PanelModel's fields change: it declines what an earlier
// version stored, which outlives a reload.
const panel = atom({ plugin: 'factory', key: 'panel' } as const, emptyModel(), {
  shape: 'panel-4',
})

const MINIMUM = [2, 1, 322] as const
const REFRESH_MS = 60_000
// The timer that keeps the line's lock alive and sees an agent that is gone. It starts no agent.
const WATCH_MS = 15_000
const NOT_READY = 'Factory is not ready. Start a new session.'
const GIT_TOP_MS = 5_000
const AGENT_TYPES = ROLES.map(typeOf)
const ONLY_A_PERSON_CAN = 'Only a person can do this. Type the command at the prompt.'
const ONLY_A_PERSON = 'Only a person can approve. Type /factory approve at the prompt.'

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
  // False when an agent type could not be registered: then the line does not run.
  let hasAgentTypes = true

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
    const realOf = (path: string) =>
      $.fs
        .stat(path, { resolve: true })
        .then(found => found.realPath ?? null)
        .catch(() => null)
    const root = async () => {
      const at = await $.session.root().catch(() => $.session.cwd())
      const known = tops.get(at)
      if (known !== undefined) return known
      // The nearest folder, from the session's own upward, that holds a `.git`,
      // and only if git, asked from the session's folder, names the same one
      // (core/top.ts says why both). Else the session's folder.
      const real = (await realOf(at)) ?? at
      let walkTop: string | null = null
      for (const dir of ancestorsOf(real)) {
        const hasGit = await $.fs.exists(`${dir}/.git`).catch(() => false)
        if (hasGit) {
          walkTop = dir
          break
        }
      }
      let gitTop: string | null = null
      if (walkTop !== null) {
        // Cleaned against the outermost folder that could be the repo, so a
        // `git` inside it (a tool folder of the repo on the PATH) is never run.
        const env = { PATH: safePath(await $.env.get('PATH').catch(() => undefined), walkTop) }
        const said = await $.process
          .run(['git', 'rev-parse', '--show-toplevel'], { cwd: real, env, timeoutMs: GIT_TOP_MS })
          .then(done => (done.exitCode === 0 ? done.stdout.trim() : ''))
          .catch(() => '')
        gitTop = said === '' ? null : await realOf(said)
      }
      const found = confirmedTop(real, walkTop, gitTop)
      tops.set(at, found)

      return found
    }
    io = {
      now: () => $.clock.now(),
      root,
      remote: () =>
        $.session
          .repo()
          .then(repo => repo?.remote ?? null)
          .catch(() => null),
      sessionId: () => $.session.id(),
      stateDir: async () =>
        stateBaseOf(
          await $.env.get('HOME').catch(() => undefined),
          await $.env.get('XDG_STATE_HOME').catch(() => undefined),
        ),
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
        const env = { ...init?.env, PATH: safePath(path, await root()) }

        return $.process
          .run(argv, { ...init, env })
          .then(done => ({
            exitCode: done.exitCode,
            stdout: done.stdout,
            stderr: done.stderr,
            ...(done.isStdoutTruncated || done.isStderrTruncated ? { isCut: true } : {}),
          }))
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

    // The agent types of the line. They are the plugin's alone: the model is
    // not offered them, and a spawn that the line did not make is refused.
    const { settings } = await loadSettings(ready)
    for (const spec of agentSpecs(settings.factory)) {
      await $.agent.register(spec).catch(() => {
        hasAgentTypes = false
        $.ui.log(`factory: the agent type ${spec.name} could not be registered`)
      })
    }

    await $.command.register({
      name: 'factory',
      description: 'Open the Factory work panel (close | init | approve | where | plan | run | stop | answer | reject)',
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
    $.clock.every(WATCH_MS, () => {
      void watch(ready).catch(() => undefined)
    })
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

  on('agent.offer', async ($, e, next) => (AGENT_TYPES.includes(e.agent) ? { isOffered: false } : next(e)))

  // An agent of the line starts in its job's worktree, and only when the line
  // itself started it. Any agent that starts or ends shows in the pane at once.
  on('agent.spawn', async ($, e, next) => {
    const ours = io === null ? (AGENT_TYPES.includes(e.subagentType) ? { deny: NOT_READY } : null) : await onSpawn(io, e)
    if (ours !== null && 'deny' in ours) return { deny: ours.deny }
    if (ours === null) {
      const other = await next(e)
      if (io !== null) void refreshAgents(io).catch(() => undefined)

      return other
    }
    // From here until the agent's id is known, the fence refuses an agent it does not know.
    const spawned = await next({ ...e, cwd: ours.cwd }).finally(spawnSettled)
    if (spawned.agentId !== undefined) rememberAgent(spawned.agentId, ours)
    if (io !== null) void refreshAgents(io).catch(() => undefined)

    return spawned
  })

  // The fence. It answers only for an agent of the line and only for the tools
  // of its role; every other call goes on unchanged.
  on('tool.check', async ($, e, next) => {
    const verdict = io === null ? null : await onToolCheck(io, e)

    return verdict === null ? next(e) : verdict
  })

  // The end of a turn. For an agent of the line it is a fact for the inbox.
  // Then the jobs are advanced here, in this hook: an agent is fenced only
  // when a hook that is still running starts it (docs/notes/r2b-check.md).
  // The end of one of the session's own turns advances the line too, so a
  // station that was left for a hook is picked up.
  on('turn.complete', async ($, e, next) => {
    const ready = io
    if (ready !== null) await onTurn(ready, e).catch(() => false)
    const done = await next(e)
    if (ready !== null) {
      await advance(ready, a => checkedSpawn(ready, input => $.agent.spawn(input), a)).catch(() => undefined)
      if (e.agentId !== undefined) void refreshAgents(ready).catch(() => undefined)
    }

    return done
  })

  // The report of an agent of the line is not a prompt for the session's model.
  on('prompt.submit', async ($, e, next) => {
    if (io !== null && (await isOwnReport(io, e).catch(() => false))) return { drop: 'factory: an agent of the line finished' }

    return next(e)
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
    if (arg === 'where') return { text: await whereText(io, await io.root()) }

    // The commands that change the line or a job: the person's own act, like approve.
    const [word = '', id = ''] = arg.split(/\s+/)
    if (word === 'stop' || word === 'answer' || word === 'reject' || word === 'run' || word === 'plan') {
      if (e.origin?.kind !== 'composer') return { text: ONLY_A_PERSON_CAN }
      const ready = io
      // This hook's own way to start an agent: an agent is fenced only when a
      // hook that is still running starts it.
      const spawn: Spawn = a => checkedSpawn(ready, input => $.agent.spawn(input), a)
      const rest = id === '' ? '' : arg.slice(arg.indexOf(id) + id.length).trim()
      if (word === 'run') return { text: await startRun(ready, spawn, id === '' ? null : id, { hasAgentTypes }) }
      if (word === 'plan') return { text: await startPlan(ready, spawn, { hasAgentTypes }) }
      if (word === 'stop') return { text: await stopLine(io) }
      if (word === 'answer') {
        return { text: id === '' ? 'Say which job: /factory answer <id> [text]' : await answerJob(io, id, rest, spawn) }
      }

      return { text: id === '' ? 'A reason is needed: /factory reject <id> <reason>' : await rejectJob(io, id, rest) }
    }

    return {
      text: 'Commands: /factory, /factory close, /factory init, /factory approve, /factory where, /factory plan, /factory run [id], /factory stop, /factory answer <id> [text], /factory reject <id> <reason>',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const model = await read($, panel)
    const columns = Math.max(1, e.props.bodyColumns ?? e.viewport?.columns ?? 60)
    const rows = rowsOf(model, columns, await $.clock.now())

    return (
      <Box flexDirection="column">
        {rows.map(row => {
          if (row.cells) {
            return (
              <Text>
                {row.cells.map((cell, i) => (
                  <Text bold={cell.tone === 'head'} dimColor={cell.tone === 'dim'} color={COLOR[cell.tone]}>
                    {(i > 0 ? ' ' : '') + cell.text}
                  </Text>
                ))}
              </Text>
            )
          }
          const gap = Math.max(1, columns - displayWidth(row.left) - displayWidth(row.right))

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
