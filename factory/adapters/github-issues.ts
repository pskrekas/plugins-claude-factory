// GitHub Issues through the `gh` command, with the person's own login.
import { commentOf, failureText } from '../core/comment'
import type { RunResult } from '../core/run'
import type { Run, Tracker, TrackerItem, TrackerState } from './tracker'

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

// The open issues that carry the mark. `items` is the queue: the ones the
// factory does not have yet (an issue with a label `<mark>:…` is left out).
// `claimed` are the ones the tracker says are in progress. The mark is an
// argument of `gh`, so one that does not look like a label runs nothing.
// `items` is null when the list could not be read.
export async function listIssues(
  run: Run,
  mark: string,
): Promise<{
  items: { id: string; title: string; state: string }[] | null
  claimed: { id: string; title: string; state: string }[]
  result: RunResult | null
}> {
  if (!MARK.test(mark)) return { items: null, claimed: [], result: null }
  const result = await run([
    'gh', 'issue', 'list', '--label', mark, '--state', 'open',
    '--limit', String(LIST_LIMIT), '--json', LIST_FIELDS,
  ])
  if ('failed' in result || result.exitCode !== 0) return { items: null, claimed: [], result }
  const all = parseGhIssueList(result.stdout)
  const plain = ({ id, title, state }: { id: string; title: string; state: string }) => ({ id, title, state })

  return {
    items: all.filter(issue => !issue.labels.some(label => label.startsWith(`${mark}:`))).map(plain),
    claimed: all.filter(issue => issue.labels.includes(stateLabel(mark, 'in-progress'))).map(plain),
    result,
  }
}

export const stateLabel = (mark: string, state: 'in-progress' | 'needs-human') => `${mark}:${state}`

const NOTHING_RAN: RunResult = { failed: 'other' }
const digitsOf = (id: string) => id.replace(/\D/g, '')

// Makes the two state labels, so a later edit can add them.
export async function ensureLabels(run: Run, mark: string): Promise<RunResult> {
  if (!MARK.test(mark)) return NOTHING_RAN
  const made = await run([
    'gh', 'label', 'create', stateLabel(mark, 'in-progress'), '--force',
    '--description', 'The factory works on this',
  ])
  if ('failed' in made || made.exitCode !== 0) return made

  return run([
    'gh', 'label', 'create', stateLabel(mark, 'needs-human'), '--force',
    '--description', 'The factory waits for a person',
  ])
}

// The text goes to `gh` on standard input: it is never an argument.
export async function commentIssue(run: Run, id: string, markdown: string): Promise<RunResult> {
  const n = digitsOf(id)

  return n === '' ? NOTHING_RAN : run(['gh', 'issue', 'comment', n, '--body-file', '-'], markdown)
}

export async function closeIssue(run: Run, id: string): Promise<RunResult> {
  const n = digitsOf(id)

  return n === '' ? NOTHING_RAN : run(['gh', 'issue', 'close', n, '--reason', 'not planned'])
}

// A state is the two labels: one, the other, or neither. `rejected` also
// closes the issue as not planned; `done` leaves that to the merged pull request.
export async function setIssueState(run: Run, id: string, mark: string, state: TrackerState): Promise<RunResult> {
  const n = digitsOf(id)
  if (n === '' || !MARK.test(mark)) return NOTHING_RAN
  const working = stateLabel(mark, 'in-progress')
  const waiting = stateLabel(mark, 'needs-human')
  const labels =
    state === 'in-progress'
      ? ['--add-label', working, '--remove-label', waiting]
      : state === 'needs-human'
        ? ['--add-label', waiting, '--remove-label', working]
        : ['--remove-label', working, '--remove-label', waiting]
  const edited = await run(['gh', 'issue', 'edit', n, ...labels])
  if (state !== 'rejected' || 'failed' in edited || edited.exitCode !== 0) return edited

  return closeIssue(run, id)
}

// The five actions of the tracker contract on GitHub Issues. A method throws
// with one readable line when its command fails; `comment` throws before it
// runs anything when the text may not be sent.
export function githubIssues(run: Run, mark: string, forbidden: string[]): Tracker {
  const must = (result: RunResult) => {
    if ('failed' in result || result.exitCode !== 0) throw new Error(failureText('gh', result))
  }
  const comment = async (id: string, markdown: string) => {
    const text = commentOf(markdown, forbidden)
    if ('no' in text) throw new Error(`the comment was not sent: ${text.no}`)
    must(await commentIssue(run, id, text.ok))
  }

  return {
    list: async () => (await listIssues(run, mark)).items ?? [],
    read: async id => (await readIssue(run, id)).item,
    comment,
    setState: async (id, state) => must(await setIssueState(run, id, mark, state)),
    linkPr: async (id, url) => {
      if (!/^https:\/\/\S+$/.test(url)) throw new Error('not a pull request address')
      await comment(id, `Pull request: ${url}`)
    },
  }
}
