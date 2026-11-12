import { expect, test } from 'claude-code/testing'

import { branchOf, gitArgs } from '../core/git-args'
import { stateFolderOf } from '../core/state-path'
import {
  addCleanCopy,
  addWorktree,
  changedFiles,
  headOf,
  diffText,
  pushCommit,
  worktreeGitDir,
  removeCleanCopy,
  removeWorktree,
  syncBase,
  baseHeadOf,
  fetchBase,
  uncommittedFiles,
  worktreePath,
} from '../hooks/worktrees'
import { fakeIo } from './kit'

const ID = '12-add-dark-mode'
const WT = '/state/' + stateFolderOf('/r/.git') + '/worktrees/' + ID
const CLEAN = '/state/' + stateFolderOf('/r/.git') + '/gate/' + ID
const SHA = '0123456789abcdef0123456789abcdef01234567'
const BASE = 'f'.repeat(40)
// The job's worktree as git made it: its `.git` file names a folder of the
// repo's own git folder, and that folder names the file back.
const GIT_DIR = '/r/.git/worktrees/' + ID
const LINKED = { '/r/.git/HEAD': 'ref: refs/heads/main\n', [`${GIT_DIR}/gitdir`]: `${WT}/.git\n`, [`${WT}/.git`]: `gitdir: ${GIT_DIR}\n` }
const IN_WT = `git --git-dir=${GIT_DIR} --work-tree=${WT} -c core.fsmonitor=false -c core.hooksPath=/dev/null`
const line = (call: Parameters<typeof gitArgs>[0]) => gitArgs(call)?.join(' ') ?? null

test('every git call of the factory, word for word', async () => {
  expect(branchOf(ID)).toBe('factory/12-add-dark-mode')
  expect(line({ do: 'fetch', base: 'main' })).toBe('git fetch origin main')
  expect(line({ do: 'add', path: WT, jobId: ID, base: 'main' })).toBe(
    `git worktree add ${WT} -b factory/12-add-dark-mode refs/remotes/origin/main`,
  )
  expect(line({ do: 'remove', path: WT })).toBe(`git worktree remove --force ${WT}`)
  // One commit goes to the job's own branch, named in full. Nothing else is ever pushed.
  expect(line({ do: 'push-commit', jobId: ID, sha: SHA })).toBe(`git push origin ${SHA}:refs/heads/factory/12-add-dark-mode`)
  // A call that needs the job's folder runs in the repo and names the folder:
  // git reads no setting from a folder an agent can write to.
  expect(line({ do: 'merge-base', gitDir: GIT_DIR, workTree: WT, baseSha: BASE })).toBe(`${IN_WT} merge --no-edit ${BASE}`)
  expect(line({ do: 'abort-merge', gitDir: GIT_DIR, workTree: WT })).toBe(`${IN_WT} merge --abort`)
  expect(line({ do: 'diff-text', from: BASE, to: SHA })).toBe(`git diff --no-renames --no-ext-diff --no-textconv ${BASE}...${SHA}`)
  // A rename is shown as a file that went and a file that came: both names are checked.
  expect(line({ do: 'changed', from: BASE, to: SHA })).toBe(`git diff --name-only --no-renames -z ${BASE}...${SHA}`)
  expect(line({ do: 'uncommitted', gitDir: GIT_DIR, workTree: WT })).toBe(
    `${IN_WT} status --porcelain --no-renames --untracked-files=all -z`,
  )
  // The tip of the job's own branch: the ref that a push sends, by its full name.
  expect(line({ do: 'head', jobId: ID })).toBe('git rev-parse --verify refs/heads/factory/12-add-dark-mode^{commit}')
  // The gate's own copy of one commit, and the files of that same commit.
  expect(line({ do: 'add-clean', path: CLEAN, sha: SHA })).toBe(`git worktree add --detach ${CLEAN} ${SHA}`)
  // The base branch by the full name of its ref, so a branch or a tag that a job names
  // `origin/main` is not read in its place; then everything by commit id.
  expect(line({ do: 'base-head', base: 'main' })).toBe('git rev-parse --verify refs/remotes/origin/main^{commit}')
  expect(line({ do: 'show-settings', sha: BASE })).toBe(`git show ${BASE}:.claude/factory.json`)
})

test('a commit is named by its full id only', async () => {
  for (const sha of ['HEAD', 'main', 'abc123', '--upload-pack=x', SHA + ' x', SHA.toUpperCase(), '']) {
    expect(gitArgs({ do: 'add-clean', path: CLEAN, sha })).toBe(null)
    expect(gitArgs({ do: 'changed', from: BASE, to: sha })).toBe(null)
    expect(gitArgs({ do: 'changed', from: sha, to: SHA })).toBe(null)
    expect(gitArgs({ do: 'show-settings', sha })).toBe(null)
  }
  expect(gitArgs({ do: 'add-clean', path: '../x', sha: SHA })).toBe(null)
})

