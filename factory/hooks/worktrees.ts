// A worktree and a branch per job. The worktree is in the state folder, not in
// the repo. Every git call comes from core/git-args.ts.
import { failureText } from '../core/comment'
import { branchOf, gitArgs, isCommitId } from '../core/git-args'
import type { GitCall } from '../core/git-args'
import type { RunResult } from '../core/run'
import type { Io } from './io'
import { stateDirOf } from './jobs'

const GIT_TIMEOUT_MS = 120_000
const BAD = 'not a job id or a branch name'

type Done = { ok: boolean; why?: string }

const passed = (result: RunResult) => !('failed' in result) && result.exitCode === 0

// Runs one call in `cwd`. Null when the call itself breaks a rule: nothing ran.
async function git(io: Io, cwd: string, call: GitCall): Promise<RunResult | null> {
  const argv = gitArgs(call)

  return argv === null ? null : io.run(argv, { cwd, timeoutMs: GIT_TIMEOUT_MS })
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

export async function pushBranch(io: Io, root: string, jobId: string): Promise<Done> {
  if (gitArgs({ do: 'push', jobId }) === null) return { ok: false, why: BAD }
  const path = await worktreePath(io, root, jobId)

  return path === null ? { ok: false, why: 'no state folder' } : done(await git(io, path, { do: 'push', jobId }))
}

// Brings the base branch into the job's branch. A conflict is undone, and named.
export async function syncBase(io: Io, root: string, jobId: string, base: string): Promise<Done> {
  if (gitArgs({ do: 'add', path: '/x', jobId, base }) === null) return { ok: false, why: BAD }
  const path = await worktreePath(io, root, jobId)
  if (path === null) return { ok: false, why: 'no state folder' }
  const fetched = done(await git(io, path, { do: 'fetch', base }))
  if (!fetched.ok) return fetched
  if (done(await git(io, path, { do: 'merge-base', base })).ok) return { ok: true }
  await git(io, path, { do: 'abort-merge' })

  return { ok: false, why: `conflict with ${base}` }
}

// The files the job's branch changed against the base, or null when git cannot
// say. With `at`, the files of that one commit and not of wherever HEAD is now.
export async function changedFiles(
  io: Io,
  root: string,
  jobId: string,
  base: string,
  at?: string,
): Promise<string[] | null> {
  const path = await worktreePath(io, root, jobId)
  const result = path === null ? null : await git(io, path, { do: 'changed', base, at })
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

  return dir === null || gitArgs({ do: 'push', jobId }) === null ? null : `${dir}/gate/${jobId}`
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
  const path = await worktreePath(io, root, jobId)
  const result = path === null ? null : await git(io, path, { do: 'uncommitted' })
  if (result === null || 'failed' in result || result.exitCode !== 0) return null

  // Each entry is two state letters, a space, then the name.
  return result.stdout
    .split('\0')
    .filter(entry => entry.length > 3)
    .map(entry => entry.slice(3))
}
