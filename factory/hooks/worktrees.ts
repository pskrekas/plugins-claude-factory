// A worktree and a branch per job. The worktree is in the state folder, not in
// the repo. Every git call comes from core/git-args.ts.
import { failureText } from '../core/comment'
import { branchOf, gitArgs, isCommitId } from '../core/git-args'
import type { GitCall } from '../core/git-args'
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
  if (there.realPath.slice(0, there.realPath.lastIndexOf('/')) !== home.realPath) return null
  const back = await pointer(io, `${gitDir}/gitdir`)
  const [named, own] = await Promise.all([back === null || back === '' ? null : io.stat(back), io.stat(dot)])
  if (named === null || own === null || named.realPath !== own.realPath) return null

  return { gitDir, workTree }
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
