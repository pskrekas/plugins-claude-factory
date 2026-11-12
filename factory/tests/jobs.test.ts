import { expect, test } from 'claude-code/testing'

import { move, newJob } from '../core/job'
import { STALE_MS, lockOf, lockText } from '../core/lock'
import { readJobs, releaseLock, takeLock, writeJob } from '../hooks/jobs'
import { sha256Hex, stateBaseOf, stateFolderOf } from '../core/state-path'
import { fakeIo } from './kit'

const job = (id: string, at = 1000) => newJob({ id, title: 'Add a thing' }, at)
const DIR = '/state/' + stateFolderOf('/r')
const path = (id: string) => `${DIR}/jobs/${id}/job.json`

test('the lock rule', async () => {
  expect(lockOf(null, 's1', 1000)).toBe('free')
  expect(lockOf('', 's1', 1000)).toBe('free')
  expect(lockOf('garbage', 's1', 1000)).toBe('free')
  expect(lockOf('{"session": 5, "at": "x"}', 's1', 1000)).toBe('free')
  expect(lockOf(lockText('s1', 900), 's1', 1000)).toBe('mine')
  expect(lockOf(lockText('s2', 900), 's1', 1000)).toBe('theirs')
  expect(lockOf(lockText('s2', 900), 's1', 900 + STALE_MS + 1)).toBe('stale')
  expect(lockOf(lockText('s1', 900), 's1', 900 + STALE_MS + 1)).toBe('mine')
})

test('a job written is read back', async () => {
  const io = fakeIo({ files: { '/r/README.md': 'x' } })
  const written = move(job('12'), 'spec', 'ok', 2000)
  await writeJob(io, '/r', written)

  expect(Object.keys(io.files)).toContain(path('12-add-a-thing'))
  expect(io.files[path('12-add-a-thing')]?.endsWith('}\n')).toBe(true)
  expect(await readJobs(io, '/r')).toEqual({ jobs: [written], skipped: 0, note: null })
})

test('bad job files are skipped and counted', async () => {
  const good = job('1')
  const io = fakeIo({
    files: {
      [path(good.id)]: JSON.stringify(good),
      [path('2-half')]: '{ half',
      [path('3-wrong-folder')]: JSON.stringify(job('9')),
      [`${DIR}/jobs/NOT_AN_ID/job.json`]: JSON.stringify(good),
      [`${DIR}/jobs/4-empty/notes.md`]: 'no job file here',
      [`${DIR}/jobs/stray.txt`]: 'a file, not a folder',
      '/r/x': '',
    },
  })

  expect(await readJobs(io, '/r')).toEqual({ jobs: [good], skipped: 4, note: '4 job files skipped' })
})

test('a job file over 256 KiB is skipped without reading it', async () => {
  const big = { ...job('1'), title: 'x' }
  const io = fakeIo({ files: { [path(big.id)]: JSON.stringify(big) + ' '.repeat(300_000) } })

  expect(await readJobs(io, '/r')).toEqual({ jobs: [], skipped: 1, note: '1 job file skipped' })
  expect(io.reads).toEqual([])
})

test('jobs come newest first', async () => {
  const io = fakeIo({ files: { '/r/x': '' } })
  await writeJob(io, '/r', { ...job('1'), updatedAt: 100 })
  await writeJob(io, '/r', { ...job('2'), updatedAt: 300 })
  await writeJob(io, '/r', { ...job('3'), updatedAt: 200 })

  expect((await readJobs(io, '/r')).jobs.map(j => j.itemId)).toEqual(['2', '3', '1'])
})

test('job files inside the repo are never read: the state is under the home folder', async () => {
  const io = fakeIo({
    files: { '/r/.factory/jobs/1-add-a-thing/job.json': JSON.stringify(job('1')), '/r/x': '' },
  })

  expect(await readJobs(io, '/r')).toEqual({ jobs: [], skipped: 0, note: null })
  expect(io.reads).toEqual([])
  await writeJob(io, '/r', job('2'))
  expect(Object.keys(io.files).filter(file => file.startsWith('/r/')).sort()).toEqual([
    '/r/.factory/jobs/1-add-a-thing/job.json',
    '/r/x',
  ])
})

