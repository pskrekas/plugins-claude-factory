// Every git call the factory makes, as a plain argument list. Pure.
//
// This is the whole list. The factory never forces a push, never pushes a
// branch that is not a job's own, never merges a job into the base branch, and
// never rewrites history: no function here can build such a call, and a test
// checks every list this file can answer against those rules.
import { isJobId } from './job'
import { isBranchName } from './settings'

export const branchOf = (jobId: string): string => `factory/${jobId}`

export type GitCall =
  | { do: 'fetch'; base: string }
  | { do: 'add'; path: string; jobId: string; base: string }
  | { do: 'remove'; path: string }
  | { do: 'push-commit'; jobId: string; sha: string }
  | { do: 'merge-base'; gitDir: string; workTree: string; baseSha: string }
  | { do: 'abort-merge'; gitDir: string; workTree: string }
  | { do: 'diff-text'; from: string; to: string }
  | { do: 'changed'; from: string; to: string }
  | { do: 'base-head'; base: string }
  | { do: 'show-settings'; sha: string }
  | { do: 'uncommitted'; gitDir: string; workTree: string }
  | { do: 'add-clean'; path: string; sha: string }
  | { do: 'head'; jobId: string }

// An absolute path with no `..` in it and no control character.
const isPlainPath = (path: string) =>
  path.startsWith('/') && !path.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(path)

// A commit named by its full id: 40 hex characters, or 64 in a SHA-256 repo.
// Never a name (`HEAD`, a branch), which can move between two calls.
export const isCommitId = (text: string): boolean => /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(text)

// The argument list of a call, or null when one of its values breaks a rule:
// a job id that is not one, a base that is not a branch name, a path that is
// not plain. A value is never the first word, and none can start with `-`.
export function gitArgs(call: GitCall): string[] | null {
  const hasBase = 'base' in call
  if (hasBase && !isBranchName(call.base)) return null
  if ('jobId' in call && !isJobId(call.jobId)) return null
  if ('path' in call && !isPlainPath(call.path)) return null
  if ('sha' in call && !isCommitId(call.sha)) return null
  if ('baseSha' in call && !isCommitId(call.baseSha)) return null
  if ('gitDir' in call && !(isPlainPath(call.gitDir) && isPlainPath(call.workTree))) return null
  // A call on a job's worktree runs in the repo and names the worktree. Git
  // then reads its settings from the repo's own git folder, never through the
  // `.git` file of a folder that an agent can write to; and it starts no
  // program that a setting names.
  const inTree = (gitDir: string, workTree: string) => [
    'git',
    `--git-dir=${gitDir}`,
    `--work-tree=${workTree}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
  ]
  if ('from' in call && !(isCommitId(call.from) && isCommitId(call.to))) return null

  switch (call.do) {
    case 'fetch':
      return ['git', 'fetch', 'origin', call.base]
    case 'add':
      // The base by the full name of its ref: a branch or a tag that a job
      // names `origin/<base>` is never read in its place.
      return ['git', 'worktree', 'add', call.path, '-b', branchOf(call.jobId), `refs/remotes/origin/${call.base}`]
    case 'remove':
      // The worktree's own flag: the folder of a job that ended goes with what it holds.
      return ['git', 'worktree', 'remove', '--force', call.path]
    case 'push-commit':
      // One commit, by its id, to the job's own branch, by the ref's full
      // name: what is pushed is what was read, and it can go nowhere else.
      return ['git', 'push', 'origin', `${call.sha}:refs/heads/${branchOf(call.jobId)}`]
    case 'merge-base':
      // Brings the base's commit into the job's branch, in the job's worktree.
      return [...inTree(call.gitDir, call.workTree), 'merge', '--no-edit', call.baseSha]
    case 'abort-merge':
      return [...inTree(call.gitDir, call.workTree), 'merge', '--abort']
    case 'diff-text':
      // No program of the repo's settings is started to show a file.
      return ['git', 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', `${call.from}...${call.to}`]
    case 'changed':
      // No rename detection: a moved file is listed under both its names, so
      // a protected path that was moved away is still seen.
      // Both ends are commit ids: what is listed is what was read, whatever a
      // ref points at a moment later.
      return ['git', 'diff', '--name-only', '--no-renames', '-z', `${call.from}...${call.to}`]
    case 'base-head':
      return ['git', 'rev-parse', '--verify', `refs/remotes/origin/${call.base}^{commit}`]
    case 'show-settings':
      return ['git', 'show', `${call.sha}:.claude/factory.json`]
    case 'add-clean':
      // A second working tree at one commit, on no branch: what the gate runs in.
      return ['git', 'worktree', 'add', '--detach', call.path, call.sha]
    case 'uncommitted':
      // What the job's worktree holds that its branch does not.
      return [...inTree(call.gitDir, call.workTree), 'status', '--porcelain', '--no-renames', '--untracked-files=all', '-z']
    case 'head':
      // The tip of the job's own branch, by the ref's full name: the commit a
      // push of that branch sends. Not `HEAD`, which is wherever a folder is.
      return ['git', 'rev-parse', '--verify', `refs/heads/${branchOf(call.jobId)}^{commit}`]
  }
}
