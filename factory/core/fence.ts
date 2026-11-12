// The fence around a factory agent (design 8.1): what one tool call of one
// agent may do. Pure: a path and a command are judged as text.
//
// It answers only for the tools of the agent's role. For any other tool it
// answers null, and the caller hands the call on unchanged.
//
// For shell commands it is best effort: a command line can hide what it does.
// What does not depend on it: every agent reads a clean checkout, the gate
// runs in its own clean copy, the plugin alone pushes, and nothing merges.
import { TOOLS } from './agents'
import type { Role } from './factory-settings'
import { clean } from './rows'
import { isObject } from './rules'

// `outFile`: the one file the agent writes outside the code, as a full path.
export type Who = { role: Role; worktree: string; jobDir: string; outFile: string; forbiddenCommands: string[][] }
export type Verdict = { decision: 'allow' } | { decision: 'deny'; reason: string; command: string } | null
type Deny = { decision: 'deny'; reason: string; command: string }

const MAX_COMMAND = 200
const ALLOW = { decision: 'allow' } as const
const deny = (reason: string, command: string): Deny => ({
  decision: 'deny',
  reason,
  command: clean(command).trim().slice(0, MAX_COMMAND),
})

const OUTSIDE = 'This is outside the job.'
const NOT_HERE = 'This is not a place this agent writes.'
const NOT_UNDERSTOOD = 'The call was not understood.'
const PUSH = 'The line pushes; an agent does not.'
const HOST = 'The line talks to the host; an agent does not.'
const SETTINGS = "Git settings and refs are not an agent's to change."
const REF = 'A branch or a tag is not named like a remote ref.'
const FORBIDDEN = 'This command is forbidden in this repository.'
const GIT_FOLDER = 'The git folder is not written to.'

// A path as the tools see it, with `.` and `..` resolved. A relative path is
// under `base`. Null for a path that cannot be judged.
function resolve(path: string, base: string): string | null {
  if (path === '' || path.startsWith('~') || /[\u0000-\u001f\u007f]/.test(path)) return null
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }

  return '/' + parts.join('/')
}

const isIn = (path: string, root: string) => path === root || path.startsWith(root + '/')
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

