import { expect, test } from 'claude-code/testing'

import { agentRows, parseMerged, parseWorktrees } from '../core/work'
import { START, cmd, engine, paneText } from './kit'

const PORCELAIN =
  'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/wt/a\nHEAD def\nbranch refs/heads/feat-a\n\nworktree /r/wt/b\nHEAD 123\ndetached\n'

test('worktrees with merged marks', async () => {
  expect(parseWorktrees(PORCELAIN, ['main', 'feat-a'], 'main')).toEqual([
    { path: '/r', branch: 'main', isMerged: false },
    { path: '/r/wt/a', branch: 'feat-a', isMerged: true },
    { path: '/r/wt/b', branch: null, isMerged: false },
  ])
  expect(parseWorktrees('', [], 'main')).toEqual([])
})

test('merged branch list', async () => {
  expect(parseMerged('main\nfeat-a\n')).toEqual(['main', 'feat-a'])
  expect(parseMerged('* main\n  feat-a\n+ feat-b\n')).toEqual(['main', 'feat-a', 'feat-b'])
})

const agent = (id: string, status: string, description = 'Build the thing') => ({
  id,
  description,
  type: 'builder',
  status,
})

test('agent rows keep the first time an agent was seen', async () => {
  const before = agentRows([agent('a', 'running')] as never, [], 1000)
  expect(before).toEqual([
    { id: 'a', label: 'Build the thing', kind: 'builder', isRunning: true, startedAt: 1000 },
  ])
  const after = agentRows([agent('a', 'running'), agent('b', 'pending')] as never, before, 9000)
  expect(after.map(row => [row.id, row.startedAt])).toEqual([
    ['a', 1000],
    ['b', 9000],
  ])
})

test('running agents come first, then at most three that ended, with short labels', async () => {
  const list = [
    agent('e1', 'completed'),
    agent('e2', 'failed'),
    agent('r1', 'waiting', 'x'.repeat(100)),
    agent('e3', 'killed'),
    agent('e4', 'completed'),
  ]
  const rows = agentRows(list as never, [], 0)
  expect(rows.map(row => row.id)).toEqual(['r1', 'e1', 'e2', 'e3'])
  expect(rows[0]?.isRunning).toBe(true)
  expect(rows[1]?.isRunning).toBe(false)
  expect(rows[0]?.label.length).toBe(40)
})

function git(argv: readonly string[]) {
  if (argv[0] !== 'git') return undefined
  if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: 'main\n' }
  if (argv[1] === 'worktree') return { exitCode: 0, stdout: PORCELAIN }
  if (argv[1] === 'branch') return { exitCode: 0, stdout: 'main\nfeat-a\n' }

  return undefined
}

test('the pane counts the worktrees and the merged ones', async ($, on) => {
  const world = engine(on, { files: {}, run: git })
  await $.session.start(START)
  await $.command.run(cmd(''))

  expect(await paneText($, 60)).toContain('WORKTREES 3 · 1 merged, remove?')
  expect(world.ran).toContain('git worktree list --porcelain')
  expect(world.ran).toContain('git branch --merged main --format=%(refname:short)')
})

test('a new agent shows at once, without the slow reads', async ($, on) => {
  const world = engine(on, { files: {}, run: git })
  await $.session.start(START)
  await $.command.run(cmd(''))
  expect(await paneText($, 60)).not.toContain('AGENTS')

  const ranBefore = world.ran.length
  world.agents.push(agent('a1', 'running', 'Build the login page'))
  await $.agent.spawn({ prompt: 'p', description: 'd' } as never)
  await world.clock.settle()

  const rows = await paneText($, 60)
  expect(rows).toContain('AGENTS')
  expect(rows.find(row => row.startsWith('Build the login page builder'))).toBeDefined()
  expect(world.ran.length).toBe(ranBefore)
})

test('outside a git repo there are no worktrees and no error', async ($, on) => {
  engine(on, { files: {}, run: () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }) })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows).not.toContain('MORE')
  expect(rows.some(row => row.includes('failed'))).toBe(false)
})
