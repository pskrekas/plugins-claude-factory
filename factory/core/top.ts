// Which folder is the top of the working tree the session is in. Pure.
//
// Git is asked, but its answer is not taken on trust: a folder's own
// `.git/config` can make git name any path as its work tree (`core.worktree`),
// also another repository of the person. The answer is used only when the
// session's folder is that path or inside it; otherwise the session's own
// folder is the top. Both paths are real paths (no symbolic link left).
export function trustedTop(sessionReal: string, gitTopReal: string | null): string {
  if (gitTopReal === null || gitTopReal === '' || gitTopReal === '/') return sessionReal
  if (sessionReal === gitTopReal || sessionReal.startsWith(gitTopReal + '/')) return gitTopReal

  return sessionReal
}
