// Azure DevOps Boards through the `az` command, with the person's own login.
// Every argument list comes from core/azure.ts. The mark is a tag; a state is
// one more tag, `<mark>:<state>`. The adapter never changes a work item's own
// workflow state: process templates differ.
import { azArgs, htmlToText, stateTag, tagsAfter, textToHtml } from '../core/azure'
import type { AzCall, AzPlace } from '../core/azure'
import { commentOf, failureText } from '../core/comment'
import type { RunResult } from '../core/run'
import type { Listed, Run, Tracker, TrackerItem } from './tracker'

// Writes a text to a new file of the plugin's own (in the state folder) and
// answers its path, or null when it could not. `az` reads outside text only
// from such a file, never as an argument.
export type Put = (text: string, ext: 'txt' | 'json') => Promise<string | null>

const MAX_COMMENTS = 50
const MAX_COMMENT = 5_000
const MAX_TEXT = 20_000
const EXTRA = [
  ['Microsoft.VSTS.TCM.ReproSteps', 'Steps to reproduce'],
  ['Microsoft.VSTS.Common.AcceptanceCriteria', 'Acceptance criteria'],
] as const
const NOTHING_RAN: RunResult = { failed: 'other' }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}
// A person as Azure DevOps names one: the account name, in lower case. An
// older service gives one text, `Name <account>`.
const personOf = (v: unknown): string => {
  const name = isObject(v) ? text(v.uniqueName) : (/<([^<>\s]+)>\s*$/.exec(text(v))?.[1] ?? '')

  return name.toLowerCase().slice(0, 200)
}
// `System.Tags` is one text, `a; b`.
const tagsOf = (fields: Record<string, unknown>): string[] =>
  text(fields['System.Tags'])
    .split(';')
    .map(tag => tag.trim())
    .filter(tag => tag !== '')
const holds = (tags: string[], tag: string) => tags.some(one => one.toLowerCase() === tag.toLowerCase())

function fieldsOf(json: string): { id: number; fields: Record<string, unknown> } | null {
  const raw = parsed(json)
  if (!isObject(raw) || typeof raw.id !== 'number' || !Number.isInteger(raw.id) || !isObject(raw.fields)) return null

  return { id: raw.id, fields: raw.fields }
}

// A work item as the line reads one. Its text is the description with no
// tag and no script: an agent reads it as data.
export function parseAzItem(json: string, place: AzPlace): TrackerItem | null {
  const item = fieldsOf(json)
  if (item === null || typeof item.fields['System.Title'] !== 'string') return null
  // Ids are the organization's: an item of another project is not this tracker's.
  const home = text(item.fields['System.TeamProject'])
  if (home !== '' && home.toLowerCase() !== place.project.toLowerCase()) return null
  // A bug's text is its steps, and a story says what must be true when it is done.
  const parts = [
    htmlToText(text(item.fields['System.Description'])),
    ...EXTRA.map(([field, title]) => [title, htmlToText(text(item.fields[field]))] as const).filter(([, body]) => body !== '').map(([title, body]) => `${title}:\n${body}`),
  ].filter(part => part !== '')

  return {
    id: String(item.id),
    title: item.fields['System.Title'],
    state: text(item.fields['System.State']).toLowerCase(),
    text: parts.join('\n\n').slice(0, MAX_TEXT),
    author: personOf(item.fields['System.CreatedBy']),
    url: `${place.org}/${encodeURIComponent(place.project)}/_workitems/edit/${item.id}`,
    comments: [],
  }
}

// The comments of a work item, at most fifty, as plain text.
export function parseAzComments(json: string): { author: string; text: string }[] {
  const raw = parsed(json)
  const comments = isObject(raw) && Array.isArray(raw.comments) ? raw.comments.filter(isObject) : []

  return comments.slice(0, MAX_COMMENTS).map(comment => ({ author: personOf(comment.createdBy), text: htmlToText(text(comment.text), MAX_COMMENT) }))
}

export function parseAzQuery(json: string): (Listed & { tags: string[] })[] {
  const raw = parsed(json)
  if (!Array.isArray(raw)) return []

  return raw.filter(isObject).flatMap(row => {
    if (typeof row.id !== 'number' || !isObject(row.fields) || typeof row.fields['System.Title'] !== 'string') return []

    return [{ id: String(row.id), title: row.fields['System.Title'], state: text(row.fields['System.State']).toLowerCase(), tags: tagsOf(row.fields) }]
  })
}

const passed = (result: RunResult): result is { exitCode: number; stdout: string; stderr: string } => !('failed' in result) && result.exitCode === 0

