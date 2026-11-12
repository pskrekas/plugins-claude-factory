// GitHub Issues through the `gh` command, with the person's own login.
import type { RunResult } from '../core/run'
import type { Run, Tracker, TrackerItem } from './tracker'

const FIELDS = 'number,title,state,body,author,comments,url'
const LIST_FIELDS = 'number,title,state,labels'
const LIST_LIMIT = 100
const MARK = /^[A-Za-z0-9][A-Za-z0-9:_ -]{0,49}$/

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

export function parseGhIssueList(
  json: string,
): { id: string; title: string; state: string; labels: string[] }[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  return raw.filter(isObject).flatMap(issue => {
    if (typeof issue.number !== 'number' || typeof issue.title !== 'string') return []
    const labels = Array.isArray(issue.labels) ? issue.labels.filter(isObject).map(label => text(label.name)) : []

    return [{ id: String(issue.number), title: issue.title, state: text(issue.state).toLowerCase(), labels }]
  })
}

// The open issues that carry the mark and that the factory does not have yet:
// an issue with a label `<mark>:…` (in progress, needs a person) is left out.
// The mark is an argument of `gh`, so one that does not look like a label runs
// nothing. `items` is null when the list could not be read.
export async function listIssues(
  run: Run,
  mark: string,
): Promise<{ items: { id: string; title: string; state: string }[] | null; result: RunResult | null }> {
  if (!MARK.test(mark)) return { items: null, result: null }
  const result = await run([
    'gh', 'issue', 'list', '--label', mark, '--state', 'open',
    '--limit', String(LIST_LIMIT), '--json', LIST_FIELDS,
  ])
  if ('failed' in result || result.exitCode !== 0) return { items: null, result }
  const items = parseGhIssueList(result.stdout)
    .filter(issue => !issue.labels.some(label => label.startsWith(`${mark}:`)))
    .map(({ id, title, state }) => ({ id, title, state }))

  return { items, result }
}

export function githubIssues(run: Run): Pick<Tracker, 'read' | 'list'> {
  return {
    read: async id => (await readIssue(run, id)).item,
    list: async mark => (await listIssues(run, mark)).items ?? [],
  }
}
