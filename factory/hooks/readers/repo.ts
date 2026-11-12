// Which repository a working tree belongs to, for the approvals' store key.
import type { Io } from '../io'

const MAX_POINTER_BYTES = 4096

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// A small text file's first line, or null.
async function pointer(io: Io, path: string): Promise<string | null> {
  const info = await io.stat(path)
  if (info === null || info.kind !== 'file' || info.size > MAX_POINTER_BYTES) return null
  const text = await io.readFile(info.realPath)

  return text === null ? null : (text.split('\n')[0] ?? '').trim()
}

// The key the approvals of the working tree at `root` are kept under.
//
// - A normal checkout: its own `.git` folder.
// - A linked worktree: the main checkout's `.git` folder, so every worktree of
//   one repository shares its approvals. This is granted only when the link
//   holds in both directions: the tree's `.git` file names a folder under
//   `<main .git>/worktrees/`, and that folder's `gitdir` file names this tree's
//   `.git` back. The second file is inside the main repository, so a folder
//   that merely claims to be a worktree of someone's repository (unpacked from
//   an archive, say) cannot write it.
// - Anything else (no git, a submodule, a link that does not check out): the
//   tree's own path. What git itself would answer is not asked: a hostile tree
//   can make git name any folder.
export async function consentKeyOf(io: Io, root: string): Promise<string> {
  const dotGit = await io.stat(`${root}/.git`)
  const own = (await io.stat(root))?.realPath ?? root
  if (dotGit === null) return own
  if (dotGit.kind === 'dir') return dotGit.realPath

  const line = await pointer(io, `${root}/.git`)
  const target = line?.startsWith('gitdir:') ? line.slice('gitdir:'.length).trim() : ''
  if (target === '') return own
  const gitDir = await io.stat(target.startsWith('/') ? target : `${root}/${target}`)
  if (gitDir === null || gitDir.kind !== 'dir') return own
  const worktrees = parentOf(gitDir.realPath)
  if (nameOf(worktrees) !== 'worktrees') return own

  // The way back: <main .git>/worktrees/<name>/gitdir must name this tree's `.git`.
  const back = await pointer(io, `${gitDir.realPath}/gitdir`)
  const named = back === null || back === '' ? null : await io.stat(back)
  if (named === null || named.realPath !== dotGit.realPath) return own

  return parentOf(worktrees)
}
