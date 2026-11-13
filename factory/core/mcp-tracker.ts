// The settings of a tracker that is reached through an MCP server (`tracker.kind: "mcp"`), and the
// lines a person approves for it. Pure: no engine, no call. A settings file arrives with a clone, so
// everything here fails closed: what is not understood is refused with a short reason that names the
// key, and every call becomes one whole line that the approval store compares as text.

import type { Listed, TrackerItem, TrackerState } from '../adapters/tracker'
import { clean } from './rows'
import { CONTROL_CHAR, isObject } from './rules'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type McpCall = { tool: string; args: { [key: string]: Json } }
export type ListSpec = McpCall & { rows: string | null; id: string; title: string; state: string | null }
export type ReadSpec = McpCall & {
  title: string
  text: string
  author: string | null
  state: string | null
  labels: string | null
  url: string | null
  comments: string | null
  commentAuthor: string | null
  commentText: string | null
}
export type CommentsSpec = McpCall & { rows: string | null; author: string; text: string }
export type Step = McpCall & { optional: boolean }
export type StatesSpec =
  | { as: 'calls'; steps: Partial<Record<TrackerState, Step[]>> }
  | { as: 'labels'; write: McpCall; names: Record<TrackerState, string> | null }
export type McpTracker = {
  server: string
  url: string | null
  list: ListSpec
  claimed: ListSpec | null
  read: ReadSpec
  comments: CommentsSpec | null
  comment: McpCall
  states: StatesSpec
  linkPr: McpCall | null
  me: (McpCall & { name: string }) | null
}

type Parsed<T> = { ok: T } | { no: string }

const STATES: readonly TrackerState[] = ['in-progress', 'needs-human', 'done', 'rejected']
// No space or separator at the end: `factory ` must not be a name of its own.
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,98}[A-Za-z0-9])?$/
const FIELD = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,5}$/
const UNSAFE_PART = ['__proto__', 'constructor', 'prototype']
const PLACEHOLDER = /\{[a-z]+\}/g
const MAX_ARGS = 1000
const MAX_DEPTH = 4
const MAX_STEPS = 4
const MAX_URL = 300

type Kind = 'list' | 'claimed' | 'read' | 'comments' | 'comment' | 'step' | 'labels' | 'linkPr' | 'me'
// Which placeholders each call may hold. `alone` ones must be the whole value.
const ALLOWED: Record<Kind, readonly string[]> = {
  list: ['mark'],
  claimed: ['mark'],
  me: ['mark'],
  read: ['mark', 'id'],
  comments: ['mark', 'id'],
  comment: ['mark', 'id', 'text'],
  step: ['mark', 'id', 'state'],
  labels: ['mark', 'id', 'labels'],
  linkPr: ['mark', 'id', 'url'],
}
const ALONE: readonly string[] = ['text', 'url', 'labels']
const KNOWN: readonly string[] = ['mark', 'id', 'text', 'url', 'labels', 'state']

const TOP_KEYS = ['kind', 'mark', 'project', 'server', 'url', 'list', 'claimed', 'read', 'comments', 'comment', 'states', 'linkPr', 'me']
const LIST_KEYS = ['tool', 'args', 'rows', 'id', 'title', 'state']
const READ_KEYS = ['tool', 'args', 'title', 'text', 'author', 'state', 'labels', 'url', 'comments', 'commentAuthor', 'commentText']
const COMMENTS_KEYS = ['tool', 'args', 'rows', 'author', 'text']
const CALL_KEYS = ['tool', 'args']
const ME_KEYS = ['tool', 'args', 'name']
const STEP_KEYS = ['tool', 'args', 'optional']
const LABELS_KEYS = ['tool', 'args', 'names']

const no = (path: string, why: string): { no: string } => ({ no: `${path}: ${why}` })
const isErr = <T>(r: Parsed<T>): r is { no: string } => 'no' in r

