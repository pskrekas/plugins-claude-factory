// Reads a repo's .claude/factory.json. Every key is optional; a key that is
// wrong falls back to its default and is named in `error` (the first one only).
// Unknown keys are ignored, so a later phase's keys never break this one.

import { FACTORY_DEFAULTS, containerLine, parseFactory } from './factory-settings'
import type { FactorySettings } from './factory-settings'
import { CONTROL_CHAR, isInside, isObject, isText } from './rules'

export type CheckSpec = { name: string; run?: string[]; want?: string; minFreeGb?: number }

export type TrackerKind = 'github' | 'azure-boards' | 'jira' | 'asana' | 'mcp'

export type Settings = {
  ticketPattern: string | null
  // `project`: where the items are when the remote does not say it. For `azure-boards`: a project of the
  // remote's organization, or `<organization>/<project>`. For `github` with code on another host: `owner/name`.
  tracker: { kind: TrackerKind; mark: string; project: string | null } | null
  prHost: 'auto' | 'github' | 'azure-repos'
  baseBranch: string
  progress: { files: string; done: string; open: string; blocked: string } | null
  checks: CheckSpec[]
  ports: { name: string; port: number }[]
  owed: string | null
  gate: { fast: string[][]; full: string[][] }
  factory: FactorySettings
}

export const DEFAULTS: Settings = {
  ticketPattern: null,
  tracker: null,
  prHost: 'auto',
  baseBranch: 'main',
  progress: null,
  checks: [],
  ports: [],
  owed: null,
  gate: { fast: [], full: [] },
  factory: FACTORY_DEFAULTS,
}

const TRACKERS: readonly string[] = ['github', 'azure-boards', 'jira', 'asana', 'mcp']
const PR_HOSTS: readonly string[] = ['auto', 'github', 'azure-repos']
const WRONG = 'wrong type'
const BAD_PATTERN = 'not a valid pattern'
const CONTROL = 'control character in a command'
const OUTSIDE = 'path must be inside the repo'
const NOT_BRANCH = 'not a branch name'
const MAX_LIST = 20 // checks and ports each start a program: a settings file gets this many
const TOO_MANY = `at most ${MAX_LIST}`
const MAX_FILES_PATH = 200
const NOT_PATH = 'a check must name a program on PATH, not a path'

// A key's parser: the value, or a string saying why it is refused.
type Parsed<T> = { ok: T } | { no: string }



// Why `v` is refused as a command (an argv), or null when it is one.
function argvProblem(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0 || !v.every(isText)) return WRONG
  // A command is shown to the person for approval: one that can move the
  // cursor or clear the screen is not accepted at all.
  return v.some(arg => CONTROL_CHAR.test(arg)) ? CONTROL : null
}

const MAX_PATTERN = 100
const MAX_MARK = 100
const MAX_REPEATS = 3

