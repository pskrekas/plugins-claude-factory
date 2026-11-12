// Reads a repo's .claude/factory.json. Every key is optional; a key that is
// wrong falls back to its default and is named in `error` (the first one only).
// Unknown keys are ignored, so a later phase's keys never break this one.

export type CheckSpec = { name: string; run?: string[]; want?: string; minFreeGb?: number }

export type TrackerKind = 'github' | 'azure-boards' | 'jira' | 'asana' | 'mcp'

export type Settings = {
  ticketPattern: string | null
  tracker: { kind: TrackerKind; mark: string; project: string | null } | null
  prHost: 'auto' | 'github' | 'azure-repos'
  baseBranch: string
  progress: { files: string; done: string; open: string; blocked: string } | null
  checks: CheckSpec[]
  ports: { name: string; port: number }[]
  owed: string | null
  gate: { fast: string[][]; full: string[][] }
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
}

const TRACKERS: readonly string[] = ['github', 'azure-boards', 'jira', 'asana', 'mcp']
const PR_HOSTS: readonly string[] = ['auto', 'github', 'azure-repos']
const WRONG = 'wrong type'
const BAD_PATTERN = 'not a valid pattern'
const CONTROL = 'control character in a command'
const OUTSIDE = 'path must be inside the repo'
const NOT_BRANCH = 'not a branch name'
const NOT_PATH = 'a check must name a program on PATH, not a path'

// A key's parser: the value, or a string saying why it is refused.
type Parsed<T> = { ok: T } | { no: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''

const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/

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

// A path the plugin reads must stay in the repo: what it finds there is shown
// in the panel and told to the model, so a settings file must not be able to
// point it at a file elsewhere on the machine.
function isInside(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('~') || path.includes('\\')) return false
  if (CONTROL_CHAR.test(path)) return false

  return !path.split('/').includes('..')
}

function repoPath(v: unknown): Parsed<string> {
  if (!isText(v)) return { no: WRONG }

  return isInside(v) ? { ok: v } : { no: OUTSIDE }
}

function ticketPattern(v: unknown): Parsed<string> {
  if (!isText(v)) return { no: WRONG }

  return isPattern(v) ? { ok: v } : { no: BAD_PATTERN }
}

function tracker(v: unknown): Parsed<Settings['tracker']> {
  if (!isObject(v) || !isText(v.kind) || !TRACKERS.includes(v.kind)) return { no: WRONG }
  if (v.mark !== undefined && !isText(v.mark)) return { no: WRONG }
  if (v.project !== undefined && !isText(v.project)) return { no: WRONG }

  return {
    ok: { kind: v.kind as TrackerKind, mark: v.mark ?? 'factory', project: v.project ?? null },
  }
}

function progress(v: unknown): Parsed<Settings['progress']> {
  if (!isObject(v) || !isText(v.files)) return { no: WRONG }
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

// The base branch is handed to `git` as an argument. It must look like a
// branch name, so it can never be read as an option.
function branchName(v: unknown): Parsed<string> {
  if (!isText(v)) return { no: WRONG }

  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(v) ? { ok: v } : { no: NOT_BRANCH }
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

// Every command the settings file can make the plugin run, one line each.
export function commandsOf(settings: Settings): string[] {
  const lines = new Set<string>()
  for (const check of settings.checks) if (check.run) lines.add(lineOf(check.run))
  for (const argv of [...settings.gate.fast, ...settings.gate.full]) lines.add(lineOf(argv))

  return [...lines].sort()
}