// The tracker contract on Azure DevOps Boards. A method of the five actions
// throws with one readable line when its command fails; `comment` throws
// before it runs anything when the text may not be sent.
export function azureBoards(run: Run, put: Put, place: AzPlace, mark: string, forbidden: string[]): Tracker {
  // Runs one call. Nothing runs for a call that breaks a rule.
  const az = async (call: AzCall): Promise<RunResult> => {
    const argv = azArgs(call)

    return argv === null ? NOTHING_RAN : run(argv)
  }
  const must = (result: RunResult) => {
    if (!passed(result)) throw new Error(failureText('az', result))
  }
  const digitsOf = (id: string) => id.replace(/\D/g, '')
  const plain = ({ id, title, state }: Listed): Listed => ({ id, title, state })
  // The tags of an item as they are now, or null.
  const tagsNow = async (id: string): Promise<string[] | null> => {
    const shown = await az({ do: 'item', place, id: digitsOf(id) })
    const item = passed(shown) ? fieldsOf(shown.stdout) : null

    return item === null ? null : tagsOf(item.fields)
  }
  const scan = async () => {
    const argv = azArgs({ do: 'query', place, mark })
    if (argv === null) return { items: null, claimed: [], result: null }
    const result = await run(argv)
    if (!passed(result)) return { items: null, claimed: [], result }
    // Only the rows that carry the mark itself: the query's own test of a tag may match more.
    const rows = parseAzQuery(result.stdout).filter(row => holds(row.tags, mark))
    const own = `${mark.toLowerCase()}:`

    return {
      items: rows.filter(row => !row.tags.some(tag => tag.toLowerCase().startsWith(own))).map(plain),
      claimed: rows.filter(row => holds(row.tags, stateTag(mark, 'in-progress'))).map(plain),
      result,
    }
  }
  const comment = async (id: string, markdown: string) => {
    const sent = commentOf(markdown, forbidden)
    if ('no' in sent) throw new Error(`the comment was not sent: ${sent.no}`)
    // A work item's discussion is HTML. The text goes to `az` in a file.
    const file = await put(textToHtml(sent.ok), 'txt')
    if (file === null) throw new Error('the comment was not sent: no file could be written')
    try {
      must(await az({ do: 'discuss', place, id: digitsOf(id), file }))
    } finally {
      await run(['rm', '-f', file]).catch(() => undefined)
    }
  }
  // The account of the person who runs the line: asked once.
  let me: string | null | undefined

  return {
    kind: 'azure-boards',
    scan,
    list: async () => (await scan()).items ?? [],
    hasMark: async id => holds((await tagsNow(id)) ?? [], mark),
    me: async () => {
      if (me === undefined) {
        const asked = await az({ do: 'me' })
        const name = passed(asked) ? asked.stdout.trim().toLowerCase() : ''
        me = /^[^\s<>]{1,200}$/.test(name) ? name : null
      }

      return me
    },
    read: async (id, withComments = true) => {
      const shown = await az({ do: 'item', place, id: digitsOf(id) })
      const item = passed(shown) ? parseAzItem(shown.stdout, place) : null
      if (item === null || !withComments) return item
      // An item whose comments cannot be read is not read at all: its author
      // may have answered a question there, and an agent must not miss it.
      const said = await az({ do: 'item-comments', place, id: item.id })

      return passed(said) ? { ...item, comments: parseAzComments(said.stdout) } : null
    },
    comment,
    // The tags are read just before they are written: a tag that a person
    // added since is kept. (The field is one text, so the write replaces it.)
    setState: async (id, state) => {
      const tags = await tagsNow(id)
      if (tags === null) throw new Error('az: the work item could not be read')
      must(await az({ do: 'set-tags', place, id: digitsOf(id), tags: tagsAfter(tags, mark, state) }))
    },
    // A pull request of this repository on Azure Repos is linked to the work
    // item. Any other address is a comment.
    linkPr: async (id, url) => {
      const here = `${place.org}/${encodeURIComponent(place.project)}/_git/${encodeURIComponent(place.repo)}/pullrequest/`
      const pr = url.startsWith(here) && /^\d{1,10}$/.test(url.slice(here.length)) ? Number(url.slice(here.length)) : null
      if (pr !== null) {
        must(await az({ do: 'link-item', place, pr, id: digitsOf(id) }))

        return
      }
      if (!/^https:\/\/\S+$/.test(url)) throw new Error('not a pull request address')
      await comment(id, `Pull request: ${url}`)
    },
  }
}
