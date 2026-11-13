// A worktree and a branch per job. The worktree is in the state folder, not in
// the repo. Every git call comes from core/git-args.ts.
import { failureText } from '../core/comment'
import { branchOf, commitMessage, gitArgs, isCommitId } from '../core/git-args'
import type { GitCall } from '../core/git-args'
import { clean } from '../core/rows'
import type { RunResult } from '../core/run'
import type { Io } from './io'
import { stateDirOf } from './jobs'
import { consentKeyOf } from './readers/repo'

const GIT_TIMEOUT_MS = 120_000
const BAD = 'not a job id or a branch name'
const NOT_GITS = 'the worktree is not the one git made'
const MAX_POINTER = 4096

type Done = { ok: boolean; why?: string }

const passed = (result: RunResult) => !('failed' in result) && result.exitCode === 0

// Git reads every object as it is: a replacement (`git replace`) that a job
// made could show the gate one tree while a push sends another.
const GIT_ENV = { GIT_NO_REPLACE_OBJECTS: '1' }

// Runs one call in `cwd`. Null when the call itself breaks a rule: nothing ran.
export async function git(io: Io, cwd: string, call: GitCall): Promise<RunResult | null> {
  const argv = gitArgs(call)

  return argv === null ? null : io.run(argv, { cwd, timeoutMs: GIT_TIMEOUT_MS, env: GIT_ENV })
}

const done = (result: RunResult | null): Done =>
  result === null ? { ok: false, why: BAD } : passed(result) ? { ok: true } : { ok: false, why: failureText('git', result) }

export async function worktreePath(io: Io, root: string, jobId: string): Promise<string | null> {
  const dir = await stateDirOf(io, root)

  return dir === null ? null : `${dir}/worktrees/${jobId}`
}

export async function addWorktree(
  io: Io,
  root: string,
  jobId: string,
  base: string,
): Promise<{ ok: true; path: string; branch: string } | { ok: false; why: string }> {
  const path = await worktreePath(io, root, jobId)
  if (path === null) return { ok: false, why: 'no state folder' }
  if (gitArgs({ do: 'add', path, jobId, base }) === null) return { ok: false, why: BAD }
  for (const call of [{ do: 'fetch', base }, { do: 'add', path, jobId, base }] as GitCall[]) {
    const step = done(await git(io, root, call))
    if (!step.ok) return { ok: false, why: step.why ?? 'git failed' }
  }

  return { ok: true, path, branch: branchOf(jobId) }
}

export async function removeWorktree(io: Io, root: string, jobId: string): Promise<Done> {
  const path = await worktreePath(io, root, jobId)

  return path === null ? { ok: false, why: 'no state folder' } : done(await git(io, root, { do: 'remove', path }))
}

// The first line of a small file that is not a link, or null.
async function pointer(io: Io, path: string): Promise<string | null> {
  if (await io.isLink(path)) return null
  const info = await io.stat(path)
  if (info === null || info.kind !== 'file' || info.size > MAX_POINTER) return null

  return ((await io.readFile(path)) ?? '').split('\n')[0]?.trim() ?? null
}

// A job's worktree, named for a git call that runs in the repo: the folder of
// the repo's own git folder that belongs to it, and the worktree itself.
//
// An agent can write to the worktree, so its `.git` file is only a claim. It
// is believed when it is a plain file (not a link, not a folder) that names a
// folder directly under `<the repo's git folder>/worktrees/`, and that folder
// names the file back. Null for anything else: then no call is made.
export async function worktreeGitDir(
  io: Io,
  root: string,
  jobId: string,
): Promise<{ gitDir: string; workTree: string } | null> {
  const workTree = await worktreePath(io, root, jobId)
  if (workTree === null || gitArgs({ do: 'head', jobId }) === null) return null
  const dot = `${workTree}/.git`
  const line = await pointer(io, dot)
  const gitDir = line?.startsWith('gitdir:') ? line.slice('gitdir:'.length).trim() : ''
  if (!gitDir.startsWith('/') || gitDir.split('/').includes('..')) return null
  // The repo's own git folder: `<root>/.git`, or the main checkout's when
  // `root` is itself a worktree (checked both ways by `consentKeyOf`).
  const common = await consentKeyOf(io, root)
  const [there, home] = await Promise.all([io.stat(gitDir), io.stat(`${common}/worktrees`)])
  if (!common.endsWith('/.git') || there === null || home === null || there.kind !== 'dir') return null
  // From here on only the real folder is used, and it must be one name under
  // the repo's `worktrees/`. The text of the `.git` file is never handed to
  // git: it could be a path through a link that is turned elsewhere later.
  const real = there.realPath
  const name = real.slice(home.realPath.length + 1)
  if (real !== `${home.realPath}/${name}` || name === '' || name.includes('/')) return null
  const back = await pointer(io, `${real}/gitdir`)
  const [named, own] = await Promise.all([back === null || back === '' ? null : io.stat(back), io.stat(dot)])
  if (named === null || own === null || named.realPath !== own.realPath) return null
  // A git repository inside the folder (a `.git` below the top, or a second
  // one beside git's own by another case) can name a program in its own
  // settings, and git would start that program when it looks into the
  // folder. With one there, no git call is made on the folder at all.
  const entries = await gitEntries(io, root, workTree)
  if (entries === null || entries.length !== 1 || entries[0] !== dot) return null

  return { gitDir: real, workTree }
}

