// The lock rule: one session moves the jobs of a repo (design 8.1). Pure.
// The lock is a small file with the holder's session id and the time of its
// last heartbeat. A holder that has not written for STALE_MS has gone away.

export type LockFile = { session: string; at: number }

export const STALE_MS = 5 * 60_000

export function lockText(session: string, now: number): string {
  return JSON.stringify({ session, at: now } satisfies LockFile) + '\n'
}

function parse(text: string | null): LockFile | null {
  if (text === null || text.trim() === '') return null
  try {
    const raw: unknown = JSON.parse(text)
    const lock = raw as Partial<LockFile> | null
    if (typeof lock?.session !== 'string' || lock.session === '') return null

    return typeof lock.at === 'number' && Number.isFinite(lock.at) ? { session: lock.session, at: lock.at } : null
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

// The session that holds a lock, for the message to the other one.
export function holderOf(text: string | null): string | null {
  return parse(text)?.session.slice(0, 60) ?? null
}
