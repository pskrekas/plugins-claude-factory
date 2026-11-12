import { expect, test } from 'claude-code/testing'

import { branchOf, gitArgs } from '../core/git-args'
import { stateFolderOf } from '../core/state-path'
import {
  addCleanCopy,
  addWorktree,
  changedFiles,
  headOf,
  pushBranch,
  removeCleanCopy,
  removeWorktree,
  syncBase,
  uncommittedFiles,
  worktreePath,
} from '../hooks/worktrees'
import { fakeIo } from './kit'

const ID = '12-add-dark-mode'
const WT = '/state/' + stateFolderOf('/r') + '/worktrees/' + ID
const CLEAN = '/state/' + stateFolderOf('/r') + '/gate/' + ID
const SHA = '0123456789abcdef0123456789abcdef01234567'
const line = (call: Parameters<typeof gitArgs>[0]) => gitArgs(call)?.join(' ') ?? null

test('every git call of the factory, word for word', async () => {
  expect(branchOf(ID)).toBe('factory/12-add-dark-mode')
  expect(line({ do: 'fetch', base: 'main' })).toBe('git fetch origin main')
  expect(line({ do: 'add', path: WT, jobId: ID, base: 'main' })).toBe(
    `git worktree add ${WT} -b factory/12-add-dark-mode origin/main`,
  )
  expect(line({ do: 'remove', path: WT })).toBe(`git worktree remove --force ${WT}`)
  expect(line({ do: 'push', jobId: ID })).toBe(
    'git push -u origin factory/12-add-dark-mode:factory/12-add-dark-mode',
  )
  expect(line({ do: 'merge-base', base: 'main' })).toBe('git merge --no-edit origin/main')
  expect(line({ do: 'abort-merge' })).toBe('git merge --abort')
  // A rename is shown as a file that went and a file that came: both names are checked.
  expect(line({ do: 'changed', base: 'main' })).toBe('git diff --name-only --no-renames -z origin/main...HEAD')
  expect(line({ do: 'uncommitted' })).toBe('git status --porcelain --no-renames --untracked-files=all -z')
  expect(line({ do: 'head' })).toBe('git rev-parse HEAD')
  // The gate's own copy of one commit, and the files of that same commit.
  expect(line({ do: 'add-clean', path: CLEAN, sha: SHA })).toBe(`git worktree add --detach ${CLEAN} ${SHA}`)
  expect(line({ do: 'changed', base: 'main', at: SHA })).toBe(`git diff --name-only --no-renames -z origin/main...${SHA}`)
})

test('a commit is named by its full id only', async () => {
  for (const sha of ['HEAD', 'main', 'abc123', '--upload-pack=x', SHA + ' x', SHA.toUpperCase(), '']) {
    expect(gitArgs({ do: 'add-clean', path: CLEAN, sha })).toBe(null)
    expect(gitArgs({ do: 'changed', base: 'main', at: sha })).toBe(null)
  }
  expect(gitArgs({ do: 'add-clean', path: '../x', sha: SHA })).toBe(null)
})

test("the gate's clean copy: made at one commit, in the state folder, and removed", async () => {
  const io = fakeIo({ files: { '/r/x': '' } })
  io.answer = git({ 'git rev-parse HEAD': { exitCode: 0, stdout: SHA + '\n' }, 'git worktree': { exitCode: 0 }, 'git diff': { exitCode: 0, stdout: 'a.ts\0' } })
  expect(await headOf(io, '/r', ID)).toBe(SHA)
  expect(io.cwds[0]).toBe(WT)
  expect(await changedFiles(io, '/r', ID, 'main', SHA)).toEqual(['a.ts'])
  expect(await addCleanCopy(io, '/r', ID, SHA)).toEqual({ ok: true, path: CLEAN })
  expect(await removeCleanCopy(io, '/r', ID)).toEqual({ ok: true })
  expect(io.ran.slice(1)).toEqual([
    `git diff --name-only --no-renames -z origin/main...${SHA}`,
    // A copy that an earlier run left is removed first.
    `git worktree remove --force ${CLEAN}`,
    `git worktree add --detach ${CLEAN} ${SHA}`,
    `git worktree remove --force ${CLEAN}`,
  ])
  expect(io.cwds.slice(2)).toEqual(['/r', '/r', '/r'])

  const odd = fakeIo({ files: { '/r/x': '' } })
  odd.answer = git({ 'git rev-parse HEAD': { exitCode: 0, stdout: 'not a commit\n' }, 'git worktree add': { exitCode: 128, stderr: 'fatal: no' } })
  expect(await headOf(odd, '/r', ID)).toBe(null)
  expect(await addCleanCopy(odd, '/r', ID, SHA)).toEqual({ ok: false, why: 'git: fatal: no' })
  expect(await addCleanCopy(odd, '/r', ID, 'HEAD')).toEqual({ ok: false, why: 'not a job id or a branch name' })
})

