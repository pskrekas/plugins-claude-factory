import { expect, test } from 'claude-code/testing'

import { parseGhIssue } from '../adapters/github-issues'
import { parseGhPr } from '../adapters/github-pr'
import { githubRepoOf, prHostOf, repoOf, ticketOf, toolNote } from '../core/task'
import { START, cmd, engine, paneText } from './kit'

test('ticket id from a branch', async () => {
  expect(ticketOf('feat/PROJ-12-dark-mode', 'PROJ-\\d+')).toBe('PROJ-12')
  expect(ticketOf('issue-12-x', 'issue-(\\d+)')).toBe('12')
  expect(ticketOf('main', 'PROJ-\\d+')).toBe(null)
  expect(ticketOf('x', null)).toBe(null)
})

test('the GitHub repository of a remote, as owner/name', async () => {
  expect(repoOf('git@github.com:a/b.git')).toBe('a/b')
  expect(repoOf('https://github.com/Some-Org/my.repo')).toBe('Some-Org/my.repo')
  expect(repoOf('ssh://git@github.com/a/b.git')).toBe('a/b')
  expect(repoOf('https://user@github.com/a/b.git/')).toBe('a/b')
  for (const remote of ['https://example.com/a/b.git', 'git@github.com:a.git', 'git@github.com:-x/b.git', 'https://github.com/a/b/c', 'https://github.com.evil.example/a/b', '', null]) {
    expect(repoOf(remote)).toBe(null)
  }
})

test('PR host from the remote', async () => {
  expect(prHostOf('git@github.com:a/b.git', 'auto')).toBe('github')
  expect(prHostOf('https://github.com/a/b.git', 'auto')).toBe('github')
  expect(prHostOf('https://dev.azure.com/o/p/_git/r', 'auto')).toBe('azure-repos')
  expect(prHostOf('https://o.visualstudio.com/p/_git/r', 'auto')).toBe('azure-repos')
  expect(prHostOf('https://example.com/r.git', 'auto')).toBe(null)
  expect(prHostOf('https://github.com.evil.example/a/b.git', 'auto')).toBe(null)
  expect(prHostOf(null, 'auto')).toBe(null)
  expect(prHostOf(null, 'github')).toBe('github')
})

const ISSUE = JSON.stringify({
  number: 12,
  title: 'Add dark mode',
  state: 'OPEN',
  body: 'b',
  url: 'u',
  author: { login: 'ann' },
  comments: [{ author: { login: 'bob' }, body: 'c' }],
})

test('gh issue JSON', async () => {
  expect(parseGhIssue(ISSUE)).toEqual({
    id: '12',
    title: 'Add dark mode',
    state: 'open',
    text: 'b',
    author: 'ann',
    url: 'u',
    comments: [{ author: 'bob', text: 'c' }],
  })
  expect(parseGhIssue('not json')).toBe(null)
  expect(parseGhIssue('{"number": "x"}')).toBe(null)
  expect(parseGhIssue('[]')).toBe(null)
})

const pr = (extra: object) =>
  JSON.stringify({
    number: 51,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    url: 'u',
    statusCheckRollup: [],
    ...extra,
  })