// Puts a folder's own `.git` file back as git made it: one plain file that
// names the folder of the repository's git folder that names it back. A
// command in a container can put anything in its place (a git repository of
// its own, a link), and then a `git` that a person, the engine or a tool
// runs in that folder would read the builder's settings and start the
// programs they name. Called only when nothing of the job runs. Every other
// entry named `.git`, by any case, at the top of the folder is removed.
// False when git knows no such folder: then nothing is written, and a `.git`
// that is not a plain file is still removed.
export async function healGitFile(io: Io, root: string, folder: string): Promise<boolean> {
  const here = await io.stat(folder)
  if (here === null || here.kind !== 'dir') return false
  const common = await consentKeyOf(io, root)
  const home = common.endsWith('/.git') ? await io.stat(`${common}/worktrees`) : null
  let expected: string | null = null
  for (const entry of home === null || home.kind !== 'dir' ? [] : await io.listDir(home.realPath)) {
    if (!entry.endsWith('/')) continue
    const gitDir = `${home?.realPath}/${entry.slice(0, -1)}`
    const back = await pointer(io, `${gitDir}/gitdir`)
    const parent = back === null || !back.endsWith('/.git') ? null : await io.stat(back.slice(0, -'/.git'.length))
    if (parent === null || parent.realPath !== here.realPath) continue
    expected = `gitdir: ${gitDir}\n`
    break
  }
  const dot = `${folder}/.git`
  let isWhole = false
  const entries = await io.listDir(folder)
  // A list that does not show what is at the name cannot be trusted (the
  // folder could not be listed): nothing is removed and nothing is written.
  const isThere = (await io.isLink(dot)) || (await io.stat(dot)) !== null
  if (isThere && !entries.some(entry => (entry.endsWith('/') ? entry.slice(0, -1) : entry).toLowerCase() === '.git')) return false
  for (const entry of entries) {
    const name = entry.endsWith('/') ? entry.slice(0, -1) : entry
    if (name.toLowerCase() !== '.git') continue
    const info = name === '.git' && !entry.endsWith('/') && !(await io.isLink(dot)) ? await io.stat(dot) : null
    const isPlain = info !== null && info.kind === 'file' && info.size <= MAX_POINTER
    // With no known pointer a plain file is left: the plugin's own check refuses a wrong one.
    if (isPlain && expected === null) continue
    if (isPlain && (await io.readFile(dot)) === expected) {
      isWhole = true
      continue
    }
    // By its name with no `/` at the end: a link is removed, not followed.
    const removed = await io.run(['rm', '-r', '-f', `${folder}/${name}`], { timeoutMs: GIT_TIMEOUT_MS })
    if ('failed' in removed || removed.exitCode !== 0) return false
  }
  if (expected === null) return false
  if (isWhole) return true
  // The pointer is never written to the name itself: a write follows a link.
  // It is written in the plugin's own folder and put in place by one rename,
  // and only when nothing is at the name; then what is there is checked.
  const dir = await stateDirOf(io, root)
  if (dir === null || (await io.isLink(dot)) || (await io.stat(dot)) !== null) return false
  const fresh = () => Math.random().toString(36).slice(2)
  const temp = `${dir}/tmp/${fresh()}${fresh()}.tmp`
  await io.run(['mkdir', '-p', `${dir}/tmp`])
  await io.writeFile(temp, expected)
  const moved = await io.run(['mv', '-f', temp, dot])
  const after = 'failed' in moved || moved.exitCode !== 0 || (await io.isLink(dot)) ? null : await io.stat(dot)
  if (after === null || after.kind !== 'file' || after.realPath !== `${here.realPath}/.git` || (await io.readFile(dot)) !== expected) {
    await io.run(['rm', '-f', temp])

    return false
  }

  return true
}

