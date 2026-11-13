// A tracker reached through an MCP server (`tracker.kind: "mcp"`): the
// settings name, per action, a tool, its arguments and the field names of the
// answer (core/mcp-tracker.ts reads and checks them). Every call goes through
// `fill`, so text from outside is only ever a whole JSON value. A method of the
// five actions throws one readable line when its call fails; `comment` throws
// before it calls anything when the text may not be sent.
import { commentOf } from '../core/comment'
import { at, commentsOf, dataOf, errorOf, fill, isItemId, itemOf, labelsAfter, listedOf } from '../core/mcp-tracker'
import type { Fill, Json, ListSpec, McpCall, McpResult, McpTracker, ReadSpec } from '../core/mcp-tracker'
import { clean } from '../core/rows'
import { isObject } from '../core/rules'
import type { Listed, Tracker, TrackerItem } from './tracker'

// One call of a tool on the tracker's server. Never rejects.
export type Call = (tool: string, args: { [key: string]: Json }) => Promise<McpResult>

// A wrong server name, a server that is not connected or needs a sign-in, and a
// wrong tool name all fail alike (docs/notes/r3-check.md).
export const NO_SERVER = (server: string) => `The MCP server ${server} did not answer. Connect it with /mcp, or check the tool names in the settings.`
export const NO_ANSWER = (server: string) => `The MCP server ${server} did not answer in time.`

const MAX_ME = 200
const MAX_WHY = 150
const PR_URL = /^https:\/\/\S+$/
const NOT_THERE = 'no connected MCP tool'

// ---- What the engine answers, as the plugin keeps it -------------------------------------------

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!isObject(v)) return false
  const proto = Object.getPrototypeOf(v)

  return proto === Object.prototype || proto === null
}

// A copy of an engine result with only what the plugin reads: text blocks, a
// strict `isError`, and `structuredContent` when it is a plain object of JSON.
export function resultOf(raw: unknown): McpResult {
  const r = isObject(raw) ? raw : {}
  const content = Array.isArray(r.content)
    ? r.content.flatMap(block => (isObject(block) && typeof block.type === 'string' && typeof block.text === 'string' ? [{ type: block.type, text: block.text }] : []))
    : []
  const result: Extract<McpResult, { content: unknown }> = { content, isError: r.isError === true }
  if (isPlain(r.structuredContent)) {
    try {
      const copy: unknown = JSON.parse(JSON.stringify(r.structuredContent))
      if (isPlain(copy)) result.structuredContent = copy
    } catch {
      // Not JSON: left out.
    }
  }

  return result
}

// A call that the engine refused. A tool that is not in the session (any of the
// reasons above) is `no-server`; anything else is its first line, cleaned and cut.
export function rejectedOf(error: unknown): McpResult {
  const said = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (said.includes(NOT_THERE)) return { failed: 'no-server', why: 'no such tool on a connected server' }
  const first = said.split(/\r\n|\r|\n/).map(line => clean(line).trim()).find(line => line !== '') ?? ''
  let why = first.slice(0, MAX_WHY)
  if (/[\ud800-\udbff]$/.test(why)) why = why.slice(0, -1)

  return { failed: 'other', why: why === '' ? 'failed' : why }
}

// ---- The tracker ------------------------------------------------------------------------------

// The read with its own comment keys set aside.
const alone = (spec: ReadSpec): ReadSpec => ({ ...spec, comments: null, commentAuthor: null, commentText: null })

