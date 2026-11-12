import { expect, test } from 'claude-code/testing'

import { START, cmd, engine, paneText, settingsRuns } from './kit'

const CHECK = '{"checks":[{"name":"a","run":["x"]}]}'
const NOT_YET = 'Not approved yet. The panel shows 1 command. Read it, then run /factory approve again.'
const CHANGED =
  'The settings file changed. The panel now shows 1 command. Read it, then run /factory approve again.'

test('a settings file with a check asks for approval and runs nothing', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)

  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows).toContain('SETTINGS NOT APPROVED · 1 command')
  expect(rows).toContain('x')
  expect(settingsRuns(world)).toEqual([])
})

test('approve allows the commands the panel showed, and its answer holds no command text', async ($, on) => {
  const world = engine(on, {
    files: { '/r/.claude/factory.json': CHECK },
    run: argv => (argv[0] === 'x' ? { exitCode: 0, stdout: '' } : undefined),
  })
  await $.session.start(START)

  await $.command.run(cmd(''))
  expect((await $.command.run(cmd('approve'))).text).toBe('Approved 1 command.')
  expect((await paneText($)).some(row => row.startsWith('SETTINGS NOT APPROVED'))).toBe(false)
  expect(world.ran).toContain('x')
})

test('approve before the commands were shown opens the panel and approves nothing', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)

  expect((await $.command.run(cmd('approve'))).text).toBe(NOT_YET)
  expect(world.isOpen).toBe(true)
  expect(settingsRuns(world)).toEqual([])
  expect((await $.command.run(cmd('approve'))).text).toBe('Approved 1 command.')
})

test('a pane that is open but not drawn has shown nothing', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  // Opened unasked on a narrow terminal: open, and not placed.
  world.isPlaced = false
  await $.session.start(START)
  await $.command.run(cmd(''))
  await world.clock.advance(60_000)

  expect((await $.command.run(cmd('approve'))).text).toBe(
    'The panel is not on screen, so nothing was approved. Run /factory, read the commands, then run /factory approve.',
  )
  expect(settingsRuns(world)).toEqual([])

  // The person opens it: now it is drawn, and the two steps work.
  world.isPlaced = true
  expect((await $.command.run(cmd('approve'))).text).toBe(NOT_YET)
  expect((await $.command.run(cmd('approve'))).text).toBe('Approved 1 command.')
})

test('a pane that is a hidden tab is not read each minute and shows nothing', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)
  await $.command.run(cmd(''))

  world.isShownTab = false
  world.files['/r/.claude/factory.json'] = '{"checks":[{"name":"a","run":["y"]}]}'
  const before = world.status.length
  await world.clock.advance(60_000)
  expect(world.status.length).toBe(before)

  world.isShownTab = true
  expect((await $.command.run(cmd('approve'))).text).toBe(CHANGED)
  expect(settingsRuns(world)).toEqual([])
})

test('only a person at the prompt can approve', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)
  await $.command.run(cmd(''))

  for (const kind of ['plugin', 'sdk', 'peer', 'channel', 'scheduled-trigger', 'bridge']) {
    expect((await $.command.run(cmd('approve', kind))).text).toBe(
      'Only a person can approve. Type /factory approve at the prompt.',
    )
  }
  expect((await paneText($))[0]).toBe('SETTINGS NOT APPROVED · 1 command')
  expect(settingsRuns(world)).toEqual([])
})

test('a changed command asks again', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)

  await $.command.run(cmd(''))
  await $.command.run(cmd('approve'))
  world.files['/r/.claude/factory.json'] = '{"checks":[{"name":"a","run":["x","--force"]}]}'
  await $.command.run(cmd(''))

  const rows = await paneText($)
  expect(rows).toContain('SETTINGS NOT APPROVED · 1 command')
  expect(rows).toContain('x --force')
})

test('a file that changes after it was shown is not approved by the old screen', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': CHECK } })
  await $.session.start(START)

  await $.command.run(cmd(''))
  world.files['/r/.claude/factory.json'] = '{"checks":[{"name":"a","run":["y"]}]}'

  expect((await $.command.run(cmd('approve'))).text).toBe(CHANGED)
  expect(await paneText($)).toContain('y')
  expect(settingsRuns(world)).toEqual([])
})

test('approve with nothing to approve says so', async ($, on) => {
  engine(on, { files: {} })
  await $.session.start(START)

  expect((await $.command.run(cmd('approve'))).text).toBe('Nothing to approve.')
})

test('broken settings show one line and the pane still draws', async ($, on) => {
  engine(on, { files: { '/r/.claude/factory.json': '{ nope' } })
  await $.session.start(START)

  await $.command.run(cmd(''))

  expect(await paneText($)).toContain('settings: not valid JSON')
})