const FIND_TIMEOUT_MS = 60_000

// Every entry of a job's folder that is named `.git`, by any case; null when
// the folder cannot be listed. `find` follows no link.
async function gitEntries(io: Io, root: string, workTree: string): Promise<string[] | null> {
  const found = await io.run(['find', workTree, '-mindepth', '1', '-iname', '.git', '-print'], { cwd: root, timeoutMs: FIND_TIMEOUT_MS })
  if ('failed' in found || found.exitCode !== 0 || found.isCut === true) return null

  return found.stdout.split('\n').filter(line => line !== '')
}

// Removes the local branch of a job that ended, so its item can run again.
export async function dropBranch(io: Io, root: string, jobId: string): Promise<Done> {
  return gitArgs({ do: 'drop-branch', jobId }) === null ? { ok: false, why: BAD } : done(await git(io, root, { do: 'drop-branch', jobId }))
}

// Sends one commit to the job's own branch on the remote. Run in the repo.
export async function pushCommit(io: Io, root: string, jobId: string, sha: string): Promise<Done> {
  if (gitArgs({ do: 'push-commit', jobId, sha }) === null) return { ok: false, why: BAD }

  return done(await git(io, root, { do: 'push-commit', jobId, sha }))
}

// Brings the base branch's last commit into the job's branch, in the job's
// worktree. A conflict is undone, and named. Answers the branch's new last
// commit: the one to gate and to push.
export async function syncBase(io: Io, root: string, jobId: string, base: string): Promise<Done & { sha?: string }> {
  if (gitArgs({ do: 'add', path: '/x', jobId, base }) === null) return { ok: false, why: BAD }
  const tree = await worktreeGitDir(io, root, jobId)
  if (tree === null) return { ok: false, why: NOT_GITS }
  const fetched = await fetchBase(io, root, base)
  if (!fetched.ok) return fetched
  const baseSha = await baseHeadOf(io, root, base)
  if (baseSha === null) return { ok: false, why: `no branch origin/${base}` }
  const merged = await git(io, root, { do: 'merge-base', ...tree, baseSha })
  if (merged !== null && passed(merged)) {
    const sha = await headOf(io, root, jobId)

    return sha === null ? { ok: false, why: 'the merged commit could not be read' } : { ok: true, sha }
  }
  await git(io, root, { do: 'abort-merge', ...tree })
  const said = merged === null || 'failed' in merged ? '' : merged.stdout + merged.stderr

  return { ok: false, why: said.includes('CONFLICT') ? `conflict with ${base}` : (done(merged).why ?? 'git failed') }
}

// Brings the base branch's ref up to date with the remote.
export async function fetchBase(io: Io, root: string, base: string): Promise<Done> {
  return done(await git(io, root, { do: 'fetch', base }))
}

// The last commit of the base branch as the remote has it, by its full id.
export async function baseHeadOf(io: Io, root: string, base: string): Promise<string | null> {
  const result = await git(io, root, { do: 'base-head', base })
  if (result === null || 'failed' in result || result.exitCode !== 0) return null
  const sha = result.stdout.trim()

  return isCommitId(sha) ? sha : null
}

// The files that commit `to` changed since it left the line of commit `from`,
// or null when git cannot say. Asked in the repo, by commit id: nothing a
// job's folder holds takes part.
export async function changedFiles(io: Io, root: string, from: string, to: string): Promise<string[] | null> {
  const result = await git(io, root, { do: 'changed', from, to })
  if (result === null || 'failed' in result || result.exitCode !== 0) return null

  return result.stdout.split('\0').filter(name => name !== '')
}

// The last commit of a job's branch `factory/<job id>`, by its full id. Null
// when git cannot say. It is read from the branch, in the repo, and not from
// the HEAD of the job's folder: a folder can be on another branch or on none,
// and the branch is what a push sends.
export async function headOf(io: Io, root: string, jobId: string): Promise<string | null> {
  const result = await git(io, root, { do: 'head', jobId })
  if (result === null || 'failed' in result || result.exitCode !== 0) return null
  const sha = result.stdout.trim()

  return isCommitId(sha) ? sha : null
}

// The gate's own copy of a job's commit: a second working tree in the state
// folder, `gate/<job id>`. It holds what the commit holds and nothing else:
// no file the builder left in its folder, no file git was told to overlook.
const cleanPath = async (io: Io, root: string, jobId: string) => {
  const dir = await stateDirOf(io, root)

  return dir === null || gitArgs({ do: 'head', jobId }) === null ? null : `${dir}/gate/${jobId}`
}

