// The run file: `<state>/run.json` says that a session runs the line, and
// which items of the queue it has not started yet. `/factory run` writes it;
// the code that advances the jobs takes items from it and removes it when
// nothing is left to do.
import type { Io } from './io'
import { stateDirOf } from './jobs'
import { readInside, writeInside } from './readers/files'

export type Run = { version: 1; session: string; startedAt: number; queue: string[]; plan?: boolean }

const MAX_RUN_CHARS = 20_000
export const MAX_QUEUE = 50
const ITEM_ID = /^[A-Za-z0-9#][A-Za-z0-9_.#-]{0,39}$/

export async function readRun(io: Io, root: string): Promise<Run | null> {
  const dir = await stateDirOf(io, root)
  const text = dir === null ? null : await readInside(io, dir, 'run.json', MAX_RUN_CHARS)
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || typeof r.session !== 'string' || r.session === '' || typeof r.startedAt !== 'number') return null
  if (!Array.isArray(r.queue) || !r.queue.every(id => typeof id === 'string' && ITEM_ID.test(id))) return null

  return {
    version: 1,
    session: r.session,
    startedAt: r.startedAt,
    queue: (r.queue as string[]).slice(0, MAX_QUEUE),
    ...(r.plan === true ? { plan: true } : {}),
  }
}

export async function writeRun(io: Io, root: string, run: Run): Promise<void> {
  const dir = await stateDirOf(io, root)
  if (dir === null) throw new Error('no state folder')
  await writeInside(io, dir, 'run.json', JSON.stringify({ ...run, queue: run.queue.slice(0, MAX_QUEUE) }))
}

export async function endRun(io: Io, root: string): Promise<void> {
  const dir = await stateDirOf(io, root)
  if (dir !== null) await io.run(['rm', '-f', `${dir}/run.json`])
}
