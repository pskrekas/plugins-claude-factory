// The store of the factory's state under <working tree>/.factory/. This is the
// only code that reads or writes there. Agents never write a job file: code
// decides where a job goes, and this file records it.
import { isJobId, parseJob } from '../core/job'
import type { Job } from '../core/job'
import { holderOf, lockOf, lockText } from '../core/lock'
import type { Io } from './io'
import { readInside } from './readers/files'

const DIR = '.factory'
const MAX_JOB_BYTES = 256 * 1024
const MAX_LOCK_BYTES = 4096
const MAX_FOLDERS = 200
const GIT_TIMEOUT_MS = 5_000

export const TRACKED = '.factory/ is tracked by git. It is not used.'
const LINKED = '.factory/ is a link. It is not used.'

export type Jobs = { jobs: Job[]; skipped: number; note: string | null }

// Why the state folder cannot be trusted, or null. A repo could bring a
// `.factory/` folder of its own, with job files that say whatever it likes;
// the plugin's state is local and git-ignored, so a folder that git tracks, or
// one that is a link to somewhere else, is not the plugin's.
async function distrust(io: Io, root: string): Promise<string | null> {
  if ((await io.isLink(`${root}/${DIR}`)) || (await io.isLink(`${root}/${DIR}/jobs`))) return LINKED
  const tracked = await io.run(['git', 'ls-files', '--error-unmatch', DIR], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  })

  return !('failed' in tracked) && tracked.exitCode === 0 ? TRACKED : null
}

export async function readJobs(io: Io, root: string): Promise<Jobs> {
  const why = await distrust(io, root)
  if (why !== null) return { jobs: [], skipped: 0, note: why }

  const folders = (await io.listDir(`${root}/${DIR}/jobs`))
    .filter(name => name.endsWith('/'))
    .map(name => name.slice(0, -1))
    .sort()
    .slice(0, MAX_FOLDERS)
  const jobs: Job[] = []
  let skipped = 0
  for (const folder of folders) {
    const text = isJobId(folder)
      ? await readInside(io, root, `${DIR}/jobs/${folder}/job.json`, MAX_JOB_BYTES)
      : null
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
  const why = await distrust(io, root)
  if (why !== null) throw new Error(why)
  if (await io.isLink(`${root}/${DIR}/jobs/${job.id}`)) throw new Error(LINKED)
  await io.writeFile(`${root}/${DIR}/jobs/${job.id}/job.json`, JSON.stringify(job, null, 2) + '\n')
}

const lockPath = (root: string) => `${root}/${DIR}/lock`

// Takes the lock, or renews it (the heartbeat). The lock is written and then
// read back: it is held only if the file still names this session.
export async function takeLock(
  io: Io,
  root: string,
  now: number,
): Promise<{ isHeld: boolean; holder: string | null }> {
  const session = await io.sessionId()
  const before = await readInside(io, root, `${DIR}/lock`, MAX_LOCK_BYTES)
  if (lockOf(before, session, now) === 'theirs') return { isHeld: false, holder: holderOf(before) }
  if ((await distrust(io, root)) !== null || (await io.isLink(lockPath(root)))) {
    return { isHeld: false, holder: null }
  }
  await io.writeFile(lockPath(root), lockText(session, now))
  const after = await readInside(io, root, `${DIR}/lock`, MAX_LOCK_BYTES)
  const isHeld = lockOf(after, session, now) === 'mine'

  return { isHeld, holder: isHeld ? null : holderOf(after) }
}

// Gives the lock up. Another session's lock is left alone.
export async function releaseLock(io: Io, root: string): Promise<void> {
  const session = await io.sessionId()
  const text = await readInside(io, root, `${DIR}/lock`, MAX_LOCK_BYTES)
  if (lockOf(text, session, 0) === 'mine') await io.writeFile(lockPath(root), '')
}