export async function addCleanCopy(
  io: Io,
  root: string,
  jobId: string,
  sha: string,
): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
  const path = await cleanPath(io, root, jobId)
  if (path === null || gitArgs({ do: 'add-clean', path, sha }) === null) return { ok: false, why: BAD }
  // A copy that an earlier run left (a crash) goes first. No copy is the usual case.
  await git(io, root, { do: 'remove', path })
  const made = done(await git(io, root, { do: 'add-clean', path, sha }))

  return made.ok ? { ok: true, path } : { ok: false, why: made.why ?? 'git failed' }
}

// A plan job's folder: the base's commit, on no branch, where a job's
// worktree would be. A dry run makes no branch.
export async function addPlanTree(io: Io, root: string, jobId: string, sha: string): Promise<Done> {
  const path = await worktreePath(io, root, jobId)
  if (path === null || gitArgs({ do: 'head', jobId }) === null || gitArgs({ do: 'add-clean', path, sha }) === null) return { ok: false, why: BAD }

  return done(await git(io, root, { do: 'add-clean', path, sha }))
}

export async function removeCleanCopy(io: Io, root: string, jobId: string): Promise<Done> {
  const path = await cleanPath(io, root, jobId)

  return path === null ? { ok: false, why: BAD } : done(await git(io, root, { do: 'remove', path }))
}

// The files of a job's worktree that are changed or new and not committed
// (ignored files are not listed). Null when git could not say.
export async function uncommittedFiles(io: Io, root: string, jobId: string): Promise<string[] | null> {
  const tree = await worktreeGitDir(io, root, jobId)
  const result = tree === null ? null : await git(io, root, { do: 'uncommitted', ...tree })
  if (result === null || 'failed' in result || result.exitCode !== 0) return null

  // Each entry is two state letters, a space, then the name.
  return result.stdout
    .split('\0')
    .filter(entry => entry.length > 3)
    .map(entry => entry.slice(3))
}

// Commits what a job's worktree holds and its branch does not, under the
// fixed message: the builder has no git, so the plugin makes the commit. A
// folder with nothing new gets no commit. A git repository of its own inside
// the folder is not committed: the gate's copy would not hold its files.
export async function commitAll(io: Io, root: string, job: { id: string; itemId: string; round: number }): Promise<Done & { isNew?: boolean }> {
  const tree = await worktreeGitDir(io, root, job.id)
  if (tree === null) {
    // Say which one, when the reason is a git repository inside the folder.
    const path = await worktreePath(io, root, job.id)
    const inner = path === null ? undefined : (await gitEntries(io, root, path))?.find(entry => entry !== `${path}/.git`)

    return { ok: false, why: inner === undefined || path === null ? NOT_GITS : `the code folder holds a git repository of its own (${clean(inner.slice(path.length + 1)).slice(0, 100)}): the line does not commit one` }
  }
  const left = await git(io, root, { do: 'uncommitted', ...tree })
  if (left === null || !passed(left)) return { ok: false, why: done(left).why ?? 'git failed' }
  if (!('failed' in left) && left.stdout === '') return { ok: true, isNew: false }
  const added = done(await git(io, root, { do: 'add-all', ...tree }))
  if (!added.ok) return added
  const staged = await git(io, root, { do: 'staged', ...tree })
  if (staged === null || 'failed' in staged || staged.exitCode !== 0 || staged.isCut === true) return { ok: false, why: done(staged).why ?? 'what the commit holds could not be read' }
  // Entries are `:<old mode> <new mode> <old id> <new id> <letter>`, then the name.
  const parts = staged.stdout.split('\0')
  const inner = parts.findIndex(part => /^:[0-7]{6} 160000 /.test(part))
  if (inner >= 0) return { ok: false, why: `the code folder holds a git repository of its own (${(parts[inner + 1] ?? '').slice(0, 100)}): the line does not commit one` }
  const made = done(await git(io, root, { do: 'commit', ...tree, message: commitMessage(job.itemId, job.round) }))

  return made.ok ? { ok: true, isNew: true } : made
}

// The text of what commit `to` changed since it left the line of `from`, for
// a reader with no shell. Cut at `max` characters.
export async function diffText(
  io: Io,
  root: string,
  from: string,
  to: string,
  max = 400_000,
): Promise<{ text: string; isCut: boolean } | null> {
  const result = await git(io, root, { do: 'diff-text', from, to })
  if (result === null || 'failed' in result || result.exitCode !== 0) return null

  return { text: result.stdout.slice(0, max), isCut: result.stdout.length > max || result.isCut === true }
}
