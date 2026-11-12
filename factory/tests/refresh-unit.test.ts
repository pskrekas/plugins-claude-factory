import { expect, test } from 'claude-code/testing'

import { emptyModel } from '../core/model'
import type { PanelModel } from '../core/model'
import type { Io } from '../hooks/io'
import { readers, refresh } from '../hooks/refresh'

// An Io held in memory: no settings file, an empty store.
function fakeIo(): Io & { model: PanelModel } {
  const io = {
    model: emptyModel(),
    now: async () => 9000,
    root: async () => '/r',
    remote: async () => null,
    stat: async () => null,
    readFile: async () => null,
    listDir: async () => [],
    writeFile: async () => undefined,
    run: async () => ({ failed: 'not-found' as const }),
    storeGet: async () => undefined,
    storeSet: async () => undefined,
    getModel: async () => io.model,
    updateModel: async (change: (model: PanelModel) => PanelModel) => {
      io.model = change(io.model)

      return io.model
    },
    status: () => undefined,
    toast: () => undefined,
    sound: () => undefined,
    agents: async () => [],
    isPaneOpen: async () => true,
  }

  return io
}

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
    const io = fakeIo()
    const model = await refresh(io)
    expect(model.notes).toEqual(['broken: failed'])
    expect(model.owed).toEqual({ open: 2 })
    expect(model.readAt).toBe(9000)
    expect(io.model).toEqual(model)
  } finally {
    readers.length = before
  }
})