test('a read sets the time and the status line', async ($, on) => {
  const world = engine(on, { files: {}, now: 7000 })
  await $.session.start(START)

  await $.command.run(cmd(''))

  expect(await paneText($)).toContain('read 0 s ago')
  expect(world.status.length).toBeGreaterThan(0)
})

test('commands shown for one repo are never approved for another', async ($, on) => {
  const world = engine(on, {
    files: {
      '/r/.claude/factory.json': CHECK,
      '/other/.claude/factory.json': '{"checks":[{"name":"a","run":["evil"]}]}',
    },
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  // The session moves to another repo after the panel showed the first one's command.
  world.root = '/other'
  expect((await $.command.run(cmd('approve'))).text).toBe(NOT_YET)
  expect(settingsRuns(world)).toEqual([])
  expect((await $.command.run(cmd('approve'))).text).toBe('Approved 1 command.')

  // The first repo's command was shown, but never approved.
  world.root = '/r'
  await $.command.run(cmd(''))
  expect((await paneText($))[0]).toBe('SETTINGS NOT APPROVED · 1 command')
  expect(world.ran).not.toContain('x')
})

test('in a linked worktree the panel reads the worktree, and an approval covers every checkout of the repo', async ($, on) => {
  const world = engine(on, {
    files: {
      '/wt/.claude/factory.json': CHECK,
      '/r/.claude/factory.json': CHECK,
      '/r/.claude/owed.md': '- [ ] main only',
      // A linked worktree: its `.git` is a file, and the main checkout points back.
      '/r/.git/HEAD': 'ref: refs/heads/main',
      '/wt/.git': 'gitdir: /r/.git/worktrees/wt\n',
      '/r/.git/worktrees/wt/gitdir': '/wt/.git\n',
    },
    run: argv => {
      if (argv[0] === 'x') return { exitCode: 0, stdout: '' }
      if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: 'feat/wt\n' }

      return undefined
    },
  })
  world.root = '/wt'
  world.repoRoot = '/r'
  await $.session.start(START)
  await $.command.run(cmd(''))
  await $.command.run(cmd('approve'))

  expect(world.ran).toContain('x')
  expect(world.cwds.every(cwd => cwd === '/wt')).toBe(true)
  expect(world.reads.some(path => path.startsWith('/r/') && !path.startsWith('/r/.git/'))).toBe(false)

  // The main checkout has the same line: nothing more to approve there.
  world.root = '/r'
  world.repoRoot = null
  await $.command.run(cmd(''))
  expect((await paneText($)).some(row => row.startsWith('SETTINGS NOT APPROVED'))).toBe(false)
})

test('an approval never covers another repository that sits inside this one', async ($, on) => {
  const world = engine(on, {
    files: {
      '/main/.claude/factory.json': CHECK,
      '/main/.git/HEAD': 'x',
      '/main/vendor/other/.claude/factory.json': CHECK,
      '/main/vendor/other/.git/HEAD': 'x',
    },
    run: argv => (argv[0] === 'x' ? { exitCode: 0, stdout: '' } : undefined),
  })
  world.root = '/main'
  await $.session.start(START)
  await $.command.run(cmd(''))
  await $.command.run(cmd('approve'))
  expect(world.ran.filter(line => line === 'x').length).toBe(1)

  // A different repository, cloned inside: the same command line, another repo.
  // The session still names the outer repository as "the repo".
  world.root = '/main/vendor/other'
  world.repoRoot = '/main'
  await $.command.run(cmd(''))

  expect((await paneText($))[0]).toBe('SETTINGS NOT APPROVED · 1 command')
  expect(world.ran.filter(line => line === 'x').length).toBe(1)
})

test('a folder that only claims to be a worktree of a repo does not get its approvals', async ($, on) => {
  const world = engine(on, {
    files: {
      '/main/.claude/factory.json': CHECK,
      '/main/.git/HEAD': 'x',
      '/main/.git/worktrees/real/gitdir': '/main-wt/.git\n',
      // Unpacked from an archive: its `.git` file points into the person's own repo.
      '/evil/.claude/factory.json': CHECK,
      '/evil/.git': 'gitdir: /main/.git/worktrees/real\n',
    },
    run: argv => (argv[0] === 'x' ? { exitCode: 0, stdout: '' } : undefined),
  })
  world.root = '/main'
  await $.session.start(START)
  await $.command.run(cmd(''))
  await $.command.run(cmd('approve'))
  expect(world.ran.filter(line => line === 'x').length).toBe(1)

  world.root = '/evil'
  world.repoRoot = '/main'
  await $.command.run(cmd(''))

  expect((await paneText($))[0]).toBe('SETTINGS NOT APPROVED · 1 command')
  expect(world.ran.filter(line => line === 'x').length).toBe(1)
})