test("the gate's clean copy: made at one commit, in the state folder, and removed", async () => {
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  io.answer = git({ 'git rev-parse --verify': { exitCode: 0, stdout: SHA + '\n' }, 'git worktree': { exitCode: 0 }, 'git diff': { exitCode: 0, stdout: 'a.ts\0' } })
  expect(await headOf(io, '/r', ID)).toBe(SHA)
  expect(io.cwds[0]).toBe('/r')
  expect(await headOf(io, '/r', '../x')).toBe(null)
  expect(await changedFiles(io, '/r', BASE, SHA)).toEqual(['a.ts'])
  expect(io.cwds[1]).toBe('/r')
  expect(await addCleanCopy(io, '/r', ID, SHA)).toEqual({ ok: true, path: CLEAN })
  expect(await removeCleanCopy(io, '/r', ID)).toEqual({ ok: true })
  expect(io.ran.slice(1)).toEqual([
    `git diff --name-only --no-renames -z ${BASE}...${SHA}`,
    // A copy that an earlier run left is removed first.
    `git worktree remove --force ${CLEAN}`,
    `git worktree add --detach ${CLEAN} ${SHA}`,
    `git worktree remove --force ${CLEAN}`,
  ])
  expect(io.cwds.slice(2)).toEqual(['/r', '/r', '/r'])

  const odd = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  odd.answer = git({ 'git rev-parse --verify': { exitCode: 0, stdout: 'not a commit\n' }, 'git worktree add': { exitCode: 128, stderr: 'fatal: no' } })
  expect(await headOf(odd, '/r', ID)).toBe(null)
  expect(await addCleanCopy(odd, '/r', ID, SHA)).toEqual({ ok: false, why: 'git: fatal: no' })
  expect(await addCleanCopy(odd, '/r', ID, 'HEAD')).toEqual({ ok: false, why: 'not a job id or a branch name' })
})

test('a value that breaks a rule gives no call at all', async () => {
  expect(gitArgs({ do: 'head', jobId: '../x' })).toBe(null)
  expect(gitArgs({ do: 'head', jobId: 'main' + ' x' })).toBe(null)
  expect(gitArgs({ do: 'fetch', base: '-D' })).toBe(null)
  expect(gitArgs({ do: 'fetch', base: '--upload-pack=x' })).toBe(null)
  expect(gitArgs({ do: 'add', path: 'relative/x', jobId: ID, base: 'main' })).toBe(null)
  expect(gitArgs({ do: 'add', path: '/a/../b', jobId: ID, base: 'main' })).toBe(null)
  expect(gitArgs({ do: 'add', path: WT, jobId: ID, base: 'a b' })).toBe(null)
  expect(gitArgs({ do: 'remove', path: '-rf' })).toBe(null)
  expect(gitArgs({ do: 'remove', path: '/a\nb' })).toBe(null)
  expect(gitArgs({ do: 'base-head', base: 'x..y' + ' z' })).toBe(null)
})

