// The pull request of the current branch, through the `gh` command.
import type { PrState } from '../core/model'
import type { RunResult } from '../core/run'
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
