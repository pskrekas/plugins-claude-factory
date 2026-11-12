import { expect, test } from 'claude-code/testing'

import { storeKey } from '../core/consent'
import { gateCommands } from '../hooks/gate'
import { START, cmd, engine, fakeIo, paneText } from './kit'

const SETTINGS = JSON.stringify({
  checks: [{ name: 'a', run: ['x', 'y'] }],
  gate: { fast: [['npm', 'test']], full: [['npm', 'test'], ['npm', 'run', 'build']] },
})

test('the pane lists the gate commands with their mark, and approving them never runs them as checks', async ($, on) => {
  const world = engine(on, {
    files: { '/r/.claude/factory.json': SETTINGS },
    run: argv => (argv[0] === 'x' ? { exitCode: 0, stdout: '' } : undefined),
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows).toContain('SETTINGS NOT APPROVED · 3 commands')
  expect(rows).toContain('[gate] npm test')
  expect(rows).toContain('[gate] npm run build')
  expect((await $.command.run(cmd('approve'))).text).toBe('Approved 3 commands.')
  expect(world.ran).toContain('x y')
  expect(world.ran.some(line => line.startsWith('npm'))).toBe(false)
})

// The settings file of the base branch: its ref is read by its full name, then
// the file by that commit's id.
const BASE = 'f'.repeat(40)
const onBase = (text: string | null) => (argv: string[]) => {
  const line = argv.join(' ')
  if (line === 'git rev-parse --verify refs/remotes/origin/main^{commit}') return { exitCode: 0, stdout: BASE + '\n' }
  if (line !== `git show ${BASE}:.claude/factory.json`) return undefined

  return text === null ? { exitCode: 128, stdout: '', stderr: 'fatal: path does not exist' } : { exitCode: 0, stdout: text }
}

function ioWith(base: string | null, approved: string[]) {
  const io = fakeIo({ files: { '/r/x': '' } })
  io.answer = onBase(base)
  io.store.set(storeKey('/r'), approved)

  return io
}

test("the gate's commands are the base branch's, when they are approved", async () => {
  const io = ioWith(SETTINGS, ['[gate] npm run build', '[gate] npm test', 'x y'])
  expect(await gateCommands(io, '/r', 'main', 'fast')).toEqual({
    ok: true,
    commands: [['npm', 'test']],
    baseSha: BASE,
    // The protected paths are the base branch's too.
    protectedPaths: ['.claude/factory.json'],
  })
  expect(await gateCommands(io, '/r', 'main', 'full')).toEqual(
    expect.objectContaining({ ok: true, commands: [['npm', 'test'], ['npm', 'run', 'build']] }),
  )
})

test('a gate command approved only as a check does not run in the gate', async () => {
  expect(await gateCommands(ioWith(SETTINGS, ['npm test', 'x y']), '/r', 'main', 'fast')).toEqual({
    ok: false,
    why: 'gate commands are not approved',
  })
  expect(await gateCommands(ioWith(SETTINGS, ['[gate] npm test']), '/r', 'main', 'full')).toEqual({
    ok: false,
    why: 'gate commands are not approved',
  })
})

test('why there is no gate', async () => {
  const none = JSON.stringify({ gate: { fast: [], full: [['npm', 'test']] } })
  expect(await gateCommands(ioWith(none, []), '/r', 'main', 'fast')).toEqual({ ok: false, why: 'no gate' })
  expect(await gateCommands(ioWith(null, []), '/r', 'main', 'fast')).toEqual({ ok: false, why: 'no settings file on main' })
  expect(await gateCommands(ioWith('{ nope', []), '/r', 'main', 'fast')).toEqual({
    ok: false,
    why: 'settings on main: not valid JSON',
  })
  expect(await gateCommands(ioWith('x'.repeat(300_000), []), '/r', 'main', 'fast')).toEqual({
    ok: false,
    why: 'settings on main: too large',
  })
  expect(await gateCommands(ioWith(SETTINGS, []), '/r', 'gone', 'fast')).toEqual({ ok: false, why: 'no branch origin/gone' })
  const bad = ioWith(SETTINGS, [])
  expect(await gateCommands(bad, '/r', '--upload-pack=x', 'fast')).toEqual({ ok: false, why: 'not a branch name' })
  expect(bad.ran).toEqual([])
})

test("a job's own settings file cannot change the gate", async () => {
  // The working tree's file names another command; the base branch's is used.
  const io = ioWith(SETTINGS, ['[gate] npm run build', '[gate] npm test', 'x y'])
  io.files['/r/.claude/factory.json'] = JSON.stringify({ gate: { fast: [['true']] } })

  expect(await gateCommands(io, '/r', 'main', 'fast')).toEqual(expect.objectContaining({ ok: true, commands: [['npm', 'test']] }))
  expect(io.reads).not.toContain('/r/.claude/factory.json')
})