test('a value that breaks a rule gives no call at all', async () => {
  expect(gitArgs({ do: 'push', jobId: '../x' })).toBe(null)
  expect(gitArgs({ do: 'push', jobId: 'main' + ' x' })).toBe(null)
  expect(gitArgs({ do: 'fetch', base: '-D' })).toBe(null)
  expect(gitArgs({ do: 'fetch', base: '--upload-pack=x' })).toBe(null)
  expect(gitArgs({ do: 'add', path: 'relative/x', jobId: ID, base: 'main' })).toBe(null)
  expect(gitArgs({ do: 'add', path: '/a/../b', jobId: ID, base: 'main' })).toBe(null)
  expect(gitArgs({ do: 'add', path: WT, jobId: ID, base: 'a b' })).toBe(null)
  expect(gitArgs({ do: 'remove', path: '-rf' })).toBe(null)
  expect(gitArgs({ do: 'remove', path: '/a\nb' })).toBe(null)
  expect(gitArgs({ do: 'changed', base: 'x..y' + ' z' })).toBe(null)
})

test('the factory cannot force, merge into the base, or push another branch', async () => {
  const all = [
    gitArgs({ do: 'fetch', base: 'main' }),
    gitArgs({ do: 'add', path: WT, jobId: ID, base: 'main' }),
    gitArgs({ do: 'remove', path: WT }),
    gitArgs({ do: 'push', jobId: ID }),
    gitArgs({ do: 'merge-base', base: 'main' }),
    gitArgs({ do: 'abort-merge' }),
    gitArgs({ do: 'changed', base: 'main' }),
    gitArgs({ do: 'uncommitted' }),
    gitArgs({ do: 'head' }),
    gitArgs({ do: 'add-clean', path: CLEAN, sha: SHA }),
    gitArgs({ do: 'changed', base: 'main', at: SHA }),
  ].map(list => list ?? [])
  const banned = ['-f', '--force-with-lease', '--mirror', '--all', '--delete', '--tags', 'reset', 'rebase', 'checkout', 'commit', 'clean']
  for (const list of all) {
    expect(list[0]).toBe('git')
    for (const word of list) {
      expect(banned.includes(word)).toBe(false)
      expect(word.startsWith('+')).toBe(false)
    }
    // --force is the worktree's own flag (remove a job's folder), never a push.
    if (list.includes('--force')) expect(list.slice(0, 3)).toEqual(['git', 'worktree', 'remove'])
  }
  const pushes = all.filter(list => list[1] === 'push')
  expect(pushes).toEqual([['git', 'push', '-u', 'origin', 'factory/12-add-dark-mode:factory/12-add-dark-mode']])
  // The one merge brings the base into the job's branch; nothing merges the other way.
  expect(all.filter(list => list[1] === 'merge' && !list.includes('--abort'))).toEqual([
    ['git', 'merge', '--no-edit', 'origin/main'],
  ])
})

