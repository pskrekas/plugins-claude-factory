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

function isPattern(source: string): boolean {
  try {
    new RegExp(source)

    return true
  } catch {
    return false
  }
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
  const patterns = { done: '^- \\[x\\]', open: '^- \\[ \\]', blocked: 'BLOCKED' }
  for (const key of ['done', 'open', 'blocked'] as const) {
    const given = v[key]
    if (given === undefined) continue
    if (!isText(given)) return { no: WRONG }
    if (!isPattern(given)) return { no: BAD_PATTERN }
    patterns[key] = given
  }

  return { ok: { files: v.files, ...patterns } }
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
      spec.run = item.run as string[]
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

const text = (v: unknown): Parsed<string> => (isText(v) ? { ok: v } : { no: WRONG })
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
  take('baseBranch', text)
  take('progress', progress)
  take('checks', checks)
  take('ports', ports)
  take('owed', text)
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
