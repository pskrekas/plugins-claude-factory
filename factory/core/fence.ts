// The fence around a factory agent (design 8.1): what one tool call of one
// agent may do. Pure: a path and a command are judged as text.
//
// It answers only for the tools of the agent's role. For any other tool it
// answers null, and the caller hands the call on unchanged.
//
// For shell commands on the person's machine (`Bash`, the host builder) it is
// best effort: a command line can hide what it does. A builder in a container
// has no such shell: its commands run through the plugin's own tool, inside
// the job's container, and there only the repository's forbidden commands are
// refused, as text. What depends on neither: every agent reads a clean
// checkout, the gate runs in its own clean copy, the plugin alone pushes, and
// nothing merges.
import { SHELL_TOOL, toolsOf } from './agents'
import type { Shell } from './agents'
import type { Role } from './factory-settings'
import { clean } from './rows'
import { isObject } from './rules'

// `outFile`: the one file the agent writes outside the code, as a full path.
// `shell`: where the job's builder runs its commands.
export type Who = { role: Role; shell: Shell; worktree: string; jobDir: string; outFile: string; forbiddenCommands: string[][] }
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
const NOT_PLAIN = 'The command is not plain enough to check. Write the program and its command with no quotes, backslash or variable.'
const STAY = "An agent stays on its job's branch."
const OUT_WRITE = 'This write is outside the job.'
const TOO_DEEP = 'A shell inside a shell inside a shell is not run.'
const NO_SHELL = 'This agent has no shell on this machine.'

