import { expect, test } from 'claude-code/testing'

import { draftSettings } from '../core/init'
import { parseSettings } from '../core/settings'
import { START, cmd, engine } from './kit'

const facts = { remote: null, baseBranch: null, packageJson: null, hasPyproject: false }

test('a GitHub repo with npm scripts', async () => {
  const draft = draftSettings({
    ...facts,
    remote: 'git@github.com:a/b.git',
    baseBranch: 'main',
    packageJson: JSON.stringify({ scripts: { lint: 'x', test: 'y', build: 'z' } }),
  })
  const { settings, error } = parseSettings(draft)
  expect(error).toBe(null)
  expect(settings.tracker).toEqual({ kind: 'github', mark: 'factory', project: null, mcp: null })
  expect(settings.gate).toEqual({
    // The gate runs in a clean copy of the commit, so the install comes first.
    fast: [['npm', 'install'], ['npm', 'run', 'lint'], ['npm', 'test']],
    full: [['npm', 'install'], ['npm', 'run', 'lint'], ['npm', 'test'], ['npm', 'run', 'build']],
  })
  // Where the builder's and the gate's commands run: a container with the repo's kind of tools.
  expect(settings.factory.container).toEqual({ image: 'node:22', network: 'on', memory: '4g', cpus: 2 })
  expect(settings.checks).toEqual([{ name: 'disk', minFreeGb: 10 }])
  expect(settings.progress?.files).toBe('docs/plans/*/progress.md')
  expect(settings.owed).toBe('.claude/owed.md')
  expect(draft.endsWith('}\n')).toBe(true)
})

test('a Python repo with another remote', async () => {
  const { settings, error } = parseSettings(
    draftSettings({ ...facts, remote: 'https://example.com/r.git', baseBranch: 'dev', hasPyproject: true }),
  )
  expect(error).toBe(null)
  expect(settings.tracker).toBe(null)
  expect(settings.baseBranch).toBe('dev')
  expect(settings.gate.fast).toEqual([['python3', '-m', 'pytest', '-q']])
  expect(settings.factory.container).toEqual({ image: 'python:3.12', network: 'on', memory: '4g', cpus: 2 })
})

test('an Azure DevOps repo gets Azure Boards as its tracker, with the project of the remote', async () => {
  const { settings, error } = parseSettings(draftSettings({ ...facts, remote: 'https://dev.azure.com/acme/My%20Shop/_git/web', hasPyproject: true }))
  expect(error).toBe(null)
  expect(settings.tracker).toEqual({ kind: 'azure-boards', mark: 'factory', project: 'My Shop', mcp: null })
  // A remote that only looks like one gets no tracker.
  expect(parseSettings(draftSettings({ ...facts, remote: 'https://dev.azure.com/acme/x' })).settings.tracker).toBe(null)
})

test('an unknown repo gets no gate, and a strange base branch falls back to main', async () => {
  const { settings, error } = parseSettings(
    draftSettings({ ...facts, baseBranch: '--evil', packageJson: 'not json' }),
  )
  expect(error).toBe(null)
  expect(settings.gate).toEqual({ fast: [], full: [] })
  // No image is guessed: the person names one (the line does not run without).
  expect(settings.factory.container).toBe(null)
  expect(settings.baseBranch).toBe('main')
})

function git(argv: readonly string[]) {
  if (argv[1] === 'symbolic-ref') return { exitCode: 0, stdout: 'origin/develop\n' }
  if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: 'feat/x\n' }

  return undefined
}

test('/factory init writes a first settings file, which then waits for approval', async ($, on) => {
  const world = engine(on, {
    files: { '/r/package.json': '{"scripts": {"test": "jest"}}' },
    remote: 'https://github.com/a/b.git',
    run: git,
  })
  await $.session.start(START)

  expect((await $.command.run(cmd('init'))).text).toBe(
    'Wrote .claude/factory.json. Read it, then run /factory approve.',
  )
  expect(world.writes).toEqual(['/r/.claude/factory.json'])
  const { settings, error } = parseSettings(world.files['/r/.claude/factory.json'] ?? null)
  expect(error).toBe(null)
  expect(settings.baseBranch).toBe('develop')
  expect(settings.gate.fast).toEqual([['npm', 'install'], ['npm', 'test']])
  expect(world.ran).not.toContain('npm test')
})

test('/factory init never overwrites a settings file', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': '{}' }, run: git })
  await $.session.start(START)

  expect((await $.command.run(cmd('init'))).text).toBe('.claude/factory.json exists. Edit it by hand.')
  expect(world.writes).toEqual([])
})

test('/factory init does not write through a link', async ($, on) => {
  const world = engine(on, {
    files: {},
    links: { '/r/.claude/factory.json': '/elsewhere/new.json' },
    run: git,
  })
  await $.session.start(START)

  expect((await $.command.run(cmd('init'))).text).toBe(
    '.claude/factory.json is a link. It is not written.',
  )
  expect(world.writes).toEqual([])
})

test('an unknown argument lists the commands', async ($, on) => {
  engine(on, { files: {} })
  await $.session.start(START)

  expect((await $.command.run(cmd('nope'))).text).toBe(
    'Commands: /factory, /factory close, /factory init, /factory approve, /factory where, /factory plan, /factory run [id], /factory stop, /factory answer <id> [text], /factory reject <id> <reason>',
  )
})
