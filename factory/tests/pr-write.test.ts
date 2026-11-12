import { expect, test } from 'claude-code/testing'

import {
  closePr,
  commentPr,
  createDraftPr,
  parsePrUrl,
  readPrByNumber,
  readyPr,
} from '../adapters/github-pr'
import type { RunResult } from '../core/run'

function recorder(answer: (argv: string[]) => RunResult = () => ({ exitCode: 0, stdout: '', stderr: '' })) {
  const calls: { argv: string[]; stdin: string | undefined }[] = []
  const run = async (argv: string[], stdin?: string) => {
    calls.push({ argv, stdin })

    return answer(argv)
  }

  return { run, calls }
}

const HEAD = 'factory/12-add-dark-mode'
const URL = 'https://github.com/a/b/pull/21'

test('the address of a new pull request', async () => {
  expect(parsePrUrl(`Creating pull request for ${HEAD} into main\n${URL}\n`)).toEqual({ number: 21, url: URL })
  expect(parsePrUrl('https://github.com.evil.example/a/b/pull/1')).toBe(null)
  expect(parsePrUrl('see https://github.com/a/b/pull/21 for more')).toBe(null)
  expect(parsePrUrl('https://github.com/a/b/issues/21')).toBe(null)
  expect(parsePrUrl('not a url')).toBe(null)
})

test('a draft pull request: the body on standard input, the title as a value', async () => {
  const { run, calls } = recorder(() => ({ exitCode: 0, stdout: URL + '\n', stderr: '' }))
  const body = 'Closes #12\n\n--draft=false $(x)'
  const made = await createDraftPr(run, { head: HEAD, base: 'main', title: '--help me\u001b[2J', body })

  expect(made.pr).toEqual({ number: 21, url: URL })
  expect(calls).toEqual([
    {
      argv: ['gh', 'pr', 'create', '--draft', '--head', HEAD, '--base', 'main', '--title', '--help me[2J', '--body-file', '-'],
      stdin: body,
    },
  ])
  const long = recorder(() => ({ exitCode: 0, stdout: URL, stderr: '' }))
  await createDraftPr(long.run, { head: HEAD, base: 'main', title: 't'.repeat(900), body: 'b' })
  expect(long.calls[0]?.argv[9]?.length).toBe(200)
})

test('a head that is not a job branch, or a base that is not a branch, runs nothing', async () => {
  for (const [head, base] of [
    ['main', 'main'],
    ['factory/../x', 'main'],
    ['factory/', 'main'],
    ['factory/UPPER', 'main'],
    [HEAD, '--force'],
    [HEAD, 'a b'],
  ] as const) {
    const { run, calls } = recorder()
    const made = await createDraftPr(run, { head, base, title: 't', body: 'b' })
    expect(made.pr).toBe(null)
    expect(calls).toEqual([])
  }
  const failed = recorder(() => ({ exitCode: 1, stdout: '', stderr: 'no commits' }))
  expect((await createDraftPr(failed.run, { head: HEAD, base: 'main', title: 't', body: 'b' })).pr).toBe(null)
})

test('ready, read, comment and close, by number', async () => {
  const { run, calls } = recorder()
  await readyPr(run, 21)
  await readPrByNumber(run, 21)
  await commentPr(run, 21, 'Ready.\n--x')
  await closePr(run, 21)
  expect(calls.map(call => call.argv.join(' '))).toEqual([
    'gh pr ready 21',
    'gh pr view 21 --json number,state,isDraft,reviewDecision,statusCheckRollup,url',
    'gh pr comment 21 --body-file -',
    'gh pr close 21',
  ])
  expect(calls[2]?.stdin).toBe('Ready.\n--x')

  const none = recorder()
  for (const n of [0, -1, 1.5, Number.NaN]) {
    await readyPr(none.run, n)
    await closePr(none.run, n)
    await commentPr(none.run, n, 'x')
    await readPrByNumber(none.run, n)
  }
  expect(none.calls).toEqual([])
})

test('nothing in this file can merge a pull request', async () => {
  const { run, calls } = recorder(() => ({ exitCode: 0, stdout: URL, stderr: '' }))
  await createDraftPr(run, { head: HEAD, base: 'main', title: 't', body: 'b' })
  await readyPr(run, 21)
  await readPrByNumber(run, 21)
  await commentPr(run, 21, 'x')
  await closePr(run, 21)

  const words = calls.flatMap(call => call.argv)
  expect(words.includes('merge')).toBe(false)
  expect(words.some(word => word.includes('--admin') || word.includes('--auto'))).toBe(false)
})
