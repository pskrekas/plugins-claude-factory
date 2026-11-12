// The store of the factory's state. This is the only code that reads or writes
// it. Agents never write a job file: code decides where a job goes, and this
// file records it.
//
// The state is not in the repo. It is in a folder of the person's own
// (core/state-path.ts), one per repository, shared by its worktrees. A
// `.factory/` folder that a repo brings along is never read.
import { isJobId, parseJob } from '../core/job'
import type { Job } from '../core/job'
import { holderOf, lockOf, lockText } from '../core/lock'
import { stateFolderOf } from '../core/state-path'
import type { Io } from './io'
import { readInside } from './readers/files'
import { consentKeyOf } from './readers/repo'

const MAX_JOB_BYTES = 256 * 1024
const MAX_LOCK_BYTES = 4096
const MAX_FOLDERS = 200

const NO_HOME = 'No home folder: the factory has no place for its state.'
const NOT_OURS = 'The state folder belongs to another repository. It is not used.'
const MAX_KEY_BYTES = 4096

export type Jobs = { jobs: Job[]; skipped: number; note: string | null }

type State = { dir: string; key: string }

// The state folder of the repository the working tree at `root` belongs to.
async function stateOf(io: Io, root: string): Promise<State | null> {
  const base = await io.stateDir()
  if (base === null) return null
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

export async function readJobs(io: Io, root: string): Promise<Jobs> {
  const state = await stateOf(io, root)
  if (state === null) return { jobs: [], skipped: 0, note: NO_HOME }
  if ((await owner(io, state)) === 'theirs') return { jobs: [], skipped: 0, note: NOT_OURS }
  const { dir } = state

  const folders = (await io.listDir(`${dir}/jobs`))
    .filter(name => name.endsWith('/'))
    .map(name => name.slice(0, -1))
    .sort()
    .slice(0, MAX_FOLDERS)
  const jobs: Job[] = []
  let skipped = 0
  for (const folder of folders) {
    const text = isJobId(folder) ? await readInside(io, dir, `jobs/${folder}/job.json`, MAX_JOB_BYTES) : null
    const job = text === null ? null : parseJob(text, folder)
    if (job === null) skipped++
    else jobs.push(job)
  }
  jobs.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

  return {
    jobs,
    skipped,
    note: skipped > 0 ? `${skipped} job file${skipped === 1 ? '' : 's'} skipped` : null,
  }
}

export async function writeJob(io: Io, root: string, job: Job): Promise<void> {
  if (!isJobId(job.id)) throw new Error(`not a job id: ${job.id.slice(0, 60)}`)
  const state = await stateOf(io, root)
  if (state === null) throw new Error(NO_HOME)
  if (!(await claim(io, state))) throw new Error(NOT_OURS)
  await io.writeFile(`${state.dir}/jobs/${job.id}/job.json`, JSON.stringify(job, null, 2) + '\n')
}

// Takes the lock, or renews it (the heartbeat). The lock is written and then
// read back: it is held only if the file still names this session.
export async function takeLock(
  io: Io,
  root: string,
  now: number,
): Promise<{ isHeld: boolean; holder: string | null }> {
  const state = await stateOf(io, root)
  if (state === null || !(await claim(io, state))) return { isHeld: false, holder: null }
  const { dir } = state
  const session = await io.sessionId()
  const before = await readInside(io, dir, 'lock', MAX_LOCK_BYTES)
  if (lockOf(before, session, now) === 'theirs') return { isHeld: false, holder: holderOf(before) }
  await io.writeFile(`${dir}/lock`, lockText(session, now))
  const after = await readInside(io, dir, 'lock', MAX_LOCK_BYTES)
  const isHeld = lockOf(after, session, now) === 'mine'

  return { isHeld, holder: isHeld ? null : holderOf(after) }
}

// Gives the lock up. Another session's lock is left alone.
export async function releaseLock(io: Io, root: string): Promise<void> {
  const state = await stateOf(io, root)
  if (state === null || (await owner(io, state)) !== 'ours') return
  const { dir } = state
  const session = await io.sessionId()
  const text = await readInside(io, dir, 'lock', MAX_LOCK_BYTES)
  if (lockOf(text, session, 0) === 'mine') await io.writeFile(`${dir}/lock`, '')
}
