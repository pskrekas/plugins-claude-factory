// The lock rule: one session moves the jobs of a repo (design 8.1). Pure.
// The lock is a small file with the holder's session id and the time of its
// last heartbeat. A holder that has not written for STALE_MS has gone away.

export type LockFile = { session: string; at: number; tree?: string }

export const STALE_MS = 5 * 60_000

const MAX_TREE = 120

// `tree` is the working tree of the holder: what a person can recognise it by.
export function lockText(session: string, now: number, tree?: string): string {
  const lock: LockFile = { session, at: now, ...(tree === undefined ? {} : { tree: tree.slice(0, MAX_TREE) }) }

  return JSON.stringify(lock) + '\n'
}

function parse(text: string | null): LockFile | null {
  if (text === null || text.trim() === '') return null
  try {
    const raw: unknown = JSON.parse(text)
    const lock = raw as Partial<LockFile> | null
    if (typeof lock?.session !== 'string' || lock.session === '') return null
    if (typeof lock.at !== 'number' || !Number.isFinite(lock.at)) return null

    return {
      session: lock.session,
      at: lock.at,
      ...(typeof lock.tree === 'string' && lock.tree !== '' ? { tree: lock.tree.slice(0, MAX_TREE) } : {}),
    }
  } catch {
    return null
  }
}

export function lockOf(text: string | null, session: string, now: number): 'free' | 'mine' | 'theirs' | 'stale' {
  const lock = parse(text)
  if (lock === null) return 'free'
  if (lock.session === session) return 'mine'

  return now - lock.at > STALE_MS ? 'stale' : 'theirs'
}

// Who holds a lock, for the message to the other session: its working tree
// when the lock says one, else its session id.
export function holderOf(text: string | null): string | null {
  const lock = parse(text)

  return lock === null ? null : (lock.tree ?? lock.session.slice(0, 60))
}
