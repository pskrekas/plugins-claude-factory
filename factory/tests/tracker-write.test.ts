import { expect, test } from 'claude-code/testing'

import {
  closeIssue,
  commentIssue,
  ensureLabels,
  inRepo,
  githubIssues,
  listIssues,
  setIssueState,
  stateLabel,
} from '../adapters/github-issues'
import { MAX_COMMENT, commentOf } from '../core/comment'
import type { RunResult } from '../core/run'

// A `run` that records what it was asked and answers what the test says.
function recorder(answer: (argv: string[]) => RunResult = () => ({ exitCode: 0, stdout: '', stderr: '' })) {
  const calls: { argv: string[]; stdin: string | undefined }[] = []
  const run = async (argv: string[], stdin?: string) => {
    calls.push({ argv, stdin })

    return answer(argv)
  }

  return { run, calls, lines: () => calls.map(call => call.argv.join(' ')) }
}

test('what may be sent as a comment', async () => {
  expect(commentOf('Looks good', [])).toEqual({ ok: 'Looks good' })
  expect(commentOf('Written by ACME bot', ['acme'])).toEqual({ no: 'a forbidden word' })
  expect(commentOf('fine', ['', 'acme'])).toEqual({ ok: 'fine' })
  expect(commentOf('  \n ', [])).toEqual({ no: 'empty' })
  expect(commentOf('a\u001b[2Jb\tc\nd‮', [])).toEqual({ ok: 'a[2Jb\tc\nd' })
  const long = commentOf('x'.repeat(70_000), [])
  expect('ok' in long && long.ok.length <= MAX_COMMENT && long.ok.endsWith('\n(cut)')).toBe(true)
})

test('the state labels and their setup', async () => {
  expect(stateLabel('factory', 'in-progress')).toBe('factory:in-progress')
  const { run, lines } = recorder()
  await ensureLabels(run, 'factory')
  expect(lines()).toEqual([
    'gh label create factory:in-progress --force --description The factory works on this',
    'gh label create factory:needs-human --force --description The factory waits for a person',
  ])
  const bad = recorder()
  expect(await ensureLabels(bad.run, '--web')).toEqual({ failed: 'other' })
  expect(bad.calls).toEqual([])
})

test('a comment goes to gh on standard input, never as an argument', async () => {
  const { run, calls } = recorder()
  const body = '--help\n$(rm -rf x)\n"quoted" `ticks`'
  await commentIssue(run, 'PROJ-12', body)

  expect(calls).toEqual([{ argv: ['gh', 'issue', 'comment', '12', '--body-file', '-'], stdin: body }])
  const none = recorder()
  expect(await commentIssue(none.run, 'abc', 'x')).toEqual({ failed: 'other' })
  expect(none.calls).toEqual([])
})

test('each state is one edit of the labels; rejected also closes the issue', async () => {
  const lines = async (state: 'in-progress' | 'needs-human' | 'done' | 'rejected') => {
    const rec = recorder()
    await setIssueState(rec.run, '12', 'factory', state)

    return rec.lines()
  }
  expect(await lines('in-progress')).toEqual([
    'gh issue edit 12 --add-label factory:in-progress --remove-label factory:needs-human',
  ])
  expect(await lines('needs-human')).toEqual([
    'gh issue edit 12 --add-label factory:needs-human --remove-label factory:in-progress',
  ])
  expect(await lines('done')).toEqual([
    'gh issue edit 12 --remove-label factory:in-progress --remove-label factory:needs-human',
  ])
  expect(await lines('rejected')).toEqual([
    // Closed first: if the next step fails, the item still shows as claimed and the reject can be run again.
    'gh issue close 12 --reason not planned',
    'gh issue edit 12 --remove-label factory:in-progress --remove-label factory:needs-human',
  ])
  const rec = recorder()
  await closeIssue(rec.run, '#7')
  expect(rec.calls[0]?.argv).toEqual(['gh', 'issue', 'close', '7', '--reason', 'not planned'])
  expect(await setIssueState(recorder().run, '12', '-x', 'done')).toEqual({ failed: 'other' })
})

test('the adapter: five actions, a refused comment runs nothing, a failed command throws', async () => {
  const ok = recorder()
  const tracker = githubIssues(ok.run, 'factory', ['acme'])
  await tracker.comment('12', 'Intake: accepted, risk low.')
  await tracker.setState('12', 'in-progress')
  await tracker.linkPr('12', 'https://github.com/a/b/pull/21')
  await tracker.setState('12', 'needs-human')
  expect(ok.lines()).toEqual([
    'gh issue comment 12 --body-file -',
    // The two state labels are made once, before the first state is written.
    'gh label create factory:in-progress --force --description The factory works on this',
    'gh label create factory:needs-human --force --description The factory waits for a person',
    'gh issue edit 12 --add-label factory:in-progress --remove-label factory:needs-human',
    'gh issue comment 12 --body-file -',
    'gh issue edit 12 --add-label factory:needs-human --remove-label factory:in-progress',
  ])
  expect(ok.calls[4]?.stdin).toBe('Pull request: https://github.com/a/b/pull/21')
  // In a fork gh would pick the upstream project: every call names the repository.
  const named = recorder()
  await inRepo(named.run, 'a/b')(['gh', 'issue', 'close', '12'])
  await inRepo(named.run, 'a/b')(['git', 'status'])
  expect(named.lines()).toEqual(['gh issue close 12 -R a/b', 'git status'])

  const refused = recorder()
  let error: unknown = null
  await githubIssues(refused.run, 'factory', ['acme']).comment('12', 'by ACME').catch(caught => (error = caught))
  expect(String(error)).toContain('a forbidden word')
  expect(refused.calls).toEqual([])

  error = null
  await tracker.linkPr('12', 'javascript:alert(1)').catch(caught => (error = caught))
  expect(error).not.toBe(null)

  const failing = recorder(() => ({ exitCode: 1, stdout: '', stderr: 'no such issue\u001b[0m\nmore' }))
  error = null
  await githubIssues(failing.run, 'factory', []).setState('12', 'done').catch(caught => (error = caught))
  expect(String(error)).toContain('gh: no such issue[0m more')
  error = null
  await githubIssues(recorder(() => ({ failed: 'not-found' })).run, 'factory', []).comment('12', 'x').catch(caught => (error = caught))
  expect(String(error)).toContain('gh: could not start')
})

test('the list tells the queue from the items the factory already holds', async () => {
  const issues = JSON.stringify([
    { number: 4, title: 'Fonts', state: 'OPEN', labels: [{ name: 'factory' }] },
    { number: 5, title: 'Walls', state: 'OPEN', labels: [{ name: 'factory' }, { name: 'factory:in-progress' }] },
    { number: 6, title: 'Dark', state: 'OPEN', labels: [{ name: 'factory' }, { name: 'factory:needs-human' }] },
  ])
  const { run } = recorder(() => ({ exitCode: 0, stdout: issues, stderr: '' }))
  const list = await listIssues(run, 'factory')
  expect(list.items?.map(item => item.id)).toEqual(['4'])
  expect(list.claimed.map(item => item.id)).toEqual(['5'])
})
