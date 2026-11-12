import { expect, test } from 'claude-code/testing'

import { stateFolderOf } from '../core/state-path'
import { drainFacts, dropFact } from '../hooks/inbox'
import type { Fact } from '../hooks/inbox'
import { fakeIo } from './kit'

const DIR = '/state/' + stateFolderOf('/r/.git')
const world = (extra: Record<string, string> = {}) => fakeIo({ files: { '/r/.git/HEAD': 'x', ...extra } })
const inbox = (io: { files: Record<string, string> }) => Object.keys(io.files).filter(name => name.startsWith(`${DIR}/inbox/`))
const USAGE = { model: 'm', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }

test('facts are read oldest first, and each is removed when it is read', async () => {
  const io = world()
  await dropFact(io, '/r', { kind: 'refusal', agentId: 'a1', command: 'git push', at: 5000 })
  await dropFact(io, '/r', { kind: 'turn', agentId: 'a2', answer: 'DONE\n' + 'x'.repeat(5000), ms: 900, usage: USAGE, reason: 'answer', at: 300 })
  expect(inbox(io).length).toBe(2)

  const facts = await drainFacts(io, '/r')
  expect(facts.map(fact => [fact.kind, fact.at])).toEqual([['turn', 300], ['refusal', 5000]])
  const turn = facts[0] as Fact & { kind: 'turn' }
  expect([turn.answer.length, turn.answer.startsWith('DONE'), turn.usage, turn.ms]).toEqual([2000, true, USAGE, 900])
  expect(inbox(io)).toEqual([])
  expect(await drainFacts(io, '/r')).toEqual([])
})

test('a file that is not a fact is skipped, and removed', async () => {
  const good = JSON.stringify({ kind: 'refusal', agentId: 'a1', command: 'x', at: 9 })
  const io = world({
    [`${DIR}/inbox/000000000000001-a.json`]: 'not json',
    [`${DIR}/inbox/000000000000002-b.json`]: JSON.stringify({ kind: 'other', agentId: 'a1', at: 2 }),
    [`${DIR}/inbox/000000000000003-c.json`]: JSON.stringify({ kind: 'turn', agentId: 'a1', answer: 5, ms: 1, usage: null, reason: 'answer', at: 3 }),
    [`${DIR}/inbox/000000000000004-d.json`]: JSON.stringify({ kind: 'refusal', agentId: 'a1', command: 'y'.repeat(30_000), at: 4 }),
    [`${DIR}/inbox/000000000000009-e.json`]: good,
    [`${DIR}/inbox/notes.txt`]: 'x',
  })
  expect(await drainFacts(io, '/r')).toEqual([{ kind: 'refusal', agentId: 'a1', command: 'x', at: 9 }])
  expect(inbox(io)).toEqual([])
})

test('at most 200 facts at one time; the rest wait', async () => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 250; i++) {
    files[`${DIR}/inbox/${String(i).padStart(15, '0')}-x.json`] = JSON.stringify({ kind: 'refusal', agentId: 'a1', command: `c${i}`, at: i })
  }
  const io = world(files)
  const first = await drainFacts(io, '/r')
  expect([first.length, first[0]?.at, first[199]?.at, inbox(io).length]).toEqual([200, 0, 199, 50])
  expect((await drainFacts(io, '/r')).length).toBe(50)
})
