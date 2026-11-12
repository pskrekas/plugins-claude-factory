// `/factory init`: looks at the repo and writes a first .claude/factory.json.
import { draftSettings } from '../core/init'
import type { Io } from './io'
import { readInside } from './readers/files'
import { refresh } from './refresh'

const FILE = '.claude/factory.json'
const GIT_TIMEOUT_MS = 5_000
const MAX_PACKAGE_BYTES = 1024 * 1024
const MAX_IGNORE_BYTES = 1024 * 1024

// The branch `origin/HEAD` points at, or null.
async function baseBranchOf(io: Io, root: string): Promise<string | null> {
  const head = await io.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if ('failed' in head || head.exitCode !== 0) return null

  return head.stdout.trim().replace(/^origin\//, '') || null
}

// Makes sure git ignores the factory's state folder: adds the line `.factory/`
// to .gitignore unless it is there. True when it added the line. It does not
// write through a link, and it leaves a file it cannot read as it is.
async function ignoreState(io: Io, root: string): Promise<boolean> {
  const path = `${root}/.gitignore`
  if (await io.isLink(path)) return false
  const exists = (await io.stat(path)) !== null
  const text = exists ? await readInside(io, root, '.gitignore', MAX_IGNORE_BYTES) : ''
  if (text === null) return false
  if (text.split('\n').some(line => line.trim() === '.factory/' || line.trim() === '.factory')) return false
  await io.writeFile(path, text + (text === '' || text.endsWith('\n') ? '' : '\n') + '.factory/\n')

  return true
}

// It never overwrites a settings file, and it never writes through a link: the
// file must end up in this repo.
export async function init(io: Io): Promise<string> {
  const root = await io.root()
  const path = `${root}/${FILE}`
  if ((await io.isLink(path)) || (await io.isLink(`${root}/.claude`))) {
    return `${FILE} is a link. It is not written.`
  }
  if ((await io.stat(path)) !== null) return `${FILE} exists. Edit it by hand.`

  const [remote, baseBranch, packageJson, pyproject] = await Promise.all([
    io.remote(),
    baseBranchOf(io, root),
    readInside(io, root, 'package.json', MAX_PACKAGE_BYTES),
    io.stat(`${root}/pyproject.toml`),
  ])
  await io.writeFile(path, draftSettings({ remote, baseBranch, packageJson, hasPyproject: pyproject !== null }))
  const isIgnored = await ignoreState(io, root)
  await refresh(io)

  return `Wrote ${FILE}. Read it, then run /factory approve.` + (isIgnored ? ' .factory/ is in .gitignore.' : '')
}