const LITERAL = /[A-Za-z0-9_\-/#:@ ]/
const ESCAPABLE = /[dws.\-/\\()[\]+*?{}|^$#:@]/
const IN_CLASS = /[A-Za-z0-9_\-. /#:@]/
const CLASS_ESCAPE = /[dws.\-\]\\/]/

// Where the character class that opens at `start` closes, or -1 if it is not
// one this subset takes.
function classEnd(source: string, start: number): number {
  let i = start + 1
  if (source[i] === '^') i++
  const first = i
  for (; i < source.length; i++) {
    const char = source[i] ?? ''
    if (char === ']') return i > first ? i : -1
    if (char === '\\') {
      if (!CLASS_ESCAPE.test(source[i + 1] ?? '')) return -1
      i++
    } else if (!IN_CLASS.test(char)) {
      return -1
    }
  }

  return -1
}

// A pattern from a settings file runs before anyone approved that file, so it
// must not be able to run for a very long time. Only a small subset of regular
// expressions is taken, read here character by character: plain characters,
// `.`, the escapes \d \w \s and escaped punctuation, simple character classes,
// `^` first and `$` last, the repeats + * ? {n} {n,m} on one such piece, and one
// capture group that is not repeated. No alternation, no look-around, no
// back-reference, no lazy repeat, and at most three repeats in all (`?` and
// {n,m} count too: a run of optional pieces is as slow as a nested repeat).
// That is enough to find a ticket id in a branch name, and it cannot be slow on
// the short text it runs on.
function isPattern(source: string): boolean {
  if (source.length > MAX_PATTERN) return false
  try {
    new RegExp(source)
  } catch {
    return false
  }
  let depth = 0
  let groups = 0
  let repeats = 0
  let canRepeat = false // the piece before this point may take a repeat
  for (let i = 0; i < source.length; ) {
    const char = source[i] ?? ''
    if ((char === '^' && i === 0) || (char === '$' && i === source.length - 1)) {
      i++
      canRepeat = false
    } else if (char === '\\') {
      if (!ESCAPABLE.test(source[i + 1] ?? '')) return false
      i += 2
      canRepeat = true
    } else if (char === '[') {
      const end = classEnd(source, i)
      if (end < 0) return false
      i = end + 1
      canRepeat = true
    } else if (char === '(') {
      if (depth > 0 || groups > 0 || source[i + 1] === '?') return false
      depth++
      groups++
      i++
      canRepeat = false
    } else if (char === ')') {
      if (depth === 0) return false
      depth--
      i++
      canRepeat = false // a group is never repeated
    } else if (char === '+' || char === '*' || char === '?') {
      if (!canRepeat) return false
      repeats++
      i++
      canRepeat = false
    } else if (char === '{') {
      const repeat = /^\{\d{1,3}(,(\d{1,3})?)?\}/.exec(source.slice(i))
      if (!canRepeat || repeat === null) return false
      repeats++
      i += repeat[0].length
      canRepeat = false
    } else if (char === '.' || LITERAL.test(char)) {
      i++
      canRepeat = true
    } else {
      return false
    }
  }

  return depth === 0 && repeats <= MAX_REPEATS
}

function repoPath(v: unknown): Parsed<string> {
  if (!isText(v)) return { no: WRONG }

  return isInside(v) ? { ok: v } : { no: OUTSIDE }
}

export function isMark(mark: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:_ -]{0,49}$/.test(mark)
}

function ticketPattern(v: unknown): Parsed<string> {
  if (!isText(v)) return { no: WRONG }

  return isPattern(v) ? { ok: v } : { no: BAD_PATTERN }
}

function tracker(v: unknown): Parsed<Settings['tracker']> {
  if (!isObject(v) || !isText(v.kind) || !TRACKERS.includes(v.kind)) return { no: WRONG }
  // The mark is handed to the tracker's command as an argument: it must look
  // like a label, so it can never be read as an option.
  if (v.mark !== undefined && (!isText(v.mark) || !isMark(v.mark))) return { no: WRONG }
  if (v.project !== undefined && !isText(v.project)) return { no: WRONG }

  return {
    ok: { kind: v.kind as TrackerKind, mark: v.mark ?? 'factory', project: v.project ?? null },
  }
}

function progress(v: unknown): Parsed<Settings['progress']> {
  if (!isObject(v) || !isText(v.files) || v.files.length > MAX_FILES_PATH) return { no: WRONG }
  if (!isInside(v.files)) return { no: OUTSIDE }
  // Plain text marks, never patterns (see core/progress.ts).
  const marks = { done: '- [x]', open: '- [ ]', blocked: 'BLOCKED' }
  for (const key of ['done', 'open', 'blocked'] as const) {
    const given = v[key]
    if (given === undefined) continue
    if (!isText(given) || given.length > MAX_MARK || CONTROL_CHAR.test(given)) return { no: WRONG }
    marks[key] = given
  }

  return { ok: { files: v.files, ...marks } }
}

function checks(v: unknown): Parsed<CheckSpec[]> {
  if (!Array.isArray(v)) return { no: WRONG }
  if (v.length > MAX_LIST) return { no: TOO_MANY }
  const list: CheckSpec[] = []
  for (const item of v) {
    if (!isObject(item) || !isText(item.name)) return { no: WRONG }
    const spec: CheckSpec = { name: item.name }
    if (item.run !== undefined) {
      const problem = argvProblem(item.run)
      if (problem) return { no: problem }
      const run = item.run as string[]
      // A check runs by itself each minute. It must be a program the machine
      // has, never a file of the repo, whose content can change after approval.
      if (/[/\\]/.test(run[0] ?? '')) return { no: NOT_PATH }
      spec.run = run
    }
    if (item.want !== undefined) {
      if (typeof item.want !== 'string') return { no: WRONG }
      spec.want = item.want
    }
    if (item.minFreeGb !== undefined) {
      if (typeof item.minFreeGb !== 'number' || !(item.minFreeGb >= 0)) return { no: WRONG }
      spec.minFreeGb = item.minFreeGb
    }
    if (spec.run === undefined && spec.minFreeGb === undefined) return { no: WRONG }
    list.push(spec)
  }

  return { ok: list }
}

function ports(v: unknown): Parsed<Settings['ports']> {
  if (!isObject(v)) return { no: WRONG }
  if (Object.keys(v).length > MAX_LIST) return { no: TOO_MANY }
  const list: Settings['ports'] = []
  for (const [name, port] of Object.entries(v)) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { no: WRONG }
    }
    list.push({ name, port })
  }

  return { ok: list }
}

