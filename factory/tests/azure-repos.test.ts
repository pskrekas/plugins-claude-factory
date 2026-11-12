import { expect, test } from 'claude-code/testing'

import { azureRepos, parseAzPolicies, parseAzPr } from '../adapters/azure-repos'
import type { Run } from '../adapters/tracker'
import type { AzPlace } from '../core/azure'

const PLACE: AzPlace = { org: 'https://dev.azure.com/acme', project: 'My Shop', repo: 'web' }
const TAIL = '--org https://dev.azure.com/acme --detect false --output json'
const URL = 'https://dev.azure.com/acme/My%20Shop/_git/web/pullrequest/7'
const pr = (over: Record<string, unknown> = {}) => JSON.stringify({ pullRequestId: 7, status: 'active', isDraft: false, reviewers: [], title: 'x', ...over })
const policy = (status: string) => ({ status, configuration: { isBlocking: true, isEnabled: true } })

function world(answers: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {}) {
  const ran: string[] = []
  const files: Record<string, string> = {}
  const sent: Record<string, string> = {}
  let n = 0
  const run: Run = async argv => {
    const line = argv.join(' ')
    ran.push(line)
    for (const [i, word] of argv.entries()) {
      const at = word.indexOf('=@')
      if (at > 0) sent[word.slice(2, at)] = files[word.slice(at + 2)] ?? '(no such file)'
      if (word === '--in-file') sent['in-file'] = files[argv[i + 1] ?? ''] ?? '(no such file)'
    }
    if (argv[0] === 'rm') {
      delete files[argv[2] ?? '']

      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const key = Object.keys(answers).find(start => line.startsWith(start))
    const hit = key === undefined ? undefined : answers[key]

    return hit === undefined ? { failed: 'not-found' as const } : { exitCode: hit.exitCode, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
  }
  const put = async (text: string, ext: 'txt' | 'json') => {
    n += 1
    files[`/state/r-1/tmp/f${n}.${ext}`] = text

    return `/state/r-1/tmp/f${n}.${ext}`
  }

  return { run, put, ran, files, sent, az: () => ran.filter(line => line.startsWith('az ')) }
}

test('a pull request of Azure Repos as the panel and the line read it', async () => {
  expect(parseAzPr(pr({ isDraft: true }), PLACE)).toEqual({ number: 7, state: 'open', isDraft: true, build: 'none', approvals: 0, url: URL })
  // Completed is merged, abandoned is closed.
  expect([parseAzPr(pr({ status: 'completed' }), PLACE)?.state, parseAzPr(pr({ status: 'abandoned' }), PLACE)?.state]).toEqual(['merged', 'closed'])
  // `list` answers a list: the first is the newest.
  expect(parseAzPr(`[${pr({ pullRequestId: 9 })}, ${pr()}]`, PLACE)?.number).toBe(9)
  // Votes: 10 approved, 5 approved with suggestions. One rejection or one "waiting" takes the approvals away.
  const votes = (...all: number[]) => parseAzPr(pr({ reviewers: all.map(vote => ({ vote })) }), PLACE)?.approvals
  expect([votes(10, 5), votes(10, 0), votes(10, -10), votes(5, -5), votes()]).toEqual([2, 1, 0, 0, 0])
  for (const bad of ['{ nope', '[]', '{}', '{"pullRequestId": "7", "status": "active"}', pr({ status: 'strange' }), 'null']) expect([bad.slice(0, 40), parseAzPr(bad, PLACE)]).toEqual([bad.slice(0, 40), null])

  const build = (...all: string[]) => parseAzPolicies(JSON.stringify(all.map(policy)))
  expect([build(), build('approved', 'notApplicable'), build('approved', 'running'), build('queued'), build('approved', 'rejected', 'running'), build('broken')]).toEqual(['none', 'green', 'running', 'running', 'red', 'red'])
  // A policy that is switched off does not count.
  expect(parseAzPolicies(JSON.stringify([{ status: 'rejected', configuration: { isEnabled: false } }]))).toBe('none')
  expect([parseAzPolicies('{ nope'), parseAzPolicies('{}')]).toEqual(['none', 'none'])
})

test('a draft is opened from a job branch; the title and the text reach az only as files', async () => {
  const w = world({ 'az repos pr create': { exitCode: 0, stdout: pr({ isDraft: true }) } })
  const host = azureRepos(w.run, w.put, PLACE)
  expect(host.kind).toBe('azure-repos')
  const made = await host.open({ head: 'factory/12-add-dark-mode', base: 'main', title: '@/etc/hosts --help\u001b[2J', body: 'Built by the factory line for item 12.\n\n@~/secret' })
  expect(made.pr).toEqual({ number: 7, url: URL })
  expect(w.az()).toEqual([`az repos pr create --draft true --source-branch factory/12-add-dark-mode --target-branch main --title=@/state/r-1/tmp/f1.txt --description=@/state/r-1/tmp/f2.txt --project My Shop --repository web ${TAIL}`])
  // What az loaded: the title as cleaned text, the body as it is. Then the files are removed.
  expect(w.sent).toEqual({ title: '@/etc/hosts --help[2J', description: 'Built by the factory line for item 12.\n\n@~/secret' })
  expect(Object.keys(w.files)).toEqual([])
  // A long title is cut; an empty one gets a name.
  await host.open({ head: 'factory/12-add-dark-mode', base: 'main', title: 'x'.repeat(500), body: 'y' })
  expect(w.sent.title?.length).toBe(200)
  await host.open({ head: 'factory/12-add-dark-mode', base: 'main', title: '\u0000', body: 'y' })
  expect(w.sent.title).toBe('Factory job')

  // Nothing runs, and no file is written, for a head that is not a job's branch or a base that is not a branch.
  const none = world({})
  const idle = azureRepos(none.run, none.put, PLACE)
  expect((await idle.open({ head: 'main', base: 'main', title: 'x', body: 'y' })).pr).toBe(null)
  expect((await idle.open({ head: 'factory/12-x', base: '--help', title: 'x', body: 'y' })).pr).toBe(null)
  expect([none.ran, Object.keys(none.files)]).toEqual([[], []])
  // az fails: no pull request, the result is handed on, the files are removed.
  const broken = world({ 'az repos pr create': { exitCode: 1, stderr: 'TF401179: An active pull request for the source and target branch already exists.' } })
  const failed = await azureRepos(broken.run, broken.put, PLACE).open({ head: 'factory/12-x', base: 'main', title: 'x', body: 'y' })
  expect([failed.pr, 'failed' in failed.result ? null : failed.result.exitCode, Object.keys(broken.files)]).toEqual([null, 1, []])
})

test('read, the pull request of a branch, ready, comment and close', async () => {
  const w = world({
    'az repos pr show --id 7': { exitCode: 0, stdout: pr({ reviewers: [{ vote: 10 }] }) },
    'az repos pr show --id 8': { exitCode: 0, stdout: pr({ pullRequestId: 8, status: 'completed' }) },
    'az repos pr list': { exitCode: 0, stdout: `[${pr({ isDraft: true })}]` },
    'az repos pr policy list --id 7': { exitCode: 0, stdout: JSON.stringify([policy('approved'), policy('running')]) },
    az: { exitCode: 0, stdout: '{}' },
  })
  const host = azureRepos(w.run, w.put, PLACE)
  expect((await host.read(7)).pr).toEqual({ number: 7, state: 'open', isDraft: false, build: 'running', approvals: 1, url: URL })
  // A pull request that someone completed is merged: the line sees it, and does nothing to it.
  expect((await host.read(8)).pr?.state).toBe('merged')
  expect((await host.current('factory/12-x')).pr).toEqual({ number: 7, state: 'open', isDraft: true, build: 'running', approvals: 0, url: URL })
  await host.ready(7)
  await host.comment(7, 'Round 2 pushed.\n"quoted" @x')
  await host.close(7)
  expect(w.az()).toEqual([
    `az repos pr show --id 7 ${TAIL}`,
    `az repos pr policy list --id 7 ${TAIL}`,
    `az repos pr show --id 8 ${TAIL}`,
    `az repos pr policy list --id 8 ${TAIL}`,
    `az repos pr list --source-branch factory/12-x --status all --top 1 --project My Shop --repository web ${TAIL}`,
    `az repos pr policy list --id 7 ${TAIL}`,
    `az repos pr update --id 7 --draft false ${TAIL}`,
    `az devops invoke --area git --resource pullRequestThreads --route-parameters project=My Shop repositoryId=web pullRequestId=7 --http-method POST --in-file /state/r-1/tmp/f1.json --api-version 7.1 ${TAIL}`,
    `az repos pr update --id 7 --status abandoned ${TAIL}`,
  ])
  // The comment is one JSON file; its text is the markdown, whole.
  expect(JSON.parse(w.sent['in-file'] ?? '{}')).toEqual({ comments: [{ parentCommentId: 0, content: 'Round 2 pushed.\n"quoted" @x', commentType: 1 }], status: 1 })
  expect(Object.keys(w.files)).toEqual([])
  // The factory never completes a pull request.
  expect(w.ran.some(line => / completed\b|--auto-complete|--bypass-policy/.test(line))).toBe(false)

  // A branch with no pull request, a number that is not one, a policy list that cannot be read.
  const none = world({ 'az repos pr list': { exitCode: 0, stdout: '[]' }, 'az repos pr show': { exitCode: 0, stdout: pr() } })
  const idle = azureRepos(none.run, none.put, PLACE)
  expect([(await idle.current('main')).pr, (await idle.current('-x')).pr, (await idle.read(0)).pr, (await idle.read(7)).pr?.build]).toEqual([null, null, null, 'none'])
  expect('failed' in (await idle.ready(0))).toBe(true)
  expect(none.az().some(line => line.includes('--id 0'))).toBe(false)
})
