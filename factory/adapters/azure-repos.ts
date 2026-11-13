// Azure DevOps Repos as a pull request host, through the `az` command with
// the person's own login. Every argument list comes from core/azure.ts.
//
// The factory never merges: no call here completes a pull request. It opens
// a draft, marks it ready, reads it, comments, and abandons the pull request
// of a job that a person dropped.
import { azArgs } from '../core/azure'
import type { AzCall, AzPlace } from '../core/azure'
import type { PrState } from '../core/model'
import { clean } from '../core/rows'
import type { RunResult } from '../core/run'
import type { Put } from './azure-boards'
import type { PrHost } from './pr-host'
import type { Run } from './tracker'

const STATES: Record<string, PrState['state']> = { active: 'open', completed: 'merged', abandoned: 'closed' }
const NOTHING_RAN: RunResult = { failed: 'other' }
const MAX_TITLE = 200

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}
const passed = (result: RunResult): result is { exitCode: number; stdout: string; stderr: string } => !('failed' in result) && result.exitCode === 0

// One pull request, or the first of a list (`az repos pr list` answers the
// newest first). The address is built from the place. `build` is `none`
// here: the policies say it (`parseAzPolicies`).
export function parseAzPr(json: string, place: AzPlace): PrState | null {
  const all = parsed(json)
  const raw = Array.isArray(all) ? all[0] : all
  if (!isObject(raw) || typeof raw.pullRequestId !== 'number' || !Number.isInteger(raw.pullRequestId)) return null
  const state = STATES[String(raw.status)]
  if (state === undefined) return null
  // A vote: 10 approved, 5 approved with suggestions, -5 waiting, -10 rejected.
  const votes = (Array.isArray(raw.reviewers) ? raw.reviewers.filter(isObject) : []).map(reviewer => (typeof reviewer.vote === 'number' ? reviewer.vote : 0))

  return {
    number: raw.pullRequestId,
    state,
    isDraft: raw.isDraft === true,
    build: 'none',
    approvals: votes.some(vote => vote < 0) ? 0 : votes.filter(vote => vote >= 5).length,
    url: `${place.org}/${encodeURIComponent(place.project)}/_git/${encodeURIComponent(place.repo)}/pullrequest/${raw.pullRequestId}`,
  }
}

// The build state of a pull request, from its policies (a build is one).
export function parseAzPolicies(json: string): PrState['build'] {
  const all = parsed(json)
  const states = (Array.isArray(all) ? all.filter(isObject) : [])
    .filter(policy => !(isObject(policy.configuration) && policy.configuration.isEnabled === false))
    .map(policy => String(policy.status))
    .filter(status => status !== 'notApplicable')
  if (states.length === 0) return 'none'
  if (states.some(status => status === 'rejected' || status === 'broken')) return 'red'

  return states.some(status => status === 'running' || status === 'queued') ? 'running' : 'green'
}

export function azureRepos(run: Run, put: Put, place: AzPlace): PrHost {
  const az = async (call: AzCall): Promise<RunResult> => {
    const argv = azArgs(call)

    return argv === null ? NOTHING_RAN : run(argv)
  }
  const drop = async (...files: (string | null)[]) => {
    for (const file of files) if (file !== null) await run(['rm', '-f', file]).catch(() => undefined)
  }
  // A pull request with its build state. A policy list that cannot be read leaves `none`.
  const withBuild = async (result: RunResult): Promise<{ pr: PrState | null; result: RunResult }> => {
    const pr = passed(result) ? parseAzPr(result.stdout, place) : null
    if (pr === null) return { pr: null, result }
    const policies = await az({ do: 'pr-policies', place, pr: pr.number })

    return { pr: { ...pr, build: passed(policies) ? parseAzPolicies(policies.stdout) : 'none' }, result }
  }

  return {
    kind: 'azure-repos',
    // A draft from a job's branch. The title and the text go to `az` in two
    // files: `az` reads an argument that starts with `@` as a file's name.
    open: async pr => {
      if (azArgs({ do: 'pr-open', place, head: pr.head, base: pr.base, titleFile: '/x.txt', bodyFile: '/x.txt' }) === null) return { pr: null, result: NOTHING_RAN }
      const titleFile = await put(clean(pr.title).slice(0, MAX_TITLE) || 'Factory job', 'txt')
      const bodyFile = titleFile === null ? null : await put(pr.body, 'txt')
      try {
        if (titleFile === null || bodyFile === null) return { pr: null, result: NOTHING_RAN }
        const result = await az({ do: 'pr-open', place, head: pr.head, base: pr.base, titleFile, bodyFile })
        const made = passed(result) ? parseAzPr(result.stdout, place) : null

        return { pr: made === null ? null : { number: made.number, url: made.url }, result }
      } finally {
        await drop(titleFile, bodyFile)
      }
    },
    ready: number => az({ do: 'pr-ready', place, pr: number }),
    read: async number => withBuild(await az({ do: 'pr-show', place, pr: number })),
    current: async branch => withBuild(await az({ do: 'pr-of-branch', place, branch })),
    // A comment is a new thread on the pull request: one JSON file.
    comment: async (number, markdown) => {
      if (azArgs({ do: 'pr-show', place, pr: number }) === null) return NOTHING_RAN
      const file = await put(JSON.stringify({ comments: [{ parentCommentId: 0, content: markdown, commentType: 1 }], status: 1 }), 'json')
      if (file === null) return NOTHING_RAN
      try {
        return await az({ do: 'pr-thread', place, pr: number, file })
      } finally {
        await drop(file)
      }
    },
    // The pull request of a job that a person dropped is abandoned. Never completed.
    close: number => az({ do: 'pr-abandon', place, pr: number }),
  }
}
