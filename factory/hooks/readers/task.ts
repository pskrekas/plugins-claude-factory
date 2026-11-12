// The task of the current branch: the branch, its tracker item, its pull
// request. `git` and `gh` are not commands from the settings file, so this
// reader needs no approval.
import { readIssue } from '../../adapters/github-issues'
import { readPr } from '../../adapters/github-pr'
import type { Run } from '../../adapters/tracker'
import type { PrState } from '../../core/model'
import { prHostOf, ticketOf, toolNote } from '../../core/task'
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
    const host = prHostOf(await io.remote(), settings.prHost)

    let note: string | null = null
    const issue =
      ticket !== null && settings.tracker?.kind === 'github' ? await readIssue(run, ticket) : null
    if (issue) note = toolNote(issue.result)

    let pr: PrState | null = null
    if (host === 'github') {
      const found = await readPr(run)
      pr = found.pr
      note ??= toolNote(found.result)
    } else if (host === 'azure-repos') {
      note ??= 'Azure DevOps Repos comes in a later version'
    }

    return {
      task: {
        id: issue?.item?.id ?? ticket,
        branch,
        title: issue?.item?.title.slice(0, MAX_TITLE) ?? null,
        state: issue?.item?.state.slice(0, MAX_STATE) ?? null,
        pr,
        note,
      },
    }
  },
}