// Why `name` is no server, or null.
function serverProblem(name: string): string | null {
  // The plugin's own tools are reachable as a server too: the settings must never reach them.
  // Letters and digits only, lower case: `Factory.`, `f.a.c.t.o.r.y` and `plugin:factory:x` all strip to the
  // plugin's own name. `factory-tasks` strips to `factorytasks`, which is not `factory`, so it is allowed.
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (flat === 'factory' || flat.startsWith('pluginfactory')) return 'is the plugin itself'

  return null
}

function nameOf(path: string, v: unknown): Parsed<string> {
  if (typeof v !== 'string' || !NAME.test(v)) return no(path, 'needs a plain name (letters, digits, space . _ -, at most 100)')

  return { ok: v }
}

function fieldOf(path: string, v: unknown): Parsed<string> {
  if (typeof v !== 'string' || !FIELD.test(v)) return no(path, 'needs a field name of 1 to 6 parts of letters, digits and _, joined by dots')
  if (v.split('.').some(part => UNSAFE_PART.includes(part))) return no(path, 'a part of a field name is not allowed')

  return { ok: v }
}

function optField(obj: Record<string, unknown>, key: string, path: string): Parsed<string | null> {
  if (obj[key] === undefined) return { ok: null }

  return fieldOf(`${path}.${key}`, obj[key])
}

function reqField(obj: Record<string, unknown>, key: string, path: string): Parsed<string> {
  if (obj[key] === undefined) return no(`${path}.${key}`, 'is needed')

  return fieldOf(`${path}.${key}`, obj[key])
}

function unknownKey(obj: Record<string, unknown>, allowed: readonly string[], path: string): { no: string } | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return no(path === '' ? key : `${path}.${key}`, 'is not a key here')
  }

  return null
}

// A control character is refused anywhere; a character that only hides (a bidi mark) is shown as an escape in the line.
const hides = (s: string): boolean => CONTROL_CHAR.test(s)

// Checks one value of `args` (and its keys) and returns why it is refused, or null.
function valueProblem(v: unknown, kind: Kind, depth: number): string | null {
  if (v === null || typeof v === 'boolean') return null
  if (typeof v === 'number') return Number.isFinite(v) ? null : 'a number must be finite'
  if (typeof v === 'string') {
    if (hides(v)) return 'a control character'
    for (const hit of v.match(PLACEHOLDER) ?? []) {
      const name = hit.slice(1, -1)
      if (!KNOWN.includes(name)) return `unknown placeholder ${hit}`
      if (!ALLOWED[kind].includes(name)) return `${hit} is not allowed here`
      if (ALONE.includes(name) && v !== hit) return `${hit} must be the whole value`
    }

    return null
  }
  if (depth > MAX_DEPTH) return `more than ${MAX_DEPTH} levels deep`
  if (Array.isArray(v)) {
    for (const item of v) {
      const problem = valueProblem(item, kind, depth + 1)
      if (problem) return problem
    }

    return null
  }
  if (isObject(v)) {
    for (const [key, value] of Object.entries(v)) {
      if (key === '__proto__' || hides(key)) return 'a key that is not plain'
      if (/\{[a-z]+\}/.test(key)) return 'a placeholder in a key'
      const problem = valueProblem(value, kind, depth + 1)
      if (problem) return problem
    }

    return null
  }

  return 'only JSON values'
}

