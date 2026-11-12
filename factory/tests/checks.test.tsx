import { expect, test } from 'claude-code/testing'

import { judgeCheck, judgeDisk, judgePort, parseDfFreeGb } from '../core/checks'
import { START, cmd, engine, paneText } from './kit'

const ran = (exitCode: number, stdout: string) => ({ exitCode, stdout, stderr: '' })

test('a check with a wanted value', async () => {
  const spec = { name: 'cloud account', run: ['x'], want: 'me@example.com' }
  expect(judgeCheck(spec, ran(0, 'me@example.com\n'))).toEqual({ name: 'cloud account', state: 'ok' })
  expect(judgeCheck(spec, ran(0, 'other@example.com\n'))).toEqual({
    name: 'cloud account',
    state: 'wrong',
    got: 'other@example.com',
  })
  expect(judgeCheck(spec, ran(0, ''))).toEqual({ name: 'cloud account', state: 'wrong', got: '(nothing)' })
})

test('a check with no wanted value passes on exit 0', async () => {
  expect(judgeCheck({ name: 'a', run: ['x'] }, ran(0, 'anything'))).toEqual({ name: 'a', state: 'ok' })
  expect(judgeCheck({ name: 'a', run: ['x'] }, ran(3, ''))).toEqual({
    name: 'a',
    state: 'wrong',
    got: 'exit 3',
  })
})

test('long output is cut to 200 characters', async () => {
  const check = judgeCheck({ name: 'a', run: ['x'], want: 'y' }, ran(0, 'z'.repeat(5000)))
  expect(check.got?.length).toBe(200)
})

test('a command that hangs or is missing is an error, not a crash', async () => {
  expect(judgeCheck({ name: 'a', run: ['x'] }, { failed: 'timeout' })).toEqual({
    name: 'a',
    state: 'error',
    got: 'timeout',
  })
  expect(judgeCheck({ name: 'a', run: ['x'] }, { failed: 'not-found' }).got).toBe('not found')
  expect(judgeCheck({ name: 'a', run: ['x'] }, { failed: 'other' }).got).toBe('failed')
})

test('df output gives free GiB', async () => {
  const out =
    'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/d1 482797652 424673280 34603008 93% /\n'
  expect(parseDfFreeGb(out)).toBe(33)
  expect(parseDfFreeGb('garbage')).toBe(null)
  expect(parseDfFreeGb('')).toBe(null)
})

test('disk and port judging', async () => {
  expect(judgeDisk({ name: 'disk', minFreeGb: 40 }, 33)).toEqual({
    name: 'disk',
    state: 'wrong',
    got: '33 GB free',
  })
  expect(judgeDisk({ name: 'disk', minFreeGb: 10 }, 33)).toEqual({ name: 'disk', state: 'ok' })
  expect(judgeDisk({ name: 'disk', minFreeGb: 10 }, null)).toEqual({ name: 'disk', state: 'unknown' })
  expect(judgePort('database', 5432, ran(0, ''))).toEqual({ name: 'database', port: 5432, state: 'up' })
  expect(judgePort('database', 5432, ran(1, ''))).toEqual({ name: 'database', port: 5432, state: 'down' })
  expect(judgePort('database', 5432, { failed: 'not-found' })).toEqual({
    name: 'database',
    port: 5432,
    state: 'unknown',
  })
})

const SETTINGS = JSON.stringify({
  checks: [
    { name: 'cloud account', run: ['cloud', 'whoami'], want: 'me@example.com' },
    { name: 'disk', minFreeGb: 10 },
  ],
  ports: { database: 5432 },
})

const DF = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/d1 1 1 34603008 93% /\n'

async function approved($: Parameters<typeof paneText>[0]) {
  await $.session.start(START)
  await $.command.run(cmd(''))
  await $.command.run(cmd('approve'))
}

test('approved checks run and show their result', async ($, on) => {
  const world = engine(on, {
    files: { '/r/.claude/factory.json': SETTINGS },
    run: argv => {
      if (argv[0] === 'cloud') return { exitCode: 0, stdout: 'me@example.com\n' }
      if (argv[0] === 'df') return { exitCode: 0, stdout: DF }
      if (argv[0] === 'nc') return { exitCode: 1, stdout: '' }

      return undefined
    },
  })
  await approved($)

  const rows = await paneText($)
  expect(rows.find(row => /^cloud account\s+ok$/.test(row))).toBeDefined()
  expect(rows.find(row => /^disk\s+ok$/.test(row))).toBeDefined()
  expect(rows.find(row => /^database :5432\s+DOWN$/.test(row))).toBeDefined()
  expect(world.ran).toContain('cloud whoami')
  expect(world.ran).toContain('df -Pk /r')
  expect(world.ran).toContain('nc -z -w 1 127.0.0.1 5432')
})

test('a check whose command cannot start shows error and the rest still draws', async ($, on) => {
  engine(on, {
    files: { '/r/.claude/factory.json': SETTINGS, '/r/.claude/owed.md': '- [ ] x' },
    run: argv => (argv[0] === 'df' ? { exitCode: 0, stdout: DF } : undefined),
  })
  await approved($)

  const rows = await paneText($)
  expect(rows.find(row => /^cloud account\s+error$/.test(row))).toBeDefined()
  expect(rows.find(row => /^disk\s+ok$/.test(row))).toBeDefined()
  expect(rows.find(row => /^database :5432\s+\?$/.test(row))).toBeDefined()
})

test('nothing runs before the settings are approved', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': SETTINGS } })
  await $.session.start(START)
  await $.command.run(cmd(''))

  expect(world.ran).toEqual([])
  expect(await paneText($)).not.toContain('CHECKS')
})