const git = (table: Record<string, { exitCode: number; stdout?: string; stderr?: string }>) => (argv: string[]) => {
  const key = Object.keys(table).find(start => argv.join(' ').startsWith(start))
  const hit = key === undefined ? undefined : table[key]

  return hit === undefined ? undefined : { exitCode: hit.exitCode, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
}

test('a worktree is made under the state folder, on the job branch, from the base', async () => {
  const io = fakeIo({ files: { '/r/x': '' } })
  io.answer = git({ 'git fetch': { exitCode: 0 }, 'git worktree add': { exitCode: 0 } })

  expect(await worktreePath(io, '/r', ID)).toBe(WT)
  expect(await addWorktree(io, '/r', ID, 'main')).toEqual({ ok: true, path: WT, branch: 'factory/12-add-dark-mode' })
  expect(io.ran).toEqual(['git fetch origin main', `git worktree add ${WT} -b factory/12-add-dark-mode origin/main`])
})

test('a git that fails says why, on one line', async () => {
  const io = fakeIo({ files: { '/r/x': '' } })
  io.answer = git({
    'git fetch': { exitCode: 0 },
    'git worktree add': { exitCode: 128, stderr: "fatal: a branch named 'factory/12-add-dark-mode' already exists\n" },
  })
  expect(await addWorktree(io, '/r', ID, 'main')).toEqual({
    ok: false,
    why: "git: fatal: a branch named 'factory/12-add-dark-mode' already exists",
  })
  const noFetch = fakeIo({ files: { '/r/x': '' } })
  noFetch.answer = git({ 'git fetch': { exitCode: 1, stderr: 'no network' } })
  expect(await addWorktree(noFetch, '/r', ID, 'main')).toEqual({ ok: false, why: 'git: no network' })
  expect(noFetch.ran).toEqual(['git fetch origin main'])
  expect(await addWorktree(fakeIo({ files: { '/r/x': '' } }), '/r', '../x', 'main')).toEqual({ ok: false, why: 'not a job id or a branch name' })
})

test('sync with the base: a conflict is undone and named', async () => {
  const io = fakeIo({ files: { '/r/x': '' } })
  io.answer = git({ 'git fetch': { exitCode: 0 }, 'git merge --no-edit': { exitCode: 1, stderr: 'CONFLICT' }, 'git merge --abort': { exitCode: 0 } })

  expect(await syncBase(io, '/r', ID, 'main')).toEqual({ ok: false, why: 'conflict with main' })
  expect(io.ran).toEqual(['git fetch origin main', 'git merge --no-edit origin/main', 'git merge --abort'])
  const clean = fakeIo({ files: { '/r/x': '' } })
  clean.answer = git({ 'git fetch': { exitCode: 0 }, 'git merge': { exitCode: 0 } })
  expect(await syncBase(clean, '/r', ID, 'main')).toEqual({ ok: true })
})

test('changed files, push and remove', async () => {
  const io = fakeIo({ files: { '/r/x': '' } })
  io.answer = git({
    'git diff': { exitCode: 0, stdout: 'a b.ts\0src/x.ts\0' },
    'git push': { exitCode: 0 },
    'git worktree remove': { exitCode: 0 },
  })
  expect(await changedFiles(io, '/r', ID, 'main')).toEqual(['a b.ts', 'src/x.ts'])
  expect(await pushBranch(io, '/r', ID)).toEqual({ ok: true })
  expect(await removeWorktree(io, '/r', ID)).toEqual({ ok: true })
  expect(io.ran.slice(1)).toEqual([
    'git push -u origin factory/12-add-dark-mode:factory/12-add-dark-mode',
    `git worktree remove --force ${WT}`,
  ])

  const broken = fakeIo({ files: { '/r/x': '' } })
  broken.answer = git({ 'git diff': { exitCode: 128, stderr: 'bad revision' } })
  expect(await changedFiles(broken, '/r', ID, 'main')).toBe(null)
  expect(await uncommittedFiles(broken, '/r', ID)).toBe(null)

  const dirty = fakeIo({ files: { '/r/x': '' } })
  dirty.answer = git({ 'git status': { exitCode: 0, stdout: '?? a b.ts\0 M src/x.ts\0D  gone.ts\0' } })
  expect(await uncommittedFiles(dirty, '/r', ID)).toEqual(['a b.ts', 'src/x.ts', 'gone.ts'])
  expect(dirty.cwds[0]).toBe(WT)
  dirty.answer = git({ 'git status': { exitCode: 0, stdout: '' } })
  expect(await uncommittedFiles(dirty, '/r', ID)).toEqual([])
  const none = fakeIo({ files: { '/r/x': '' } })
  expect(await pushBranch(none, '/r', 'not a job')).toEqual({ ok: false, why: 'not a job id or a branch name' })
  expect(none.ran).toEqual([])
})