// Compact JSON with the keys sorted, so the same arguments are always the same line. A character that
// is not printable ASCII is shown as \uXXXX.
function canonical(v: Json): string {
  let text: string
  if (Array.isArray(v)) text = `[${v.map(canonical).join(',')}]`
  else if (v !== null && typeof v === 'object') {
    text = `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${canonical(v[key] as Json)}`).join(',')}}`
  } else text = JSON.stringify(v)

  return text.replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function argsOf(path: string, v: unknown, kind: Kind): Parsed<{ [key: string]: Json }> {
  if (v === undefined) return { ok: {} }
  if (!isObject(v)) return no(`${path}.args`, 'must be an object')
  const problem = valueProblem(v, kind, 1)
  if (problem) return no(`${path}.args`, problem)
  if (canonical(v as Json).length > MAX_ARGS) return no(`${path}.args`, `more than ${MAX_ARGS} characters`)

  return { ok: v as { [key: string]: Json } }
}

function callOf(path: string, v: unknown, keys: readonly string[], kind: Kind): Parsed<McpCall> {
  if (!isObject(v)) return no(path, 'must be an object')
  const bad = unknownKey(v, keys, path)
  if (bad) return bad
  const tool = nameOf(`${path}.tool`, v.tool)
  if (isErr(tool)) return tool
  const args = argsOf(path, v.args, kind)
  if (isErr(args)) return args

  return { ok: { tool: tool.ok, args: args.ok } }
}

function listOf(path: string, v: unknown, kind: 'list' | 'claimed'): Parsed<ListSpec> {
  const call = callOf(path, v, LIST_KEYS, kind)
  if (isErr(call)) return call
  const o = v as Record<string, unknown>
  const rows = optField(o, 'rows', path)
  if (isErr(rows)) return rows
  const id = reqField(o, 'id', path)
  if (isErr(id)) return id
  const title = reqField(o, 'title', path)
  if (isErr(title)) return title
  const state = optField(o, 'state', path)
  if (isErr(state)) return state

  return { ok: { ...call.ok, rows: rows.ok, id: id.ok, title: title.ok, state: state.ok } }
}

function readOf(v: unknown): Parsed<ReadSpec> {
  const call = callOf('read', v, READ_KEYS, 'read')
  if (isErr(call)) return call
  const o = v as Record<string, unknown>
  const spec: Record<string, string | null> = {}
  for (const key of ['title', 'text']) {
    const f = reqField(o, key, 'read')
    if (isErr(f)) return f
    spec[key] = f.ok
  }
  for (const key of ['author', 'state', 'labels', 'url', 'comments', 'commentAuthor', 'commentText']) {
    const f = optField(o, key, 'read')
    if (isErr(f)) return f
    spec[key] = f.ok
  }
  const trio = [spec.comments, spec.commentAuthor, spec.commentText].filter(x => x !== null).length
  if (trio !== 0 && trio !== 3) return no('read', 'comments, commentAuthor and commentText go together: all three or none')

  return { ok: { ...call.ok, ...spec } as ReadSpec }
}

function commentsSpecOf(v: unknown): Parsed<CommentsSpec> {
  const call = callOf('comments', v, COMMENTS_KEYS, 'comments')
  if (isErr(call)) return call
  const o = v as Record<string, unknown>
  const rows = optField(o, 'rows', 'comments')
  if (isErr(rows)) return rows
  const author = reqField(o, 'author', 'comments')
  if (isErr(author)) return author
  const text = reqField(o, 'text', 'comments')
  if (isErr(text)) return text

  return { ok: { ...call.ok, rows: rows.ok, author: author.ok, text: text.ok } }
}

function stepsOf(state: string, v: unknown): Parsed<Step[]> {
  const path = `states.${state}`
  if (!Array.isArray(v) || v.length === 0) return no(path, 'needs a list of 1 to 4 steps (leave a state out to call nothing)')
  if (v.length > MAX_STEPS) return no(path, `at most ${MAX_STEPS} steps`)
  const steps: Step[] = []
  for (const [i, raw] of v.entries()) {
    const at = `${path}[${i}]`
    const call = callOf(at, raw, STEP_KEYS, 'step')
    if (isErr(call)) return no(path, call.no)
    const optional = (raw as Record<string, unknown>).optional
    if (optional !== undefined && typeof optional !== 'boolean') return no(path, `${at}.optional must be true or false`)
    steps.push({ ...call.ok, optional: optional === true })
  }

  return { ok: steps }
}

function statesOf(v: unknown, hasLabels: boolean): Parsed<StatesSpec> {
  if (!isObject(v) || Object.keys(v).length === 0) return no('states', 'needs a state, or labels')
  if ('labels' in v) {
    if (Object.keys(v).length > 1) return no('states', 'labels cannot be mixed with states')
    const raw = v.labels
    const call = callOf('states.labels', raw, LABELS_KEYS, 'labels')
    if (isErr(call)) return call
    if (!hasLabels) return no('read.labels', 'is needed for states as labels')
    const given = (raw as Record<string, unknown>).names
    if (given === undefined) return { ok: { as: 'labels', write: call.ok, names: null } }
    if (!isObject(given)) return no('states.labels.names', 'must be an object')
    const bad = unknownKey(given, STATES, 'states.labels.names')
    if (bad) return bad
    const names = {} as Record<TrackerState, string>
    for (const state of STATES) {
      const name = given[state]
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_ -]{0,49}$/.test(name)) {
        return no('states.labels.names', `${state} needs a plain name`)
      }
      names[state] = name
    }

    return { ok: { as: 'labels', write: call.ok, names } }
  }
  const steps: Partial<Record<TrackerState, Step[]>> = {}
  for (const [state, raw] of Object.entries(v)) {
    if (!STATES.includes(state as TrackerState)) return no(`states.${state}`, 'is not one of the four states')
    const list = stepsOf(state, raw)
    if (isErr(list)) return list
    steps[state as TrackerState] = list.ok
  }

  return { ok: { as: 'calls', steps } }
}

function urlOf(v: unknown): Parsed<string> {
  if (typeof v !== 'string' || !v.startsWith('https://')) return no('url', 'must start with https://')
  if (v.length > MAX_URL) return no('url', `at most ${MAX_URL} characters`)
  if (!/^[\x21-\x7e]+$/.test(v)) return no('url', 'no space or control character')
  const holes = v.match(/\{[^}]*\}|[{}]/g) ?? []
  if (holes.length !== 1 || holes[0] !== '{id}') return no('url', 'must hold {id} once and no other {…}')

  return { ok: v }
}

// The whole `tracker` object of a settings file, for `kind: "mcp"`.
export function parseMcpTracker(v: Record<string, unknown>): { ok: McpTracker } | { no: string } {
  const bad = unknownKey(v, TOP_KEYS, '')
  if (bad) return bad
  if (typeof v.server !== 'string') return no('server', 'is needed')
  const named = nameOf('server', v.server)
  if (isErr(named)) return named
  const own = serverProblem(v.server)
  if (own) return no('server', own)
  let url: string | null = null
  if (v.url !== undefined) {
    const u = urlOf(v.url)
    if (isErr(u)) return u
    url = u.ok
  }
  if (v.list === undefined) return no('list', 'is needed')
  const list = listOf('list', v.list, 'list')
  if (isErr(list)) return list
  let claimed: ListSpec | null = null
  if (v.claimed !== undefined) {
    const c = listOf('claimed', v.claimed, 'claimed')
    if (isErr(c)) return c
    claimed = c.ok
  }
  if (v.read === undefined) return no('read', 'is needed')
  const read = readOf(v.read)
  if (isErr(read)) return read
  let comments: CommentsSpec | null = null
  if (v.comments !== undefined) {
    const c = commentsSpecOf(v.comments)
    if (isErr(c)) return c
    comments = c.ok
  }
  if (v.comment === undefined) return no('comment', 'is needed')
  const comment = callOf('comment', v.comment, CALL_KEYS, 'comment')
  if (isErr(comment)) return comment
  if (v.states === undefined) return no('states', 'is needed')
  const states = statesOf(v.states, read.ok.labels !== null)
  if (isErr(states)) return states
  let linkPr: McpCall | null = null
  if (v.linkPr !== undefined) {
    const l = callOf('linkPr', v.linkPr, CALL_KEYS, 'linkPr')
    if (isErr(l)) return l
    linkPr = l.ok
  }
  let me: McpTracker['me'] = null
  if (v.me !== undefined) {
    const call = callOf('me', v.me, ME_KEYS, 'me')
    if (isErr(call)) return call
    const name = reqField(v.me as Record<string, unknown>, 'name', 'me')
    if (isErr(name)) return name
    me = { ...call.ok, name: name.ok }
  }

  return { ok: { server: named.ok, url, list: list.ok, claimed, read: read.ok, comments, comment: comment.ok, states: states.ok, linkPr, me } }
}

const pairs = (fields: [string, string | null][]): string =>
  fields.filter((f): f is [string, string] => f[1] !== null).map(([k, v]) => `${k}=${v}`).join(' ')

// Every call of the tracker as one line a person approves: the whole call in a fixed form, so any change
// (the server, a tool, an argument, a field name, `optional`, the `url`) is another line.
export function mcpLines(spec: McpTracker, mark: string): string[] {
  const head = `[tracker] mcp ${spec.server} · `
  const call = (label: string, c: McpCall, fields: [string, string | null][] = []): string => {
    const more = pairs(fields)

    return `${head}${label}: ${c.tool} ${canonical(c.args)}${more === '' ? '' : ` → ${more}`}`
  }
  const listFields = (s: ListSpec): [string, string | null][] => [['rows', s.rows], ['id', s.id], ['title', s.title], ['state', s.state]]
  const lines = [call('list', spec.list, listFields(spec.list))]
  if (spec.claimed) lines.push(call('claimed', spec.claimed, listFields(spec.claimed)))
  const r = spec.read
  lines.push(
    call('read', r, [
      ['title', r.title], ['text', r.text], ['author', r.author], ['state', r.state], ['labels', r.labels],
      ['url', r.url], ['comments', r.comments], ['commentAuthor', r.commentAuthor], ['commentText', r.commentText],
    ]),
  )
  if (spec.comments) lines.push(call('comments', spec.comments, [['rows', spec.comments.rows], ['author', spec.comments.author], ['text', spec.comments.text]]))
  lines.push(call('comment', spec.comment))
  if (spec.states.as === 'labels') {
    const n = spec.states.names
    lines.push(call('states as labels', spec.states.write, n === null ? [] : STATES.map((s): [string, string] => [s, n[s]])))
  } else {
    for (const state of STATES) {
      const steps = spec.states.steps[state] ?? []
      steps.forEach((s, i) => lines.push(call(`state ${state} ${i + 1}/${steps.length}${s.optional ? ' (optional)' : ''}`, s)))
    }
  }
  if (spec.linkPr) lines.push(call('linkPr', spec.linkPr))
  if (spec.me) lines.push(call('me', spec.me, [['name', spec.me.name]]))
  if (spec.url !== null) lines.push(`${head}url: ${spec.url}`)
  // The mark is put into the approved calls, so a change of it must be a line to approve too.
  lines.push(`${head}mark: ${mark}`)

  return lines
}

// ---- Filling a call and reading an answer -------------------------------------------------------------

export type McpResult =
  | { content: { type: string; text?: string }[]; isError: boolean; structuredContent?: unknown }
  | { failed: 'timeout' | 'no-server' | 'other'; why: string }
export type Fill = { mark: string; id?: string; text?: string; url?: string; labels?: string[]; state?: TrackerState }

const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_.#-]{0,63}$/
const HTTPS = /^https:\/\/\S+$/
const MAX_ANSWER = 1_048_576
const MAX_URL_VALUE = 2000
const MAX_ROWS = 200
const MAX_COMMENTS = 50
const MAX_COMMENT = 5000
const MAX_TEXT = 20_000
const MAX_TITLE = 300
const MAX_AUTHOR = 200
const MAX_ERROR = 200
const MAX_FILL_DEPTH = 10

export const isItemId = (id: string): boolean => ITEM_ID.test(id)

const isHttps = (v: string): boolean => v.length <= MAX_URL_VALUE && HTTPS.test(v)

// The value of an alone placeholder, or undefined when there is none or it breaks its rule.
function aloneValue(name: string, v: Fill): Json | undefined {
  switch (name) {
    case 'mark': return v.mark
    case 'id': return v.id !== undefined && isItemId(v.id) ? v.id : undefined
    case 'text': return typeof v.text === 'string' ? v.text : undefined
    case 'url': return typeof v.url === 'string' && isHttps(v.url) ? v.url : undefined
    case 'labels': return Array.isArray(v.labels) && v.labels.every(l => typeof l === 'string') ? [...v.labels] : undefined
    case 'state': return v.state
    default: return undefined
  }
}

function fillValue(value: Json, v: Fill, depth: number): Json | undefined {
  if (depth > MAX_FILL_DEPTH) return undefined
  if (typeof value === 'string') {
    const whole = /^\{([a-z]+)\}$/.exec(value)
    if (whole && KNOWN.includes(whole[1]!)) return aloneValue(whole[1]!, v)
    let failed = false
    // One pass over the original text: what is put in is never read again.
    const out = value.replace(PLACEHOLDER, hit => {
      const name = hit.slice(1, -1)
      if (name !== 'mark' && name !== 'id' && name !== 'state') {
        // An alone-only placeholder inside a text, or a name the plugin does not know.
        if (KNOWN.includes(name)) failed = true

        return hit
      }
      const got = aloneValue(name, v)
      if (typeof got !== 'string') {
        failed = true

        return hit
      }

      return got
    })

    return failed ? undefined : out
  }
  if (Array.isArray(value)) {
    const out: Json[] = []
    for (const item of value) {
      const f = fillValue(item, v, depth + 1)
      if (f === undefined) return undefined
      out.push(f)
    }

    return out
  }
  if (value !== null && typeof value === 'object') {
    const entries: [string, Json][] = []
    for (const [key, item] of Object.entries(value)) {
      const f = fillValue(item, v, depth + 1)
      if (f === undefined) return undefined
      entries.push([key, f])
    }

    return Object.fromEntries(entries)
  }

  return value
}

// The arguments to send, or null when a value it needs is missing or breaks its rule. A new value; `args` is not changed.
export function fill(args: { [key: string]: Json }, values: Fill): { [key: string]: Json } | null {
  const out = fillValue(args, values, 1)

  return out === undefined ? null : (out as { [key: string]: Json })
}

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text)

// The first text block; a `content` that is not a list has none.
function textBlock(result: { content?: unknown }): { type: string; text?: unknown } | undefined {
  if (!Array.isArray(result.content)) return undefined

  return result.content.find((c): c is { type: string; text?: unknown } => isObject(c) && c.type === 'text')
}

// Why the call failed, as one clean line of at most 200 characters; null when it did not.
export function errorOf(tool: string, result: McpResult): string | null {
  let reason: string
  if ('failed' in result) reason = clean(String(result.why)).trim()
  else if (!result.isError) return null
  else {
    const block = textBlock(result)
    const lines = typeof block?.text === 'string' ? block.text.slice(0, 2000).split(/\r\n|\r|\n/) : []
    reason = ''
    for (const line of lines) {
      const c = clean(line).trim()
      if (c !== '') {
        reason = c
        break
      }
    }
  }
  if (reason === '') reason = 'failed'

  let line = cut(`${tool}: ${reason}`, MAX_ERROR)
  // Never half of a surrogate pair at the end.
  if (/[\ud800-\udbff]$/.test(line)) line = line.slice(0, -1)

  return line
}

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!isObject(v)) return false
  const proto = Object.getPrototypeOf(v)

  return proto === Object.prototype || proto === null
}

// The answer's data for an action that reads fields; undefined when there is none.
export function dataOf(result: McpResult): unknown {
  if ('failed' in result || result.isError) return undefined
  if (isPlain(result.structuredContent)) return result.structuredContent
  const block = textBlock(result)
  if (typeof block?.text !== 'string' || block.text.length > MAX_ANSWER) return undefined
  try {
    const data: unknown = JSON.parse(block.text)

    return data === null ? undefined : data
  } catch {
    return undefined
  }
}

// A dotted name, own properties of plain objects only; undefined = not there.
export function at(data: unknown, path: string): unknown {
  if (!FIELD.test(path) || path.split('.').some(p => UNSAFE_PART.includes(p))) return undefined
  let cur: unknown = data
  for (const part of path.split('.')) {
    if (UNSAFE_PART.includes(part) || !isPlain(cur) || !Object.hasOwn(cur, part)) return undefined
    cur = cur[part]
  }

  return cur
}

const textAt = (data: unknown, path: string | null): string | undefined => {
  if (path === null) return undefined
  const v = at(data, path)

  return typeof v === 'string' ? v : undefined
}

// An id is text, or a whole number that JSON holds exactly (read as its digits).
function idAt(data: unknown, path: string): string | undefined {
  const v = at(data, path)
  const id = typeof v === 'string' ? v : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : undefined

  return id !== undefined && isItemId(id) ? id : undefined
}

const listAt = (data: unknown, rows: string | null): unknown[] | null => {
  const v = rows === null ? data : at(data, rows)

  return Array.isArray(v) ? v : null
}

export function listedOf(data: unknown, spec: ListSpec): Listed[] | null {
  const rows = listAt(data, spec.rows)
  if (rows === null) return null
  const out: Listed[] = []
  for (const row of rows.slice(0, MAX_ROWS)) {
    const id = idAt(row, spec.id)
    const title = textAt(row, spec.title)
    if (id === undefined || title === undefined || title === '') continue
    out.push({ id, title: cut(title, MAX_TITLE), state: (textAt(row, spec.state) ?? '').toLowerCase() })
  }

  return out
}

export function commentsOf(data: unknown, rows: string | null, author: string, text: string): { author: string; text: string }[] | null {
  const list = listAt(data, rows)
  if (list === null) return null
  const out: { author: string; text: string }[] = []
  for (const row of list) {
    const a = textAt(row, author)
    const t = textAt(row, text)
    if (a === undefined || a === '' || t === undefined || t === '') continue
    out.push({ author: cut(a.toLowerCase(), MAX_AUTHOR), text: cut(t, MAX_COMMENT) })
    if (out.length === MAX_COMMENTS) break
  }

  return out
}

function labelsAt(data: unknown, path: string | null): string[] | null {
  if (path === null) return null
  const v = at(data, path)
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const l of v) {
    if (typeof l === 'string') out.push(l)
    else {
      const name = textAt(l, 'name')
      if (name !== undefined) out.push(name)
    }
  }

  return out
}

export function itemOf(
  data: unknown,
  spec: ReadSpec,
  id: string,
  urlTemplate: string | null,
): { item: TrackerItem; labels: string[] | null } | null {
  const title = textAt(data, spec.title)
  if (title === undefined || title === '') return null
  let comments: TrackerItem['comments'] = []
  if (spec.comments !== null) {
    if (spec.commentAuthor === null || spec.commentText === null) return null
    const c = commentsOf(data, spec.comments, spec.commentAuthor, spec.commentText)
    if (c === null) return null
    comments = c
  }
  const own = textAt(data, spec.url)
  const url = own !== undefined && isHttps(own) ? own : urlTemplate !== null ? urlTemplate.replace('{id}', () => encodeURIComponent(id)) : ''

  return {
    item: {
      id,
      title: cut(title, MAX_TITLE),
      state: (textAt(data, spec.state) ?? '').toLowerCase(),
      text: cut(textAt(data, spec.text) ?? '', MAX_TEXT),
      author: cut((textAt(data, spec.author) ?? '').toLowerCase(), MAX_AUTHOR),
      url,
      comments,
    },
    labels: labelsAt(data, spec.labels),
  }
}

// The labels with the four state labels taken away and the one of `state` added last.
export function labelsAfter(labels: string[], mark: string, state: TrackerState, names: Record<TrackerState, string> | null): string[] {
  const nameOf_ = (s: TrackerState): string => names?.[s] ?? `${mark}:${s}`
  const state_ = new Set(STATES.map(s => nameOf_(s).toLowerCase()))
  const next = nameOf_(state)

  return [...labels.filter(l => !state_.has(l.toLowerCase())), next]
}
