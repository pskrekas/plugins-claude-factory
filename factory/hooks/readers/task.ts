// The task of the current branch: the branch, its tracker item, its pull
// request. `git`, `gh` and `az` are not commands from the settings file, so
// this reader needs no approval.
import { readIssue } from '../../adapters/github-issues'
import type { Run, TrackerItem } from '../../adapters/tracker'
import type { PrState } from '../../core/model'
import { isBranchName } from '../../core/settings'
import { ticketOf, toolNote } from '../../core/task'
import { adaptersOf } from '../adapters'
import type { Reader } from '../refresh'

const GIT_TIMEOUT_MS = 5_000
const GH_TIMEOUT_MS = 15_000
const MAX_BRANCH = 200
const MAX_TITLE = 120
const MAX_STATE = 20

export const taskReader: Reader = {
  name: 'task',
  read: async (io, ctx) => {
    const git = await io.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ctx.root,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    const branch = 'failed' in git || git.exitCode !== 0 ? '' : git.stdout.trim().slice(0, MAX_BRANCH)
    if (branch === '') return { task: null }

    const run: Run = argv => io.run(argv, { cwd: ctx.root, timeoutMs: GH_TIMEOUT_MS })
    const { settings } = ctx
    const ticket = ticketOf(branch, settings.ticketPattern)

    if (ctx.isLight) {
      // No `gh` at session start: the branch and the ticket id are enough.
      return { task: { id: ticket, branch, title: null, state: null, pr: null, note: null } }
    }

    // The tracker and the pull request host of this repository, each by itself.
    const { tracker, host } = await adaptersOf(io, ctx.root, settings, GH_TIMEOUT_MS)
    let note: string | null = null
    let item: TrackerItem | null = null
    if (ticket !== null && settings.tracker?.kind === 'github') {
      // The issue of the checked-out repository, as `gh` finds it.
      const issue = await readIssue(run, ticket)
      item = issue.item
      note = toolNote(issue.result)
    } else if (ticket !== null && tracker !== null) {
      item = await tracker.read(ticket).catch(() => null)
    }

    let pr: PrState | null = null
    // Azure Repos is asked by the branch's name: only a name that can be nothing but a branch.
    if (host !== null && (host.kind === 'github' || isBranchName(branch))) {
      const found = await host.current(branch)
      pr = found.pr
      note ??= toolNote(found.result, host.kind === 'github' ? 'gh' : 'az')
    }

    return {
      task: {
        id: item?.id ?? ticket,
        branch,
        title: item?.title.slice(0, MAX_TITLE) ?? null,
        state: item?.state.slice(0, MAX_STATE) ?? null,
        pr,
        note,
      },
    }
  },
}
