// The store of the factory's state. This is the only code that reads or writes
// it. Agents never write a job file: code decides where a job goes, and this
// file records it.
//
// The state is not in the repo. It is in a folder of the person's own
// (core/state-path.ts), one per repository, shared by its worktrees. A
// `.factory/` folder that a repo brings along is never read.
import { isJobId, parseJob } from '../core/job'
import type { Job } from '../core/job'
import { STALE_MS, holderOf, lockOf, lockText } from '../core/lock'
import { stateFolderOf } from '../core/state-path'
import type { Io } from './io'
import { readInside } from './readers/files'
import { consentKeyOf } from './readers/repo'

const MAX_JOB_BYTES = 256 * 1024
const MAX_LOCK_BYTES = 4096
const MAX_FOLDERS = 200

const NO_HOME = 'No home folder: the factory has no place for its state.'
const INSIDE = 'The state folder is inside the repo. It is not used.'
const NOT_OURS = 'The state folder belongs to another repository. It is not used.'
const MAX_KEY_BYTES = 4096

export type Jobs = { jobs: Job[]; skipped: number; note: string | null }

type State = { dir: string; key: string }
type Refused = { no: string }

// The state folder of the repository the working tree at `root` belongs to,
// or why there is none. A folder that is inside the working tree is refused:
// the environment (`XDG_STATE_HOME`) can be set by more than the person, and
// state inside the repo is what a repo could bring along.
async function stateOf(io: Io, root: string): Promise<State | Refused> {
  const base = await io.stateDir()
  if (base === null) return { no: NO_HOME }
  const baseReal = (await io.stat(base))?.realPath ?? base
  const rootReal = (await io.stat(root))?.realPath ?? root
  const isIn = (path: string, tree: string) => path === tree || path.startsWith(tree + '/')
  if (isIn(baseReal, rootReal) || isIn(base, root)) return { no: INSIDE }
  const key = await consentKeyOf(io, root)

  return { dir: `${base}/${stateFolderOf(key)}`, key }
}

// A state folder holds a file `repo` with the path of its repository. A folder
// whose file names another repository is not this one's, whatever its name.
// `unclaimed` is a folder with no such file yet: nothing was ever written.
async function owner(io: Io, state: State): Promise<'ours' | 'theirs' | 'unclaimed'> {
  const text = await readInside(io, state.dir, 'repo', MAX_KEY_BYTES)
  if (text === null) return (await io.stat(`${state.dir}/repo`)) === null ? 'unclaimed' : 'theirs'

  return text.replace(/\n$/, '') === state.key ? 'ours' : 'theirs'
}

// Claims the folder for this repository before the first write. False when it
// is another repository's.
async function claim(io: Io, state: State): Promise<boolean> {
  const who = await owner(io, state)
  if (who === 'unclaimed') await io.writeFile(`${state.dir}/repo`, state.key + '\n')

  return who !== 'theirs'
}

// What `/factory where` answers: the state folder of this repository.
export async function whereText(io: Io, root: string): Promise<string> {
  const state = await stateOf(io, root)

  return 'no' in state ? state.no : `The factory keeps its state for this repository in:\n${state.dir}`
}

export async function readJobs(io: Io, root: string): Promise<Jobs> {
  const state = await stateOf(io, root)
  if ('no' in state) return { jobs: [], skipped: 0, note: state.no }
  if ((await owner(io, state)) === 'theirs') return { jobs: [], skipped: 0, note: NOT_OURS }
  const { dir } = state

  const all = (await io.listDir(`${dir}/jobs`))
    .filter(name => name.endsWith('/'))
    .map(name => name.slice(0, -1))
    .sort()
  const jobs: Job[] = []
  let skipped = 0
  for (const folder of all.slice(0, MAX_FOLDERS)) {
    const text = isJobId(folder) ? await readInside(io, dir, `jobs/${folder}/job.json`, MAX_JOB_BYTES) : null
    const job = text === null ? null : parseJob(text, folder)
    if (job === null) skipped++
    else jobs.push(job)
  }
  jobs.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

  // Nothing is left out in silence: a file that could not be read, and a
  // folder beyond the number read at one time, are both counted.
  const unread = all.length - Math.min(all.length, MAX_FOLDERS)
  const notes = [
    skipped > 0 ? `${skipped} job file${skipped === 1 ? '' : 's'} skipped` : null,
    unread > 0 ? `${unread} job folder${unread === 1 ? '' : 's'} not read` : null,
  ].filter(Boolean)

  return { jobs, skipped, note: notes.length > 0 ? notes.join(' · ') : null }
}