test('the factory cannot force, merge into the base, or push another branch', async () => {
  const all = [
    gitArgs({ do: 'fetch', base: 'main' }),
    gitArgs({ do: 'add', path: WT, jobId: ID, base: 'main' }),
    gitArgs({ do: 'remove', path: WT }),
    gitArgs({ do: 'push-commit', jobId: ID, sha: SHA }),
    gitArgs({ do: 'merge-base', gitDir: GIT_DIR, workTree: WT, baseSha: BASE }),
    gitArgs({ do: 'abort-merge', gitDir: GIT_DIR, workTree: WT }),
    gitArgs({ do: 'diff-text', from: BASE, to: SHA }),
    gitArgs({ do: 'changed', from: BASE, to: SHA }),
    gitArgs({ do: 'uncommitted', gitDir: GIT_DIR, workTree: WT }),
    gitArgs({ do: 'head', jobId: ID }),
    gitArgs({ do: 'add-clean', path: CLEAN, sha: SHA }),
    gitArgs({ do: 'base-head', base: 'main' }),
    gitArgs({ do: 'show-settings', sha: BASE }),
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
  const pushes = all.filter(list => list.includes('push'))
  expect(pushes).toEqual([['git', 'push', 'origin', `${SHA}:refs/heads/factory/12-add-dark-mode`]])
  expect(gitArgs({ do: 'push-commit', jobId: ID, sha: 'main' })).toBe(null)
  expect(gitArgs({ do: 'push-commit', jobId: '../main', sha: SHA })).toBe(null)
  // The one merge brings the base's commit into the job's branch; nothing merges the other way.
  const merges = all.filter(list => list.includes('merge') && !list.includes('--abort'))
  expect(merges.map(list => list.slice(-3))).toEqual([['merge', '--no-edit', BASE]])
})

const git = (table: Record<string, { exitCode: number; stdout?: string; stderr?: string }>) => (argv: string[]) => {
  const key = Object.keys(table).find(start => argv.join(' ').startsWith(start))
  const hit = key === undefined ? undefined : table[key]

  return hit === undefined ? undefined : { exitCode: hit.exitCode, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
}

test('a worktree is made under the state folder, on the job branch, from the base', async () => {
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  io.answer = git({ 'git fetch': { exitCode: 0 }, 'git worktree add': { exitCode: 0 } })

  expect(await worktreePath(io, '/r', ID)).toBe(WT)
  expect(await addWorktree(io, '/r', ID, 'main')).toEqual({ ok: true, path: WT, branch: 'factory/12-add-dark-mode' })
  expect(io.ran).toEqual(['git fetch origin main', `git worktree add ${WT} -b factory/12-add-dark-mode refs/remotes/origin/main`])
})

const REFS = {
  'git rev-parse --verify refs/remotes/origin/main': { exitCode: 0, stdout: BASE + '\n' },
  'git rev-parse --verify refs/heads/factory': { exitCode: 0, stdout: SHA + '\n' },
}

test('no git call runs in the job\'s folder', async () => {
  const io = fakeIo({ files: LINKED })
  io.answer = git({ ...REFS, 'git fetch': { exitCode: 0 }, 'git push': { exitCode: 0 }, [IN_WT]: { exitCode: 0 } })
  expect(await uncommittedFiles(io, '/r', ID)).toEqual([])
  expect((await syncBase(io, '/r', ID, 'main')).ok).toBe(true)
  expect(await pushCommit(io, '/r', ID, SHA)).toEqual({ ok: true })
  expect(io.ran.at(-1)).toBe(`git push origin ${SHA}:refs/heads/factory/12-add-dark-mode`)
  expect(io.cwds.every(cwd => cwd === '/r')).toBe(true)
  expect(await pushCommit(io, '/r', ID, 'HEAD')).toEqual({ ok: false, why: 'not a job id or a branch name' })
})

test('a worktree whose link was changed is not used', async () => {
  expect(await worktreeGitDir(fakeIo({ files: LINKED }), '/r', ID)).toEqual({ gitDir: GIT_DIR, workTree: WT })
  const cases: Parameters<typeof fakeIo>[0][] = [
    // `.git` names another git folder.
    { files: { ...LINKED, [`${WT}/.git`]: 'gitdir: /elsewhere/.git/worktrees/x\n', '/elsewhere/.git/worktrees/x/gitdir': `${WT}/.git\n` } },
    // `.git` is a folder.
    { files: { '/r/.git/HEAD': 'x', [`${GIT_DIR}/gitdir`]: `${WT}/.git\n`, [`${WT}/.git/config`]: '[core]\n' } },
    // `.git` is a link.
    { files: LINKED, links: new Set([`${WT}/.git`]) },
    // The repo's folder does not name the worktree back.
    { files: { ...LINKED, [`${GIT_DIR}/gitdir`]: '/another/place/.git\n' } },
    // No worktree at all.
    { files: { '/r/.git/HEAD': 'x' } },
  ]
  for (const world of cases) {
    const io = fakeIo(world)
    io.answer = git({ ...REFS, 'git fetch': { exitCode: 0 }, git: { exitCode: 0 } })
    expect(await worktreeGitDir(io, '/r', ID)).toBe(null)
    expect(await uncommittedFiles(io, '/r', ID)).toBe(null)
    expect(await syncBase(io, '/r', ID, 'main')).toEqual({ ok: false, why: 'the worktree is not the one git made' })
    expect(io.ran).toEqual([])
  }
})

test('the text of a change, cut when it is long', async () => {
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  io.answer = git({ 'git diff --no-renames': { exitCode: 0, stdout: 'd'.repeat(1000) } })
  expect(await diffText(io, '/r', BASE, SHA)).toEqual({ text: 'd'.repeat(1000), isCut: false })
  expect(await diffText(io, '/r', BASE, SHA, 100)).toEqual({ text: 'd'.repeat(100), isCut: true })
  expect(io.cwds).toEqual(['/r', '/r'])
  expect(await diffText(io, '/r', BASE, 'HEAD')).toBe(null)
})

test('a git that fails says why, on one line', async () => {
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  io.answer = git({
    'git fetch': { exitCode: 0 },
    'git worktree add': { exitCode: 128, stderr: "fatal: a branch named 'factory/12-add-dark-mode' already exists\n" },
  })
  expect(await addWorktree(io, '/r', ID, 'main')).toEqual({
    ok: false,
    why: "git: fatal: a branch named 'factory/12-add-dark-mode' already exists",
  })
  const noFetch = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  noFetch.answer = git({ 'git fetch': { exitCode: 1, stderr: 'no network' } })
  expect(await addWorktree(noFetch, '/r', ID, 'main')).toEqual({ ok: false, why: 'git: no network' })
  expect(noFetch.ran).toEqual(['git fetch origin main'])
  expect(await addWorktree(fakeIo({ files: { '/r/.git/HEAD': 'x' } }), '/r', '../x', 'main')).toEqual({ ok: false, why: 'not a job id or a branch name' })
})

test('sync with the base: a conflict is undone and named', async () => {
  const io = fakeIo({ files: LINKED })
  io.answer = git({ ...REFS, 'git fetch': { exitCode: 0 }, [`${IN_WT} merge --no-edit`]: { exitCode: 1, stdout: 'CONFLICT (content): x' }, [`${IN_WT} merge --abort`]: { exitCode: 0 } })

  expect(await syncBase(io, '/r', ID, 'main')).toEqual({ ok: false, why: 'conflict with main' })
  expect(io.ran).toEqual([
    'git fetch origin main',
    'git rev-parse --verify refs/remotes/origin/main^{commit}',
    `${IN_WT} merge --no-edit ${BASE}`,
    `${IN_WT} merge --abort`,
  ])
  const clean = fakeIo({ files: LINKED })
  clean.answer = git({ ...REFS, 'git fetch': { exitCode: 0 }, [`${IN_WT} merge`]: { exitCode: 0 } })
  // It answers the branch's new last commit: the one to gate and to push.
  expect(await syncBase(clean, '/r', ID, 'main')).toEqual({ ok: true, sha: SHA })
  const other = fakeIo({ files: LINKED })
  other.answer = git({ ...REFS, 'git fetch': { exitCode: 0 }, [`${IN_WT} merge --no-edit`]: { exitCode: 128, stderr: 'fatal: no name was given' }, [`${IN_WT} merge --abort`]: { exitCode: 0 } })
  expect(await syncBase(other, '/r', ID, 'main')).toEqual({ ok: false, why: 'git: fatal: no name was given' })
})

test('the base branch: fetched, then read by the full name of its ref', async () => {
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  io.answer = git({ 'git fetch': { exitCode: 0 }, 'git rev-parse --verify refs/remotes/origin/main': { exitCode: 0, stdout: BASE + '\n' } })
  expect(await fetchBase(io, '/r', 'main')).toEqual({ ok: true })
  expect(await baseHeadOf(io, '/r', 'main')).toBe(BASE)
  expect(io.ran).toEqual(['git fetch origin main', 'git rev-parse --verify refs/remotes/origin/main^{commit}'])
  expect(io.cwds).toEqual(['/r', '/r'])
  expect(await baseHeadOf(io, '/r', 'gone')).toBe(null)
  expect(await baseHeadOf(io, '/r', '--x')).toBe(null)
  // No git call of the factory reads an object through a replacement.
  expect(io.envs.every(env => env?.GIT_NO_REPLACE_OBJECTS === '1')).toBe(true)
})

test('changed files, push and remove', async () => {
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  io.answer = git({
    'git diff': { exitCode: 0, stdout: 'a b.ts\0src/x.ts\0' },
    'git worktree remove': { exitCode: 0 },
  })
  expect(await changedFiles(io, '/r', BASE, SHA)).toEqual(['a b.ts', 'src/x.ts'])
  expect(await removeWorktree(io, '/r', ID)).toEqual({ ok: true })
  expect(io.ran.slice(1)).toEqual([`git worktree remove --force ${WT}`])

  const broken = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  broken.answer = git({ 'git diff': { exitCode: 128, stderr: 'bad revision' } })
  expect(await changedFiles(broken, '/r', BASE, SHA)).toBe(null)
  expect(await uncommittedFiles(broken, '/r', ID)).toBe(null)

  const dirty = fakeIo({ files: LINKED })
  dirty.answer = git({ [`${IN_WT} status`]: { exitCode: 0, stdout: '?? a b.ts\0 M src/x.ts\0D  gone.ts\0' } })
  expect(await uncommittedFiles(dirty, '/r', ID)).toEqual(['a b.ts', 'src/x.ts', 'gone.ts'])
  expect(dirty.cwds[0]).toBe('/r')
  dirty.answer = git({ [`${IN_WT} status`]: { exitCode: 0, stdout: '' } })
  expect(await uncommittedFiles(dirty, '/r', ID)).toEqual([])
  const none = fakeIo({ files: { '/r/.git/HEAD': 'x' } })
  expect(await pushCommit(none, '/r', 'not a job', SHA)).toEqual({ ok: false, why: 'not a job id or a branch name' })
  expect(none.ran).toEqual([])
})