test('the state folder of a repo', async () => {
  expect(stateBaseOf('/home/me', undefined)).toBe('/home/me/.local/state/claude-factory')
  expect(stateBaseOf('/home/me', '/var/state')).toBe('/var/state/claude-factory')
  expect(stateBaseOf('/home/me', 'relative/x')).toBe('/home/me/.local/state/claude-factory')
  expect(stateBaseOf(undefined, undefined)).toBe(null)
  expect(stateBaseOf('not-absolute', undefined)).toBe(null)
  const folder = stateFolderOf('/Users/me/code/my app/.git')
  expect(folder).toMatch(/^[a-z0-9-]{1,48}-[0-9a-f]{16}$/)
  expect(folder.startsWith('users-me-code-my-app-git-')).toBe(true)
  expect(stateFolderOf('/a/b')).not.toBe(stateFolderOf('/a-b'))
  expect(stateFolderOf('/' + 'x'.repeat(500)).length).toBeLessThanOrEqual(65)
  expect(stateFolderOf('../..')).toMatch(/^[0-9a-f]{16}$/)
  // The name ends with the start of the SHA-256 of the whole path.
  expect(stateFolderOf('abc').endsWith('ba7816bf8f01cfea')).toBe(true)
})

test('two working trees of one repository share the jobs', async () => {
  const files = {
    '/r/.git/HEAD': 'x',
    '/r/.git/worktrees/wt/gitdir': '/wt/.git\n',
    '/wt/.git': 'gitdir: /r/.git/worktrees/wt\n',
  }
  const io = fakeIo({ files })
  await writeJob(io, '/wt', job('1'))

  expect((await readJobs(io, '/r')).jobs.map(j => j.itemId)).toEqual(['1'])
  expect(Object.keys(io.files).some(file => file.startsWith('/state/' + stateFolderOf('/r/.git') + '/jobs/'))).toBe(true)
})

test('a job with a bad id is not written', async () => {
  const io = fakeIo({ files: { '/r/x': '' } })
  let error: unknown = null
  await writeJob(io, '/r', { ...job('1'), id: '../x' }).catch(caught => (error = caught))

  expect(error).not.toBe(null)
  expect(Object.keys(io.files)).toEqual(['/r/x'])
})

test('two sessions cannot both hold the lock', async () => {
  const files = { '/r/x': '' }
  const dirs = new Map<string, number>()
  const first = fakeIo({ files, dirs, session: 's1' })
  const second = fakeIo({ files, dirs, session: 's2' })

  expect(await takeLock(first, '/r', 1000)).toEqual({ isHeld: true, holder: null })
  expect(await takeLock(second, '/r', 2000)).toEqual({ isHeld: false, holder: 's1' })
  // A new take by the holder is its heartbeat.
  expect(await takeLock(first, '/r', 3000)).toEqual({ isHeld: true, holder: null })
  expect(await takeLock(second, '/r', 3000 + STALE_MS)).toEqual({ isHeld: false, holder: 's1' })

  // No heartbeat for five minutes: the lock can be taken.
  expect(await takeLock(second, '/r', 3000 + STALE_MS + 1)).toEqual({ isHeld: true, holder: null })
  // The first session's release changes nothing now.
  await releaseLock(first, '/r')
  expect(await takeLock(first, '/r', 3000 + STALE_MS + 2)).toEqual({ isHeld: false, holder: 's2' })

  await releaseLock(second, '/r')
  expect(await takeLock(first, '/r', 3000 + STALE_MS + 3)).toEqual({ isHeld: true, holder: null })
  // A take-over leaves no old lock folder behind.
  expect(Object.keys(files).filter(file => file.includes('lock.old'))).toEqual([])
})

test('a session that saw the lock free, then was slow, does not also get it', async () => {
  const files = { '/r/x': '' }
  const dirs = new Map<string, number>()
  const first = fakeIo({ files, dirs, session: 's1' })
  const second = fakeIo({ files, dirs, session: 's2' })
  await writeJob(first, '/r', job('0')) // the state folder exists and is claimed

  // The second session is held just before its first change to the lock.
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const write = second.writeFile
  const run = second.run
  second.writeFile = async (file, text) => {
    await gate

    return write(file, text)
  }
  second.run = async argv => {
    if (argv[0] === 'mkdir' || argv[0] === 'mv') await gate

    return run(argv)
  }
  const slow = takeLock(second, '/r', 1000)
  for (let tick = 0; tick < 100; tick++) await Promise.resolve()

  expect(await takeLock(first, '/r', 1000)).toEqual({ isHeld: true, holder: null })
  release()
  expect((await slow).isHeld).toBe(false)
  expect(await takeLock(first, '/r', 1001)).toEqual({ isHeld: true, holder: null })
})