test('gh PR JSON', async () => {
  expect(parseGhPr(pr({}))).toEqual({
    number: 51,
    state: 'open',
    isDraft: false,
    build: 'none',
    approvals: 1,
    url: 'u',
  })
  const rollup = (...entries: object[]) => parseGhPr(pr({ statusCheckRollup: entries }))?.build
  expect(rollup({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('green')
  expect(rollup({ status: 'IN_PROGRESS' })).toBe('running')
  expect(rollup({ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' })).toBe('red')
  // A commit status has `state`, not `status` and `conclusion`.
  expect(rollup({ state: 'SUCCESS' })).toBe('green')
  expect(rollup({ state: 'PENDING' })).toBe('running')
  expect(rollup({ state: 'ERROR' })).toBe('red')
  expect(parseGhPr(pr({ state: 'MERGED', reviewDecision: '' }))?.state).toBe('merged')
  expect(parseGhPr(pr({ reviewDecision: 'REVIEW_REQUIRED' }))?.approvals).toBe(0)
  expect(parseGhPr('')).toBe(null)
  expect(parseGhPr('{"number": 1, "state": "WEIRD"}')).toBe(null)
})

test('a gh that cannot start, is slow or is logged out gives a plain note', async () => {
  expect(toolNote({ failed: 'not-found' })).toBe('gh could not start. Is it installed?')
  expect(toolNote({ failed: 'other' })).toBe('gh could not start. Is it installed?')
  expect(toolNote({ failed: 'timeout' })).toBe('gh did not answer in time')
  expect(
    toolNote({ exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }),
  ).toBe('gh is not logged in. Run: gh auth login')
  expect(toolNote({ exitCode: 1, stdout: '', stderr: 'no pull requests found' })).toBe(null)
  expect(toolNote({ exitCode: 0, stdout: '{}', stderr: '' })).toBe(null)
  expect(toolNote(null)).toBe(null)
})

const SETTINGS = '{"ticketPattern": "PROJ-(\\\\d+)", "tracker": {"kind": "github"}}'

function gh(argv: readonly string[]) {
  if (argv[0] === 'git' && argv[1] === 'rev-parse') return { exitCode: 0, stdout: 'feat/PROJ-12-x\n' }
  if (argv[0] === 'gh' && argv[1] === 'issue') return { exitCode: 0, stdout: ISSUE }
  if (argv[0] === 'gh' && argv[1] === 'pr') return { exitCode: 0, stdout: pr({}) }

  return undefined
}

test('the pane shows the issue of the branch and its pull request', async ($, on) => {
  const world = engine(on, {
    files: { '/r/.claude/factory.json': SETTINGS },
    remote: 'git@github.com:a/b.git',
    run: gh,
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows).toContain('TASK')
  expect(rows.find(row => /^12 Add dark mode\s+open$/.test(row))).toBeDefined()
  expect(rows.find(row => /^PR 51 · build none · 1 approval$/.test(row))).toBeDefined()
  expect(world.ran).toContain('gh issue view 12 --json number,title,state,body,author,comments,url')
})

test('with no settings file the branch and its pull request still show', async ($, on) => {
  engine(on, { files: {}, remote: 'https://github.com/a/b.git', run: gh })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows).toContain('feat/PROJ-12-x')
  expect(rows.find(row => row.startsWith('PR 51'))).toBeDefined()
})

test('a missing gh shows one note and the other sections still draw', async ($, on) => {
  engine(on, {
    files: { '/r/.claude/factory.json': SETTINGS },
    remote: 'git@github.com:a/b.git',
    run: argv => (argv[0] === 'git' ? gh(argv) : undefined),
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows).toContain('12')
  expect(rows).toContain('gh could not start. Is it installed?')
})

test('a branch with no pull request shows no note', async ($, on) => {
  engine(on, {
    files: {},
    remote: 'git@github.com:a/b.git',
    run: argv =>
      argv[0] === 'gh'
        ? { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "x"' }
        : gh(argv),
  })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows).toContain('feat/PROJ-12-x')
  expect(rows.some(row => row.includes('gh is'))).toBe(false)
})

const AZ_SETTINGS = '{"ticketPattern": "PROJ-(\\\\d+)", "tracker": {"kind": "azure-boards"}}'
const AZ_REMOTE = 'https://dev.azure.com/acme/Shop/_git/web'
function az(argv: readonly string[]) {
  const line = argv.join(' ')
  if (argv[0] === 'git') return gh(argv)
  if (line.startsWith('az boards work-item show --id 12 ')) return { exitCode: 0, stdout: JSON.stringify({ id: 12, fields: { 'System.Title': 'Add dark mode', 'System.State': 'Active', 'System.Description': '<div>x</div>' } }) }
  if (line.startsWith('az devops invoke --area wit')) return { exitCode: 0, stdout: '{"comments": []}' }
  if (line.startsWith('az repos pr list --source-branch feat/PROJ-12-x ')) return { exitCode: 0, stdout: JSON.stringify([{ pullRequestId: 51, status: 'active', isDraft: false, reviewers: [{ vote: 10 }] }]) }
  if (line.startsWith('az repos pr policy list --id 51 ')) return { exitCode: 0, stdout: JSON.stringify([{ status: 'approved', configuration: { isEnabled: true } }]) }
  if (line.startsWith('az boards query')) return { exitCode: 0, stdout: '[]' }

  return undefined
}

test('with an Azure DevOps remote the pane shows the work item of the branch and its pull request', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': AZ_SETTINGS }, remote: AZ_REMOTE, run: az })
  await $.session.start(START)
  await $.command.run(cmd(''))

  const rows = await paneText($, 60)
  expect(rows.find(row => /^12 Add dark mode\s+active$/.test(row))).toBeDefined()
  expect(rows.find(row => row.startsWith('PR 51 · build green · 1 approval'))).toBeDefined()
  expect(world.ran.some(line => line.startsWith('gh '))).toBe(false)
  // Every az call names the organization and lets az detect nothing.
  const calls = world.ran.filter(line => line.startsWith('az '))
  expect(calls.length).toBeGreaterThan(1)
  expect(calls.every(line => line.includes('--org https://dev.azure.com/acme --detect false'))).toBe(true)
})

test('with no settings file an Azure DevOps remote still shows the pull request of the branch', async ($, on) => {
  engine(on, { files: {}, remote: AZ_REMOTE, run: az })
  await $.session.start(START)
  await $.command.run(cmd(''))
  expect((await paneText($, 60)).find(row => row.startsWith('PR 51'))).toBeDefined()
})

test('a missing az, or an az with no login, shows one note', async ($, on) => {
  engine(on, { files: { '/r/.claude/factory.json': AZ_SETTINGS }, remote: AZ_REMOTE, run: argv => (argv[0] === 'git' ? gh(argv) : undefined) })
  await $.session.start(START)
  await $.command.run(cmd(''))
  expect(await paneText($, 60)).toContain('az could not start. Is it installed?')
})

test('an az that is not logged in says what to run', async ($, on) => {
  engine(on, {
    files: { '/r/.claude/factory.json': AZ_SETTINGS },
    remote: AZ_REMOTE,
    run: argv => (argv[0] === 'git' ? gh(argv) : { exitCode: 1, stdout: '', stderr: 'Before you can run Azure DevOps commands, you need to run the login command (az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.' }),
  })
  await $.session.start(START)
  await $.command.run(cmd(''))
  expect(await paneText($, 60)).toContain('az is not logged in. Run: az login')
})

test('GitHub Issues with code on Azure Repos: the settings name the GitHub repository', async () => {
  expect(githubRepoOf('git@github.com:a/b.git', null)).toBe('a/b')
  expect(githubRepoOf('git@github.com:a/b.git', 'c/d')).toBe('a/b')
  expect(githubRepoOf(AZ_REMOTE, 'c/d')).toBe('c/d')
  for (const project of [null, 'Shop', 'a/b/c', '-x/y', 'a/--help']) expect([project, githubRepoOf(AZ_REMOTE, project)]).toEqual([project, null])
})

test('outside a git repo there is no task section', async ($, on) => {
  engine(on, { files: {}, run: () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }) })
  await $.session.start(START)
  await $.command.run(cmd(''))

  expect(await paneText($, 60)).not.toContain('TASK')
})

test('a GitHub host that the settings force still shows the pull request, whatever the remote is', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': '{"prHost": "github"}' }, remote: 'git@github.example.com:a/b.git', run: gh })
  await $.session.start(START)
  await $.command.run(cmd(''))
  expect((await paneText($, 60)).find(row => row.startsWith('PR 51'))).toBeDefined()
  expect(world.ran).toContain('gh pr view --json number,state,isDraft,reviewDecision,statusCheckRollup,url')
})

test('the panel asks Azure DevOps for a work item with no comments', async ($, on) => {
  const world = engine(on, { files: { '/r/.claude/factory.json': AZ_SETTINGS }, remote: AZ_REMOTE, run: az })
  await $.session.start(START)
  await $.command.run(cmd(''))
  expect(world.ran.some(line => line.startsWith('az boards work-item show --id 12 '))).toBe(true)
  expect(world.ran.some(line => line.startsWith('az devops invoke'))).toBe(false)
})
