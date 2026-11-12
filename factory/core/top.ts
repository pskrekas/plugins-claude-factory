// Finding the top of the working tree a session is in. Pure.
//
// Two things are asked, and both must agree.
//
// The plugin looks for itself: the nearest folder, from the session's folder
// upward, that holds a `.git`. Git alone is not enough: a folder's own
// `.git/config` can make git name any path as its work tree (`core.worktree`),
// another repository of the person or a folder above this one.
//
// Git is asked too. The walk alone is not enough either: on a shared machine
// another user can put a `.git` in a folder above the session's (in `/tmp`,
// say). Git refuses a repository that another user owns, and the plugin has no
// way to see who owns a folder.
//
// When the two do not name the same folder, or git refuses or is missing, the
// session's own folder is the top: what a folder says about itself, or what a
// stranger put above it, never moves the plugin somewhere else.

export function confirmedTop(sessionReal: string, walkTop: string | null, gitTopReal: string | null): string {
  return walkTop !== null && walkTop === gitTopReal ? walkTop : sessionReal
}

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
