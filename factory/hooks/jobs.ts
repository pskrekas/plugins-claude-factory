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

export type Jobs = { jobs: Job[]; skipped: number; note: string | null }

// The state folder of the repository the working tree at `root` belongs to.
export async function stateOf(io: Io, root: string): Promise<string | null> {
  const base = await io.stateDir()

  return base === null ? null : `${base}/${stateFolderOf(await consentKeyOf(io, root))}`
}

export async function readJobs(io: Io, root: string): Promise<Jobs> {
  const dir = await stateOf(io, root)
  if (dir === null) return { jobs: [], skipped: 0, note: NO_HOME }

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
  const dir = await stateOf(io, root)
  if (dir === null) throw new Error(NO_HOME)
  await io.writeFile(`${dir}/jobs/${job.id}/job.json`, JSON.stringify(job, null, 2) + '\n')
}

// Takes the lock, or renews it (the heartbeat). The lock is written and then
// read back: it is held only if the file still names this session.
export async function takeLock(
  io: Io,
  root: string,
  now: number,
): Promise<{ isHeld: boolean; holder: string | null }> {
  const dir = await stateOf(io, root)
  if (dir === null) return { isHeld: false, holder: null }
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
  const dir = await stateOf(io, root)
  if (dir === null) return
  const session = await io.sessionId()
  const text = await readInside(io, dir, 'lock', MAX_LOCK_BYTES)
  if (lockOf(text, session, 0) === 'mine') await io.writeFile(`${dir}/lock`, '')
}