// A job is written only if the store can read it back: the same check a file
// from disk gets. So no move can leave a job that is skipped ever after.
export async function writeJob(io: Io, root: string, job: Job): Promise<void> {
  if (!isJobId(job.id)) throw new Error(`not a job id: ${job.id.slice(0, 60)}`)
  const text = JSON.stringify(job, null, 2) + '\n'
  if (text.length > MAX_JOB_BYTES || parseJob(text, job.id) === null) {
    throw new Error(`a job the store could not read back: ${job.id}`)
  }
  const state = await stateOf(io, root)
  if ('no' in state) throw new Error(state.no)
  if (!(await claim(io, state))) throw new Error(NOT_OURS)
  await io.writeFile(`${state.dir}/jobs/${job.id}/job.json`, text)
}

// The lock is a folder `lock.<n>` with a file `holder` in it. Making a folder
// is the one step two sessions cannot both do, so the lock is taken by making
// the next generation: of the sessions that try at one moment, one `mkdir`
// succeeds. The newest generation is the lock; older ones are leftovers.
const GENERATION = /^lock\.(\d{1,9})\/$/
const ran = (result: Awaited<ReturnType<Io['run']>>) => !('failed' in result) && result.exitCode === 0

async function generations(io: Io, dir: string): Promise<number[]> {
  return (await io.listDir(dir))
    .map(name => GENERATION.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
}

// Takes the lock, or renews it (the heartbeat).
export async function takeLock(
  io: Io,
  root: string,
  now: number,
): Promise<{ isHeld: boolean; holder: string | null }> {
  const state = await stateOf(io, root)
  if ('no' in state || !(await claim(io, state))) return { isHeld: false, holder: null }
  const { dir } = state
  const session = await io.sessionId()
  const holderOfGen = (n: number) => readInside(io, dir, `lock.${n}/holder`, MAX_LOCK_BYTES)
  const hold = async (n: number) => {
    await io.writeFile(`${dir}/lock.${n}/holder`, lockText(session, now))

    return { isHeld: true, holder: null }
  }

  const all = await generations(io, dir)
  const top = all.at(-1)
  if (top !== undefined) {
    const text = await holderOfGen(top)
    let who = lockOf(text, session, now)
    if (who === 'free') {
      // A lock folder with no holder yet: a session is taking it this moment,
      // unless the folder is old (that session went away before it wrote).
      const made = (await io.stat(`${dir}/lock.${top}`))?.mtimeMs ?? now
      who = now - made > STALE_MS ? 'stale' : 'theirs'
    }
    if (who === 'mine') return hold(top)
    if (who === 'theirs') return { isHeld: false, holder: holderOf(text) }
  }

  const next = (top ?? 0) + 1
  if (!ran(await io.run(['mkdir', `${dir}/lock.${next}`]))) {
    return { isHeld: false, holder: holderOf(await holderOfGen(next)) }
  }
  const held = await hold(next)
  for (const old of all) await io.run(['rm', '-r', `${dir}/lock.${old}`])

  return held
}

// Gives the lock up. Another session's lock is left alone.
export async function releaseLock(io: Io, root: string): Promise<void> {
  const state = await stateOf(io, root)
  if ('no' in state || (await owner(io, state)) !== 'ours') return
  const session = await io.sessionId()
  const top = (await generations(io, state.dir)).at(-1)
  if (top === undefined) return
  const text = await readInside(io, state.dir, `lock.${top}/holder`, MAX_LOCK_BYTES)
  if (lockOf(text, session, 0) === 'mine') await io.run(['rm', '-r', `${state.dir}/lock.${top}`])
}