export function mcpTracker(call: Call, spec: McpTracker, mark: string, forbidden: string[]): Tracker {
  // The answer of one call, or null when a value broke a rule (then nothing was called).
  const ask = async (c: McpCall, values: Fill): Promise<McpResult | null> => {
    const args = fill(c.args, values)

    return args === null ? null : call(c.tool, args)
  }
  // A call that reads fields: its data, or undefined when it failed.
  const read_ = async (c: McpCall, values: Fill): Promise<unknown> => {
    const answer = await ask(c, values)

    return answer === null ? undefined : dataOf(answer)
  }
  // A call that writes: it passed when the server did not say it failed.
  const write = async (c: McpCall, values: Fill): Promise<void> => {
    const answer = await ask(c, values)
    if (answer === null) throw new Error(`${c.tool}: not sent (a value broke a rule)`)
    const failed = errorOf(c.tool, answer)
    if (failed !== null) throw new Error(failed)
  }
  // One list (the queue or the claimed items), or why it could not be read.
  const listOf = async (list: ListSpec): Promise<{ items: Listed[] } | { note: string }> => {
    const answer = await ask(list, { mark })
    if (answer === null) return { note: `${list.tool}: not sent (a value broke a rule)` }
    if ('failed' in answer && answer.failed === 'no-server') return { note: NO_SERVER(spec.server) }
    if ('failed' in answer && answer.failed === 'timeout') return { note: NO_ANSWER(spec.server) }
    const failed = errorOf(list.tool, answer)
    if (failed !== null) return { note: failed }
    const data = dataOf(answer)
    if (data === undefined) return { note: `${list.tool}: the answer is not JSON` }
    const items = listedOf(data, list)

    return items === null ? { note: `${list.tool}: the answer holds no list of rows` } : { items }
  }
  const scan = async () => {
    const listed = await listOf(spec.list)
    if ('note' in listed) return { items: null, claimed: [], result: null, note: listed.note }
    // A claimed list that cannot be read leaves the queue as it is.
    const claimed = spec.claimed === null ? null : await listOf(spec.claimed)

    return { items: listed.items, claimed: claimed !== null && 'items' in claimed ? claimed.items : [], result: null, note: null }
  }
  // The item alone (no comment), and its labels.
  const bare = async (id: string): Promise<{ item: TrackerItem; labels: string[] | null } | null> => {
    if (!isItemId(id)) return null
    const data = await read_(spec.read, { mark, id })

    return data === undefined ? null : itemOf(data, alone(spec.read), id, spec.url)
  }
  const comment = async (id: string, markdown: string) => {
    const sent = commentOf(markdown, forbidden)
    if ('no' in sent) throw new Error(`the comment was not sent: ${sent.no}`)
    await write(spec.comment, { mark, id, text: sent.ok })
  }
  // The person who runs the line: asked once, also when the answer was no name.
  let me: Promise<string | null> | undefined
  const askMe = async (): Promise<string | null> => {
    if (spec.me === null) return null
    const name = at(await read_(spec.me, { mark }), spec.me.name)
    if (typeof name !== 'string' || name === '') return null

    return name.toLowerCase().slice(0, MAX_ME)
  }

  return {
    kind: 'mcp',
    scan,
    list: async () => (await scan()).items ?? [],
    hasMark: async id => {
      if (!isItemId(id)) return false
      if (spec.read.labels !== null) {
        const labels = (await bare(id))?.labels ?? null

        return labels !== null && labels.some(label => label.toLowerCase() === mark.toLowerCase())
      }
      const listed = await scan()

      return [...(listed.items ?? []), ...listed.claimed].some(item => item.id === id)
    },
    me: () => (me ??= askMe().catch(() => null)),
    read: async (id, withComments = true) => {
      if (!isItemId(id)) return null
      // With a call of their own, the comments are not read from the item's answer.
      if (!withComments || spec.comments !== null) {
        const found = await bare(id)
        if (found === null || !withComments || spec.comments === null) return found?.item ?? null
        // An item whose comments cannot be read is not read at all: its author
        // may have answered a question there, and an agent must not miss it.
        const c = spec.comments
        const said = await read_(c, { mark, id })
        const comments = said === undefined ? null : commentsOf(said, c.rows, c.author, c.text)

        return comments === null ? null : { ...found.item, comments }
      }
      const data = await read_(spec.read, { mark, id })

      return data === undefined ? null : (itemOf(data, spec.read, id, spec.url)?.item ?? null)
    },
    comment,
    setState: async (id, state) => {
      if (!isItemId(id)) throw new Error('not an item id')
      const states = spec.states
      if (states.as === 'labels') {
        // The labels are read just before they are written: a label that a
        // person added since is kept. (The write replaces the whole list.)
        const labels = (await bare(id))?.labels ?? null
        if (labels === null) throw new Error(`${spec.read.tool}: the item could not be read`)
        await write(states.write, { mark, id, labels: labelsAfter(labels, mark, state, states.names) })

        return
      }
      for (const step of states.steps[state] ?? []) {
        try {
          await write(step, { mark, id, state })
        } catch (error) {
          if (!step.optional) throw error
        }
      }
    },
    linkPr: async (id, url) => {
      if (!PR_URL.test(url)) throw new Error('not a pull request address')
      if (spec.linkPr === null) {
        await comment(id, `Pull request: ${url}`)

        return
      }
      await write(spec.linkPr, { mark, id, url })
    },
  }
}
