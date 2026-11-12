// The worktrees of the repo and the agents of the session. `git` is not a
// command from the settings file, so this reader needs no approval.
import { agentRows, parseMerged, parseWorktrees } from '../../core/work'
import type { Reader } from '../refresh'

const GIT_TIMEOUT_MS = 10_000

export const workReader: Reader = {
  name: 'work',
  read: async (io, ctx, prev) => {
    const init = { cwd: ctx.root, timeoutMs: GIT_TIMEOUT_MS }
    const base = ctx.settings.baseBranch
    const [list, merged, agents] = await Promise.all([
      io.run(['git', 'worktree', 'list', '--porcelain'], init),
      io.run(['git', 'branch', '--merged', base, '--format=%(refname:short)'], init),
      io.agents(),
    ])
    const ok = (result: typeof list) => !('failed' in result) && result.exitCode === 0

    return {
      worktrees: ok(list)
        ? parseWorktrees(
            'failed' in list ? '' : list.stdout,
            ok(merged) && !('failed' in merged) ? parseMerged(merged.stdout) : [],
            base,
          )
        : [],
      agents: agentRows(agents, prev.agents, ctx.now),
    }
  },
}
