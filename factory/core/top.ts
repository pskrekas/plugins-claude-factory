// Finding the top of the working tree a session is in. Pure.
//
// Git is not asked. A folder's own `.git/config` can make git name any path as
// its work tree (`core.worktree`): another repository of the person, or a
// folder above this one. So the plugin looks for itself: the top is the
// nearest folder, from the session's folder upward, that holds a `.git`. What
// a folder says about itself can then only make that folder the top.

const MAX_DEPTH = 40

// A folder and the folders above it, nearest first, as far as the root.
export function ancestorsOf(path: string): string[] {
  const start = path.length > 1 ? path.replace(/\/+$/, '') : path
  if (!start.startsWith('/')) return [start]
  const out: string[] = []
  for (let dir = start; out.length < MAX_DEPTH; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    out.push(dir)
    if (dir === '/') break
  }

  return out
}