function readVerdict(tool: string, input: Record<string, unknown>, who: Who): Verdict {
  const inJob = (path: string) => {
    const full = resolve(path, who.worktree)

    return full !== null && (isIn(full, who.worktree) || isIn(full, who.jobDir))
  }
  if (tool === 'Read') {
    const file = text(input.file_path)
    if (file === null) return deny(NOT_UNDERSTOOD, '')

    return inJob(file) ? ALLOW : deny(OUTSIDE, file)
  }
  // Glob and Grep: an optional folder, and for Glob a pattern that can name one.
  if (input.path !== undefined) {
    const folder = text(input.path)
    if (folder === null) return deny(NOT_UNDERSTOOD, '')
    if (!inJob(folder)) return deny(OUTSIDE, folder)
  }
  if (tool === 'Glob') {
    const pattern = text(input.pattern)
    if (pattern === null) return deny(NOT_UNDERSTOOD, '')
    if (pattern.split('/').includes('..') || pattern.startsWith('~')) return deny(OUTSIDE, pattern)
    if (pattern.startsWith('/') && !inJob(pattern.slice(0, pattern.search(/[*?[{]|$/)))) return deny(OUTSIDE, pattern)
  }

  return ALLOW
}

function writeVerdict(input: Record<string, unknown>, who: Who): Verdict {
  const file = text(input.file_path)
  if (file === null) return deny(NOT_UNDERSTOOD, '')
  const full = resolve(file, who.worktree)
  if (full === null) return deny(NOT_HERE, file)
  const git = `${who.worktree}/.git`
  const inCode = who.role === 'builder' && isIn(full, who.worktree) && !isIn(full, git)

  // Outside the code, an agent writes its one file and no other.
  return inCode || full === who.outFile ? ALLOW : deny(NOT_HERE, file)
}

const PREFIXES = ['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs']
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh']
const GIT_SETTINGS = ['config', 'replace', 'update-ref', 'remote', 'worktree', 'symbolic-ref']
const GIT_PLACES = ['-c', '-C', '--git-dir', '--work-tree', '--exec-path', '--namespace']
const WRITERS = ['rm', 'mv', 'cp', 'ln', 'tee', 'chmod', 'chown', 'truncate', 'dd', 'touch', 'mkdir', 'rmdir', 'install', 'rsync']
const baseName = (word: string) => word.slice(word.lastIndexOf('/') + 1)
const unquote = (word: string) => word.replace(/^['"]+|['"]+$/g, '')
const isRemoteName = (word: string | undefined) => word !== undefined && (word.startsWith('origin/') || word.startsWith('refs/'))

// The words of one simple command, without what only wraps it (`sudo`, `env`,
// `VAR=value`, …) and their options.
function wordsOf(simple: string): string[] {
  const words = simple.trim().split(/\s+/).map(unquote).filter(word => word !== '')
  while (words.length > 0) {
    const first = words[0] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      words.shift()
    } else if (PREFIXES.includes(baseName(first))) {
      words.shift()
      while ((words[0] ?? '').startsWith('-')) words.shift()
    } else {
      break
    }
  }

  return words
}

function gitVerdict(words: string[], simple: string): Deny | null {
  let at = 1
  while ((words[at] ?? '').startsWith('-')) {
    const option = words[at] ?? ''
    if (GIT_PLACES.some(place => option === place || option.startsWith(place + '='))) return deny(SETTINGS, simple)
    at += 1
  }
  const sub = words[at]
  const rest = words.slice(at + 1)
  if (sub === 'push') return deny(PUSH, simple)
  if (sub !== undefined && GIT_SETTINGS.includes(sub)) return deny(SETTINGS, simple)
  // A new branch or tag whose name could be read in the base's place.
  if ((sub === 'branch' || sub === 'tag') && isRemoteName(rest.find(word => !word.startsWith('-')))) return deny(REF, simple)
  if (sub === 'checkout' || sub === 'switch') {
    const flag = rest.findIndex(word => ['-b', '-B', '-c', '-C'].includes(word))
    if (flag >= 0 && isRemoteName(rest[flag + 1])) return deny(REF, simple)
  }

  return null
}

function simpleVerdict(simple: string, who: Who, depth: number): Deny | null {
  const words = wordsOf(simple)
  const program = baseName(words[0] ?? '')
  if (program === '') return null
  // A shell or `eval` runs the text it is given: that text is judged too.
  if (depth < 2 && (SHELLS.includes(program) || program === 'eval')) {
    const from = program === 'eval' ? 1 : words.indexOf('-c') + 1
    if (from > 0) {
      const inner = commandVerdict(words.slice(from).join(' '), who, depth + 1)
      if (inner !== null) return inner
    }
  }
  if (program === 'git') {
    const refused = gitVerdict(words, simple)
    if (refused !== null) return refused
  }
  if (program === 'gh' || (program === 'az' && words[1] === 'repos')) return deny(HOST, simple)
  for (const list of who.forbiddenCommands) {
    const [first = '', ...more] = list
    if (program === baseName(first) && more.every((word, i) => words[i + 1] === word)) return deny(FORBIDDEN, simple)
  }
  const namesGit = words.some(word => word === '.git' || word.endsWith('/.git') || word.includes('.git/'))
  const writes = simple.includes('>') || WRITERS.includes(program) || (program === 'sed' && words.some(word => word.startsWith('-i')))

  return namesGit && writes ? deny(GIT_FOLDER, simple) : null
}

function commandVerdict(command: string, who: Who, depth: number): Deny | null {
  for (const simple of command.split(/;|&&|\|\||\||&|\n|\$\(|`|\(|\)|\{|\}/)) {
    const refused = simpleVerdict(simple, who, depth)
    if (refused !== null) return refused
  }

  return null
}

export function fenceOf(call: { tool: string; input: unknown }, who: Who): Verdict {
  if (!TOOLS[who.role].includes(call.tool)) return null
  if (!isObject(call.input)) return deny(NOT_UNDERSTOOD, '')
  if (call.tool === 'Read' || call.tool === 'Glob' || call.tool === 'Grep') return readVerdict(call.tool, call.input, who)
  if (call.tool === 'Write' || call.tool === 'Edit') return writeVerdict(call.input, who)
  if (call.tool === 'Bash') {
    const command = text(call.input.command)
    if (command === null) return deny(NOT_UNDERSTOOD, '')

    return commandVerdict(command, who, 0) ?? ALLOW
  }

  return null
}
