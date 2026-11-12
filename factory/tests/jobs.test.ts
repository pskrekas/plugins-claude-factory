import { expect, test } from 'claude-code/testing'

import { move, newJob } from '../core/job'
import { STALE_MS, lockOf, lockText } from '../core/lock'
import { readJobs, releaseLock, takeLock, writeJob } from '../hooks/jobs'
import { fakeIo } from './kit'

const job = (id: string, at = 1000) => newJob({ id, title: 'Add a thing' }, at)
const path = (id: string) => `/r/.factory/jobs/${id}/job.json`

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
      '/r/.factory/jobs/NOT_AN_ID/job.json': JSON.stringify(good),
      '/r/.factory/jobs/4-empty/notes.md': 'no job file here',
      '/r/.factory/jobs/stray.txt': 'a file, not a folder',
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

test('a .factory folder that git tracks is not used', async () => {
  const io = fakeIo({ files: { [path('1-add-a-thing')]: JSON.stringify(job('1')) }, tracked: true })

  expect(await readJobs(io, '/r')).toEqual({
    jobs: [],
    skipped: 0,
    note: '.factory/ is tracked by git. It is not used.',
  })
  expect(io.reads).toEqual([])
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
  const first = fakeIo({ files, session: 's1', now: 1000 })
  const second = fakeIo({ files, session: 's2', now: 1000 })

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
})
