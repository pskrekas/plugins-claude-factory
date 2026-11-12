import { expect, test } from 'claude-code/testing'

import { readers, refresh } from '../hooks/refresh'
import { fakeIo } from './kit'

test('a reader that throws is noted and the other readers still write their part', async () => {
  const before = readers.length
  readers.push({
    name: 'broken',
    read: async () => {
      throw new Error('boom')
    },
  })
  readers.push({ name: 'fine', read: async () => ({ owed: { open: 2 } }) })
  try {
    const io = fakeIo({ now: 9000 })
    const model = await refresh(io)
    expect(model.notes).toEqual(['broken: failed'])
    expect(model.owed).toEqual({ open: 2 })
    expect(model.readAt).toBe(9000)
    expect(io.model).toEqual(model)
  } finally {
    readers.length = before
  }
})
