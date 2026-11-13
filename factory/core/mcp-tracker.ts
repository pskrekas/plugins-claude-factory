// The settings of a tracker that is reached through an MCP server (`tracker.kind: "mcp"`), and the
// lines a person approves for it. Pure: no engine, no call. A settings file arrives with a clone, so
// everything here fails closed: what is not understood is refused with a short reason that names the
// key, and every call becomes one whole line that the approval store compares as text.

import type { TrackerState } from '../adapters/tracker'
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

  return { ok: { ...call.ok, ...spec } as ReadSpec }
}

function commentsOf(v: unknown): Parsed<CommentsSpec> {
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
    const c = commentsOf(v.comments)
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