// A path as the tools see it, with `.` and `..` resolved. A relative path is
// under `base`. Null for a path that cannot be judged.
export function resolvePath(path: string, base: string): string | null {
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
    const full = resolvePath(path, who.worktree)

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
    // No two dots anywhere and no group of choices: each could name a place
    // that the check of the first folder does not see.
    if (pattern.includes('..') || pattern.includes('{') || pattern.startsWith('~')) return deny(OUTSIDE, pattern)
    // The folder before the first wildcard must be inside the job: a wildcard
    // in the name of the job's own folder could match its neighbours.
    const literal = pattern.slice(0, pattern.search(/[*?[{]|$/))
    if (pattern.startsWith('/') && !inJob(literal.slice(0, literal.lastIndexOf('/')) || '/')) return deny(OUTSIDE, pattern)
  }

  return ALLOW
}

function writeVerdict(input: Record<string, unknown>, who: Who): Verdict {
  const file = text(input.file_path)
  if (file === null) return deny(NOT_UNDERSTOOD, '')
  const full = resolvePath(file, who.worktree)
  if (full === null) return deny(NOT_HERE, file)
  // The folder's `.git`, by any case: some disks do not tell `.GIT` from `.git`.
  const first = isIn(full, who.worktree) ? (full.slice(who.worktree.length + 1).split('/')[0] ?? '') : ''
  const inCode = who.role === 'builder' && isIn(full, who.worktree) && first.toLowerCase() !== '.git'

  // Outside the code, an agent writes its one file and no other.
  return inCode || full === who.outFile ? ALLOW : deny(NOT_HERE, file)
}

const PREFIXES = ['sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'xargs']
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh']
const GIT_SETTINGS = ['config', 'replace', 'update-ref', 'remote', 'worktree', 'symbolic-ref']
const BRANCH_CHANGES = ['-f', '--force', '-m', '-M', '--move', '-d', '-D', '--delete', '-c', '-C', '--copy', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description']
// Where a shell command may write beside the job: scratch space and the null device.
const SCRATCH = ['/tmp', '/private/tmp', '/dev']
const GIT_SENDS = ['push', 'send-pack', 'http-push']
// A word the shell would change before it runs: quotes, a backslash, a
// variable, a pattern, a group of choices, a home folder.
const isOdd = (word: string | undefined) => word !== undefined && /['"\\$*?[\]{}~]/.test(word)
// By any case: some disks do not tell `.GIT` from `.git`.
// Also a part that starts with a dot and holds a pattern (`.g*`, `.gi?`,
// `.{git}`, `.*`): the shell could fill it in as the git folder.
const namesGitFolder = (text: string) => {
  // As the shell reads it: with no quotes and no backslashes.
  const word = text.replace(/['"\\]/g, '').toLowerCase()
  if (word === '.git' || word.endsWith('/.git') || word.includes('.git/')) return true

  return word.split('/').some(part => /^[.[{]/.test(part) && /[*?[\]{}]/.test(part))
}
// Shell words that set a variable: with a name built from pieces they could
// set one of git's own.
const SETTERS = ['export', 'declare', 'typeset', 'local', 'readonly', 'read', 'set', 'unset']
const GIT_PLACES = ['-c', '-C', '--git-dir', '--work-tree', '--exec-path', '--namespace']
const WRITERS = ['rm', 'mv', 'cp', 'ln', 'tee', 'chmod', 'chown', 'truncate', 'dd', 'touch', 'mkdir', 'rmdir', 'install', 'rsync', 'tar', 'unzip', 'curl', 'wget']
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
  if (isOdd(sub)) return deny(NOT_PLAIN, simple)
  if (sub !== undefined && GIT_SENDS.includes(sub)) return deny(PUSH, simple)
  if (sub !== undefined && GIT_SETTINGS.includes(sub)) return deny(SETTINGS, simple)
  // The builder stays on its job's branch and moves no other one: from another
  // branch, or with a branch moved, it could merge into the base.
  if (sub === 'switch') return deny(STAY, simple)
  if (sub === 'checkout') {
    // Only the form that takes files back: `checkout [<commit>] -- <path>…`.
    const dash = rest.indexOf('--')
    const isFiles = dash >= 0 && dash < rest.length - 1 && !rest.slice(0, dash).some(word => word.startsWith('-'))
    if (!isFiles) return deny(STAY, simple)
  }
  // A fetch or a pull that writes a local branch, or takes from this repository itself.
  // Also one that takes what to fetch from a place the fence does not read.
  const isOddFetch = (word: string) =>
    word.includes(':') || word === '.' || word.startsWith('+') || ['--stdin', '--refmap', '--upload-pack', '-u', '--update-head-ok'].some(flag => word === flag || word.startsWith(flag + '='))
  if ((sub === 'fetch' || sub === 'pull') && rest.some(isOddFetch)) return deny(STAY, simple)
  if (sub === 'branch' && rest.some(word => !word.startsWith('-') || BRANCH_CHANGES.includes(word))) return deny(STAY, simple)
  // A new branch or tag whose name could be read in the base's place.
  if ((sub === 'branch' || sub === 'tag') && isRemoteName(rest.find(word => !word.startsWith('-')))) return deny(REF, simple)
  if (sub === 'checkout' || sub === 'switch') {
    const flag = rest.findIndex(word => ['-b', '-B', '-c', '-C'].includes(word))
    if (flag >= 0 && isRemoteName(rest[flag + 1])) return deny(REF, simple)
  }

  return null
}

// True when the words of one simple command start as a forbidden command does.
const isForbidden = (words: string[], forbidden: string[][]) =>
  forbidden.some(([first = '', ...more]) => baseName(words[0] ?? '') === baseName(first) && more.every((word, i) => words[i + 1] === word))

const SPLIT = /;|&&|\|\||\||&|\n|\$\(|`|\(|\)/

// The first simple command of `command` that the repository forbids, or null.
// Also one behind another command, or given to a shell as text. Best effort,
// as every text check of a command is: a command built from pieces gets past
// it. In a container the container is the wall, not this check; it holds no
// login of the person.
export function forbiddenIn(command: string, forbidden: string[][], depth = 0): string | null {
  // A command that the shell builds (a variable, a command inside a command)
  // cannot be read word by word. It is refused when every word of a forbidden
  // command is somewhere in it.
  if (depth === 0 && /[$`]/.test(command)) {
    const bare = command.replace(/['"\\]/g, '')
    if (forbidden.some(list => list.length > 0 && list.every((word, i) => bare.includes(i === 0 ? baseName(word) : word)))) return command
  }
  for (const simple of command.split(SPLIT)) {
    // As the shell reads plain words: with no quotes and no backslashes in them.
    const words = wordsOf(simple).map(word => word.replace(/['"\\]/g, ''))
    if (isForbidden(words, forbidden)) return simple
    const program = baseName(words[0] ?? '')
    if (depth < 2 && (SHELLS.includes(program) || program === 'eval')) {
      const flag = words.findIndex((word, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
      const from = program === 'eval' ? 1 : flag + 1
      const inner = from > 0 ? forbiddenIn(words.slice(from).join(' '), forbidden, depth + 1) : null
      if (inner !== null) return inner
    }
  }

  return null
}

function simpleVerdict(simple: string, who: Who, depth: number, at: { cwd: string }): Deny | null {
  // Git told where to look, or what to run, through the environment.
  // Any mention of one of git's own variables is refused, however it is set.
  const bare = simple.replace(/['"\\]/g, '')
  if (/GIT_[A-Z0-9_]+/.test(bare)) return deny(SETTINGS, simple)
  // The variables through which the shell is in another folder than it shows.
  if (/\b(CDPATH|OLDPWD)\b/.test(bare) || /(^|\s)(HOME|PWD)=/.test(bare)) return deny(NOT_PLAIN, simple)
  // The git folder is not named at all, in any word or option value: git's
  // own commands say what is in it, and a text check cannot tell a read from
  // a write.
  const raw = simple.trim().split(/\s+/)
  if (raw.some(word => word.split('=').some(namesGitFolder))) return deny(GIT_FOLDER, simple)
  const words = wordsOf(simple)
  const program = baseName(words[0] ?? '')
  if (program === '') return null
  // Git's helper programs (`git-receive-pack`, …) are git by another name.
  if (isOdd(words[0]) || program.startsWith('git-')) return deny(NOT_PLAIN, simple)
  // A shell or `eval` runs the text it is given: that text is judged too. The
  // text follows `-c`, also when the flag is joined with others (`-lc`).
  if (SHELLS.includes(program) || program === 'eval') {
    const flag = words.findIndex((word, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
    const from = program === 'eval' ? 1 : flag + 1
    if (from > 0) {
      if (depth >= 2) return deny(TOO_DEEP, simple)
      const inner = commandVerdict(words.slice(from).join(' '), who, depth + 1)
      if (inner !== null) return inner
    }
  }
  // Into the git folder: what follows would write there with no path to see.
  // A change of folder that the fence cannot follow: to a folder it cannot
  // read (a variable, a pattern, a home folder), back to the last one, or home.
  if (['cd', 'pushd'].includes(program) && (words.length === 1 || words.slice(1).some(word => word === '-' || isOdd(word)))) {
    return deny(NOT_PLAIN, simple)
  }
  if (program === 'popd' || program === 'dirs') return deny(NOT_PLAIN, simple)
  // The shell stays inside the job (or in scratch space): a write after a
  // change of folder is then inside it too.
  const isInJob = (full: string | null) => full !== null && (isIn(full, who.worktree) || full === who.outFile || SCRATCH.some(folder => isIn(full, folder)))
  // The folder that `at.cwd` holds is where the shell is only when every `cd`
  // before took effect; one in brackets, in a pipe or in the background did
  // not. So a path with `..` must be inside the job from the worktree too,
  // which is the highest folder of the job the shell can be in.
  const isInside = (path: string) =>
    isInJob(resolvePath(path, at.cwd)) && (!path.split('/').includes('..') || isInJob(resolvePath(path, who.worktree)))
  if (program === 'cd' || program === 'pushd') {
    // One folder, and no entry of the folder stack (`+1`, `-2`).
    const folders = words.slice(1).filter(word => !word.startsWith('-') && !word.startsWith('+'))
    if (folders.length !== 1 || words.slice(1).some(word => /^[+-]\d+$/.test(word))) return deny(NOT_PLAIN, simple)
    const to = resolvePath(folders[0] ?? '', at.cwd)
    if (to === null || !isInside(folders[0] ?? '')) return deny(OUT_WRITE, simple)
    at.cwd = to
  }
  if (SETTERS.includes(program) && words.slice(1).some(isOdd)) return deny(NOT_PLAIN, simple)
  if (program === 'printf' && words.includes('-v')) return deny(NOT_PLAIN, simple)
  if (program === 'git') {
    const refused = gitVerdict(words, simple)
    if (refused !== null) return refused
  }
  // The host's own commands: the line talks to GitHub and to Azure DevOps.
  if (program === 'gh' || (program === 'az' && ['repos', 'boards', 'devops', 'rest'].includes(words[1] ?? ''))) return deny(HOST, simple)
  if (isForbidden(words, who.forbiddenCommands)) return deny(FORBIDDEN, simple)
  // A write to a place that only the shell knows (a variable, a home folder) cannot be judged.
  const writes = simple.includes('>') || WRITERS.includes(program) || (program === 'sed' && words.some(word => word.startsWith('-i')))

  if (!writes) return null
  if (raw.some(word => /[$~]/.test(word))) return deny(NOT_PLAIN, simple)
  // A path in a write is inside the job (the worktree, the one report file)
  // or in scratch space. The text check cannot tell what is read from what is
  // written, so every full path and every path with `..` is held to this.
  // A path can follow a write mark or an `=` with no space (`x>/path`,
  // `--to=/path`), or a one-letter option (`-t/path`).
  const pathsOf = (word: string) =>
    unquote(word)
      .replace(/^-[A-Za-z]+(?=[/.])/, '')
      .split(/[>=]/)
  for (const path of raw.flatMap(pathsOf)) {
    if (!path.startsWith('/') && !path.split('/').includes('..')) continue
    if (!isInside(path)) return deny(OUT_WRITE, simple)
  }

  return null
}

function commandVerdict(command: string, who: Who, depth: number): Deny | null {
  // The folder the shell is in, followed from one simple command to the next:
  // a write with a relative path is judged from there.
  const at = { cwd: who.worktree }
  // `>|` is a write mark, not a pipe. Braces stay in the words: a group of
  // choices in a command is refused as not plain.
  for (const simple of command.replace(/>\|/g, '>').split(SPLIT)) {
    const refused = simpleVerdict(simple, who, depth, at)
    if (refused !== null) return refused
  }

  return null
}

export function fenceOf(call: { tool: string; input: unknown }, who: Who): Verdict {
  if (!toolsOf(who.role, who.shell).includes(call.tool)) {
    // A builder in a container has no shell of this machine. Its type does
    // not hold one; a call of one is refused here too, not passed on.
    if (call.tool === 'Bash' && who.role === 'builder') return deny(NO_SHELL, isObject(call.input) ? (text(call.input.command) ?? '') : '')

    return null
  }
  if (!isObject(call.input)) return deny(NOT_UNDERSTOOD, '')
  if (call.tool === 'Read' || call.tool === 'Glob' || call.tool === 'Grep') return readVerdict(call.tool, call.input, who)
  if (call.tool === 'Write' || call.tool === 'Edit') return writeVerdict(call.input, who)
  if (call.tool === 'Bash') {
    const command = text(call.input.command)
    if (command === null) return deny(NOT_UNDERSTOOD, '')

    return commandVerdict(command, who, 0) ?? ALLOW
  }
  if (call.tool === SHELL_TOOL) {
    // The command runs in the job's container: the container is the fence,
    // and the text is read only for what the repository forbids.
    const command = text(call.input.command)
    if (command === null) return deny(NOT_UNDERSTOOD, '')
    const refused = forbiddenIn(command, who.forbiddenCommands)

    return refused === null ? ALLOW : deny(FORBIDDEN, refused)
  }

  return null
}
