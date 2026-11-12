import { expect, test } from 'claude-code/testing'

import { githubIssues, inRepo, listIssues } from '../adapters/github-issues'
import { githubPrs } from '../adapters/github-pr'
import type { PrHost } from '../adapters/pr-host'
import type { Run, Tracker } from '../adapters/tracker'

const LIST = JSON.stringify([
  { number: 4, title: 'Fonts', state: 'OPEN', labels: [{ name: 'factory' }] },
  { number: 5, title: 'Walls', state: 'OPEN', labels: [{ name: 'factory' }, { name: 'factory:in-progress' }] },
  { number: 6, title: 'Dark', state: 'OPEN', labels: [{ name: 'factory' }, { name: 'factory:needs-human' }] },
])
// A runner that notes each line and answers by the start of the line.
function runner(answers: Record<string, { exitCode: number; stdout?: string }>) {
  const ran: string[] = []
  const stdins: (string | undefined)[] = []
  const run: Run = async (argv, stdin) => {
    const line = argv.join(' ')
    ran.push(line)
    stdins.push(stdin)
    const key = Object.keys(answers).find(start => line.startsWith(start))
    const hit = key === undefined ? undefined : answers[key]

    return hit === undefined ? { failed: 'not-found' as const } : { exitCode: hit.exitCode, stdout: hit.stdout ?? '', stderr: '' }
  }

  return { run, ran, stdins }
}

test('the GitHub tracker offers what the line used to ask the GitHub adapter by name', async () => {
  const { run, ran } = runner({
    'gh issue list': { exitCode: 0, stdout: LIST },
    'gh issue view 4 --json labels': { exitCode: 0, stdout: JSON.stringify({ labels: [{ name: 'factory' }] }) },
    'gh issue view 9 --json labels': { exitCode: 0, stdout: JSON.stringify({ labels: [{ name: 'bug' }] }) },
    'gh api user': { exitCode: 0, stdout: 'runner\n' },
  })
  const tracker: Tracker = githubIssues(run, 'factory', [])
  expect(tracker.kind).toBe('github')
  // The queue and the claimed items, as `listIssues` gives them.
  const scan = await tracker.scan()
  const listed = await listIssues(run, 'factory')
  expect([scan.items, scan.claimed]).toEqual([listed.items, listed.claimed])
  expect(scan.items).toEqual([{ id: '4', title: 'Fonts', state: 'open' }])
  expect(scan.claimed).toEqual([{ id: '5', title: 'Walls', state: 'open' }])
  expect(await tracker.list('factory')).toEqual(scan.items)
  expect([await tracker.hasMark('4'), await tracker.hasMark('9'), await tracker.hasMark('../x')]).toEqual([true, false, false])
  // Who runs the line: asked once.
  expect([await tracker.me(), await tracker.me()]).toEqual(['runner', 'runner'])
  expect(ran.filter(line => line.startsWith('gh api user'))).toEqual(['gh api user --jq .login'])
  // A list that cannot be read is null, not empty.
  const broken = githubIssues(runner({}).run, 'factory', [])
  expect([(await broken.scan()).items, await broken.list('factory'), await broken.me()]).toEqual([null, [], null])
})

test('every gh call but `gh api` names the repository', async () => {
  const { run, ran } = runner({ gh: { exitCode: 0, stdout: 'runner\n' } })
  const inside = inRepo(run, 'a/b')
  await inside(['gh', 'issue', 'view', '4'])
  await inside(['gh', 'api', 'user', '--jq', '.login'])
  await inside(['git', 'status'])
  expect(ran).toEqual(['gh issue view 4 -R a/b', 'gh api user --jq .login', 'git status'])
})

test('the GitHub pull request host runs the same gh lines as before, and no merge', async () => {
  const pr = JSON.stringify({ number: 7, state: 'OPEN', isDraft: true, url: 'https://github.com/a/b/pull/7', statusCheckRollup: [] })
  const { run, ran, stdins } = runner({ 'gh pr create': { exitCode: 0, stdout: 'https://github.com/a/b/pull/7\n' }, 'gh pr view': { exitCode: 0, stdout: pr }, gh: { exitCode: 0 } })
  const host: PrHost = githubPrs(run)
  expect(host.kind).toBe('github')
  expect((await host.open({ head: 'factory/12-x', base: 'main', title: '12: X', body: 'the body' })).pr).toEqual({ number: 7, url: 'https://github.com/a/b/pull/7' })
  expect((await host.read(7)).pr?.state).toBe('open')
  expect((await host.current('any-branch')).pr?.number).toBe(7)
  await host.comment(7, 'Round 2 pushed.')
  await host.ready(7)
  await host.close(7)
  expect(ran).toEqual([
    'gh pr create --draft --head factory/12-x --base main --title 12: X --body-file -',
    'gh pr view 7 --json number,state,isDraft,reviewDecision,statusCheckRollup,url',
    'gh pr view --json number,state,isDraft,reviewDecision,statusCheckRollup,url',
    'gh pr comment 7 --body-file -',
    'gh pr ready 7',
    'gh pr close 7',
  ])
  expect([stdins[0], stdins[3]]).toEqual(['the body', 'Round 2 pushed.'])
  expect(ran.some(line => line.includes('merge'))).toBe(false)
  // Nothing runs for a head that is not a job's branch, or a number that is not one.
  expect((await host.open({ head: 'main', base: 'main', title: 'x', body: 'y' })).pr).toBe(null)
  await host.ready(0)
  expect(ran.length).toBe(6)
})