function gate(v: unknown): Parsed<Settings['gate']> {
  if (!isObject(v)) return { no: WRONG }
  const lists: string[][][] = []
  for (const list of [v.fast ?? [], v.full ?? []]) {
    if (!Array.isArray(list)) return { no: WRONG }
    for (const argv of list) {
      const problem = argvProblem(argv)
      if (problem) return { no: problem }
    }
    lists.push(list as string[][])
  }

  return { ok: { fast: lists[0] ?? [], full: lists[1] ?? [] } }
}

// A name that can only be read as a branch, never as an option.
export function isBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name)
}

// The base branch is handed to `git` as an argument. It must look like a
// branch name, so it can never be read as an option.
function branchName(v: unknown): Parsed<string> {
  if (!isText(v)) return { no: WRONG }

  return isBranchName(v) ? { ok: v } : { no: NOT_BRANCH }
}
const prHost = (v: unknown): Parsed<Settings['prHost']> =>
  isText(v) && PR_HOSTS.includes(v) ? { ok: v as Settings['prHost'] } : { no: WRONG }

export function parseSettings(source: string | null): { settings: Settings; error: string | null } {
  if (source === null) return { settings: DEFAULTS, error: null }
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { settings: DEFAULTS, error: 'not valid JSON' }
  }
  if (!isObject(raw)) return { settings: DEFAULTS, error: 'not a JSON object' }

  const settings: Settings = { ...DEFAULTS }
  let error: string | null = null
  const take = <K extends keyof Settings>(key: K, parse: (v: unknown) => Parsed<Settings[K]>) => {
    const given = raw[key]
    if (given === undefined || given === null) return
    const parsed = parse(given)
    if ('ok' in parsed) settings[key] = parsed.ok
    else error ??= `${key}: ${parsed.no}`
  }
  take('ticketPattern', ticketPattern)
  take('tracker', tracker)
  take('prHost', prHost)
  take('baseBranch', branchName)
  take('progress', progress)
  take('checks', checks)
  take('ports', ports)
  take('owed', repoPath)
  take('gate', gate)
  take('factory', parseFactory)

  return { settings, error }
}

const PLAIN_ARG = /^[A-Za-z0-9_./:=@%+,-]+$/

// An argument as a JSON string in printable ASCII only: every other character
// (a right-to-left mark, a zero-width space, an accent) is a visible \uXXXX.
function quoted(arg: string): string {
  return JSON.stringify(arg).replace(
    /[^\x20-\x7e]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
  )
}

// One command as one line a person can read and approve. An argument that is
// not plain is shown quoted, so two different commands never give the same
// line, the line is printable ASCII, and nothing in it is hidden.
export function lineOf(argv: string[]): string {
  return argv.map(arg => (PLAIN_ARG.test(arg) ? arg : quoted(arg))).join(' ')
}

// The mark of a gate command on the approval list. It starts with a character
// that `lineOf` can never put first: a plain argument cannot hold `[`, and a
// quoted one starts with a double quote. So no check's line can look like a
// gate's, and the two kinds of approval cannot be mixed up.
export const GATE_MARK = '[gate] '

// A tracker place that the settings file names itself (`tracker.project` with
// a `/`: `<organization>/<project>` on Azure DevOps, `owner/name` on GitHub),
// as the line a person approves. A settings file arrives with a clone: it
// must not point the person's login at a place the person did not choose.
// Null when the place is the remote's own, or when the text is not a place.
export function trackerLine(tracker: Settings['tracker']): string | null {
  if (tracker === null || tracker.project === null || !tracker.project.includes('/')) return null
  if (tracker.kind !== 'github' && tracker.kind !== 'azure-boards') return null

  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.][A-Za-z0-9 _.-]{0,99}$/.test(tracker.project) ? `[tracker] ${tracker.kind} ${tracker.project}` : null
}

// Every command the settings file can make the plugin run, one line each: the
// checks, then the gate's commands with their mark. A person approves both
// kinds together, but a line approved for one purpose never runs for the
// other: `[gate] npm test` does not let `npm test` run as a check each minute,
// and an approved check does not open the gate.
export function commandsOf(settings: Settings): string[] {
  const checks = new Set<string>()
  for (const check of settings.checks) if (check.run) checks.add(lineOf(check.run))
  const gate = new Set<string>()
  for (const argv of [...settings.gate.fast, ...settings.gate.full]) gate.add(GATE_MARK + lineOf(argv))

  const container = containerLine(settings.factory.container)
  const place = trackerLine(settings.tracker)

  return [...[...checks].sort(), ...[...gate].sort(), ...(container === null ? [] : [container]), ...(place === null ? [] : [place])]
}