test('sessions that take a free lock at the same moment: exactly one holds it', async () => {
  for (let round = 0; round < 20; round++) {
    const files = { '/r/x': '' }
    const dirs = new Map<string, number>()
    const sessions = ['a', 'b', 'c'].map(session => fakeIo({ files, dirs, session }))
    const taken = await Promise.all(sessions.map(io => takeLock(io, '/r', 1000)))
    expect(taken.filter(result => result.isHeld).length).toBe(1)
  }
})

test('sessions that take over a stale lock at the same moment: exactly one holds it', async () => {
  const files = { '/r/x': '' }
  const dirs = new Map<string, number>()
  await takeLock(fakeIo({ files, dirs, session: 'gone' }), '/r', 1000)
  const sessions = ['a', 'b', 'c'].map(session => fakeIo({ files, dirs, session }))
  const later = 1000 + STALE_MS + 1
  const taken = await Promise.all(sessions.map(io => takeLock(io, '/r', later)))

  expect(taken.filter(result => result.isHeld).length).toBe(1)
  const holder = sessions[taken.findIndex(result => result.isHeld)]!
  expect(await takeLock(holder, '/r', later + 1)).toEqual({ isHeld: true, holder: null })
})

test('a job that would not read back is not written', async () => {
  const io = fakeIo({ files: { '/r/x': '' } })
  // It asks, and does not say where it goes back to: parseJob refuses such a file.
  const broken = { ...job('1'), stage: 'needs-human' as const, question: 'q', stoppedIn: null }
  let error: unknown = null
  await writeJob(io, '/r', broken).catch(caught => (error = caught))

  expect(error).not.toBe(null)
  expect(Object.keys(io.files).some(file => file.endsWith('job.json'))).toBe(false)
})

test('job folders beyond the first 200 are counted, not dropped in silence', async () => {
  const files: Record<string, string> = { '/r/x': '' }
  for (let i = 100; i < 305; i++) {
    const j = { ...job(String(i)), updatedAt: i }
    files[path(j.id)] = JSON.stringify(j)
  }
  const read = await readJobs(fakeIo({ files }), '/r')

  expect(read.jobs.length).toBe(200)
  expect(read.note).toBe('5 job folders not read')
})

test('a state folder that is inside the repo is not used', async () => {
  const io = fakeIo({ files: { '/r/x': '' }, stateDir: '/r/.cache/state' })
  const INSIDE = 'The state folder is inside the repo. It is not used.'

  expect(await readJobs(io, '/r')).toEqual({ jobs: [], skipped: 0, note: INSIDE })
  let error: unknown = null
  await writeJob(io, '/r', job('1')).catch(caught => (error = caught))
  expect(String(error)).toContain(INSIDE)
  expect(await takeLock(io, '/r', 1000)).toEqual({ isHeld: false, holder: null })
  expect(Object.keys(io.files)).toEqual(['/r/x'])
})

test('SHA-256', async () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  )
  expect(sha256Hex('é/ü — 日本')).toBe(sha256Hex('é/ü — 日本'))
  expect(sha256Hex('a'.repeat(200))).toMatch(/^[0-9a-f]{64}$/)
})

test('a state folder records its repository, and one that belongs to another is not used', async () => {
  const io = fakeIo({ files: { '/r/x': '' } })
  await writeJob(io, '/r', job('1'))
  expect(io.files[`${DIR}/repo`]).toBe('/r\n')

  // The same folder name, claimed by another repository.
  io.files[`${DIR}/repo`] = '/somewhere/else\n'
  expect(await readJobs(io, '/r')).toEqual({
    jobs: [],
    skipped: 0,
    note: 'The state folder belongs to another repository. It is not used.',
  })
  let error: unknown = null
  await writeJob(io, '/r', job('2')).catch(caught => (error = caught))
  expect(error).not.toBe(null)
  expect(Object.keys(io.files).some(file => file.includes('2-add-a-thing'))).toBe(false)
  expect(await takeLock(io, '/r', 1000)).toEqual({ isHeld: false, holder: null })
  expect(Object.keys(io.files).some(file => file.includes('lock'))).toBe(false)
})
