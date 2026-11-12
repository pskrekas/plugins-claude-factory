// The pull request of the current branch, through the `gh` command.
import { isJobId } from '../core/job'
import type { PrState } from '../core/model'
import { clean } from '../core/rows'
import type { RunResult } from '../core/run'
import { isBranchName } from '../core/settings'
import type { PrHost } from './pr-host'
import type { Run } from './tracker'

const FIELDS = 'number,state,isDraft,reviewDecision,statusCheckRollup,url'
const STATES: Record<string, PrState['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }
const RED = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']
const WAITING = ['PENDING', 'EXPECTED']

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// A rollup entry is a check run (`status`, `conclusion`) or a commit status (`state`).
function buildOf(rollup: unknown): PrState['build'] {
  const entries = Array.isArray(rollup) ? rollup.filter(isObject) : []
  if (entries.length === 0) return 'none'
  const isRed = (e: Record<string, unknown>) =>
    RED.includes(String(e.conclusion ?? '')) || RED.includes(String(e.state ?? ''))
  const isRunning = (e: Record<string, unknown>) =>
    (typeof e.status === 'string' && e.status !== 'COMPLETED') || WAITING.includes(String(e.state ?? ''))
  if (entries.some(isRed)) return 'red'

  return entries.some(isRunning) ? 'running' : 'green'
}

export function parseGhPr(json: string): PrState | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!isObject(raw) || typeof raw.number !== 'number') return null
  const state = STATES[String(raw.state)]
  if (state === undefined) return null

  return {
    number: raw.number,
    state,
    isDraft: raw.isDraft === true,
    build: buildOf(raw.statusCheckRollup),
    approvals: raw.reviewDecision === 'APPROVED' ? 1 : 0,
    url: typeof raw.url === 'string' ? raw.url : '',
  }
}

export async function readPr(run: Run): Promise<{ pr: PrState | null; result: RunResult }> {
  const result = await run(['gh', 'pr', 'view', '--json', FIELDS])
  const ok = !('failed' in result) && result.exitCode === 0

  return { pr: ok ? parseGhPr(result.stdout) : null, result }
}

// The factory never merges: there is no merge call in this file, and a test
// says so. It opens a draft, marks it ready, reads it, comments, and closes
// the pull request of a job that a person dropped.

const NOTHING_RAN: RunResult = { failed: 'other' }
const MAX_TITLE = 200
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)$/

const isNumber = (n: number) => Number.isInteger(n) && n > 0
const isJobBranch = (head: string) => head.startsWith('factory/') && isJobId(head.slice('factory/'.length))

// The address `gh pr create` prints: the last line that is one, exactly.
export function parsePrUrl(stdout: string): { number: number; url: string } | null {
  const lines = stdout.split('\n').map(line => line.trim())
  for (const line of lines.reverse()) {
    const match = PR_URL.exec(line)
    if (match) return { number: Number(match[1]), url: line }
  }

  return null
}

// Opens a draft pull request from a job's branch. The body goes to `gh` on
// standard input; the title is the value of `--title`, so it is data whatever
// it starts with. Nothing runs for a head that is not `factory/<job id>` or a
// base that is not a branch name.
export async function createDraftPr(
  run: Run,
  pr: { head: string; base: string; title: string; body: string },
): Promise<{ pr: { number: number; url: string } | null; result: RunResult }> {
  if (!isJobBranch(pr.head) || !isBranchName(pr.base)) return { pr: null, result: NOTHING_RAN }
  const title = clean(pr.title).slice(0, MAX_TITLE) || 'Factory job'
  const result = await run(
    ['gh', 'pr', 'create', '--draft', '--head', pr.head, '--base', pr.base, '--title', title, '--body-file', '-'],
    pr.body,
  )
  const ok = !('failed' in result) && result.exitCode === 0

  return { pr: ok ? parsePrUrl(result.stdout) : null, result }
}

export async function readyPr(run: Run, number: number): Promise<RunResult> {
  return isNumber(number) ? run(['gh', 'pr', 'ready', String(number)]) : NOTHING_RAN
}

export async function readPrByNumber(run: Run, number: number): Promise<{ pr: PrState | null; result: RunResult }> {
  if (!isNumber(number)) return { pr: null, result: NOTHING_RAN }
  const result = await run(['gh', 'pr', 'view', String(number), '--json', FIELDS])
  const ok = !('failed' in result) && result.exitCode === 0

  return { pr: ok ? parseGhPr(result.stdout) : null, result }
}

export async function commentPr(run: Run, number: number, markdown: string): Promise<RunResult> {
  return isNumber(number) ? run(['gh', 'pr', 'comment', String(number), '--body-file', '-'], markdown) : NOTHING_RAN
}

export async function closePr(run: Run, number: number): Promise<RunResult> {
  return isNumber(number) ? run(['gh', 'pr', 'close', String(number)]) : NOTHING_RAN
}

// The pull request host contract on GitHub. `current` asks for the pull
// request of the branch that is checked out: `gh` finds it by itself.
export function githubPrs(run: Run): PrHost {
  return {
    kind: 'github',
    open: pr => createDraftPr(run, pr),
    ready: number => readyPr(run, number),
    read: number => readPrByNumber(run, number),
    current: () => readPr(run),
    comment: (number, markdown) => commentPr(run, number, markdown),
    close: number => closePr(run, number),
  }
}
