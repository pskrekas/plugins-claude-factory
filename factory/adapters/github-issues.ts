// GitHub Issues through the `gh` command, with the person's own login.
import type { RunResult } from '../core/run'
import type { Run, Tracker, TrackerItem } from './tracker'

const FIELDS = 'number,title,state,body,author,comments,url'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const login = (v: unknown): string => (isObject(v) ? text(v.login) : '')

export function parseGhIssue(json: string): TrackerItem | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!isObject(raw) || typeof raw.number !== 'number' || typeof raw.title !== 'string') return null
  const comments = Array.isArray(raw.comments) ? raw.comments.filter(isObject) : []

  return {
    id: String(raw.number),
    title: raw.title,
    state: text(raw.state).toLowerCase(),
    text: text(raw.body),
    author: login(raw.author),
    url: text(raw.url),
    comments: comments.map(comment => ({ author: login(comment.author), text: text(comment.body) })),
  }
}

// Reads one issue. `id` can carry a prefix: only its digits name the issue, so
// nothing but a number ever reaches the command line.
export async function readIssue(
  run: Run,
  id: string,
): Promise<{ item: TrackerItem | null; result: RunResult | null }> {
  const digits = id.replace(/\D/g, '')
  if (digits === '') return { item: null, result: null }
  const result = await run(['gh', 'issue', 'view', digits, '--json', FIELDS])
  const ok = !('failed' in result) && result.exitCode === 0

  return { item: ok ? parseGhIssue(result.stdout) : null, result }
}

export function githubIssues(run: Run): Pick<Tracker, 'read'> {
  return { read: async id => (await readIssue(run, id)).item }
}
