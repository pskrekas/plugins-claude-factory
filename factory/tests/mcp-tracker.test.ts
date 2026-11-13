import { expect, test } from 'claude-code/testing'

import { NO_SERVER, mcpTracker, rejectedOf, resultOf } from '../adapters/mcp-tracker'
import type { Call } from '../adapters/mcp-tracker'
import { storeKey } from '../core/consent'
import { mcpLines, parseMcpTracker } from '../core/mcp-tracker'
import type { Json, McpResult, McpTracker } from '../core/mcp-tracker'

import { START, cmd, engine, paneText } from './kit'
import { GOOD, step } from './mcp-good'

const specOf = (over: Record<string, unknown> = {}): McpTracker => {
  const parsed = parseMcpTracker({ ...GOOD, ...over })
  if ('no' in parsed) throw new Error(parsed.no)

  return parsed.ok
}
const SPEC = specOf()
const text = (t: string, isError = false): McpResult => ({ content: [{ type: 'text', text: t }], isError })
const json = (v: unknown): McpResult => text(JSON.stringify(v))
const TASK = { title: 'Add dark mode', description: 'Do it', made_by: 'Author', state: 'Open', labels: ['bug', 'factory'], comments: [{ by: 'Author', text: 'Hi' }] }
const PR = 'https://code.example.com/a/b/pull/7'

type Answer = McpResult | ((args: { [key: string]: Json }) => McpResult)
// A server held in memory: it answers each tool from the table, and keeps every call.
function server(table: Record<string, Answer> = {}) {
  const calls: [string, { [key: string]: Json }][] = []
  const answers: Record<string, Answer> = {
    find_tasks: args => json({ tasks: JSON.stringify(args.states) === '["open"]' ? [{ id: 'PROJ-12', title: 'Add dark mode', state: 'Open' }] : [{ id: 'PROJ-13', title: 'Fonts', state: 'Started' }] }),
    show_task: json(TASK),
    add_comment: text('Saved.'),
    move_task: json({}),
    attach_link: text('Linked.'),
    who_am_i: json({ name: 'Runner' }),
    ...table,
  }
  const call: Call = async (tool, args) => {
    calls.push([tool, args])
    const answer = answers[tool]
    if (answer === undefined) return { failed: 'no-server', why: 'no such tool on a connected server' }

    return typeof answer === 'function' ? answer(args) : answer
  }

  return { call, calls }
}

test('the five actions call the tools of the settings, with the values in place', async () => {
  const s = server()
  const t = mcpTracker(s.call, SPEC, 'factory', [])
  expect(t.kind).toBe('mcp')
  expect(await t.scan()).toEqual({
    items: [{ id: 'PROJ-12', title: 'Add dark mode', state: 'open' }],
    claimed: [{ id: 'PROJ-13', title: 'Fonts', state: 'started' }],
    result: null,
    note: null,
  })
  expect(s.calls).toEqual([
    ['find_tasks', { label: 'factory', states: ['open'] }],
    ['find_tasks', { label: 'factory', states: ['started'] }],
  ])
  s.calls.length = 0
  expect(await t.read('PROJ-12')).toEqual({
    id: 'PROJ-12',
    title: 'Add dark mode',
    state: 'open',
    text: 'Do it',
    author: 'author',
    url: 'https://tracker.example.com/tasks/PROJ-12',
    comments: [{ author: 'author', text: 'Hi' }],
  })
  await t.comment('PROJ-12', 'The factory started on this.')
  await t.linkPr('PROJ-12', PR)
  await t.setState('PROJ-12', 'in-progress')
  expect(s.calls).toEqual([
    ['show_task', { task_id: 'PROJ-12' }],
    ['add_comment', { task_id: 'PROJ-12', text: 'The factory started on this.' }],
    ['attach_link', { task_id: 'PROJ-12', ref: PR }],
    ['move_task', { task_id: 'PROJ-12', to: 'started' }],
  ])
  // The person who runs the line is asked once.
  s.calls.length = 0
  expect([await t.me(), await t.me()]).toEqual(['runner', 'runner'])
  expect(s.calls).toEqual([['who_am_i', {}]])
  expect((await t.list('factory')).map(item => item.id)).toEqual(['PROJ-12'])
})

test('an optional step that fails does not fail the move; another one does', async () => {
  const s = server({ move_task: args => (args.to === 'started' ? json({}) : text('Tick every point first.', true)) })
  const spec = specOf({ states: { 'needs-human': [step('waiting', { optional: true }), step('started')], done: [step('closed'), step('started')] } })
  const t = mcpTracker(s.call, spec, 'factory', [])
  await t.setState('PROJ-12', 'needs-human')
  expect(s.calls.map(([, args]) => args.to)).toEqual(['waiting', 'started'])
  s.calls.length = 0
  await expect(t.setState('PROJ-12', 'done')).rejects.toThrow('move_task: Tick every point first.')
  expect(s.calls.map(([, args]) => args.to)).toEqual(['closed'])
  // A state with no entry calls nothing.
  s.calls.length = 0
  await t.setState('PROJ-12', 'rejected')
  expect(s.calls).toEqual([])
})

const LABELS = { labels: { tool: 'edit_item', args: { key: '{id}', fields: { labels: '{labels}' } } } }

test('states as labels: read, then write the whole list', async () => {
  const s = server({ show_task: json({ ...TASK, labels: ['bug', 'factory', 'Factory:In-Progress'] }), edit_item: json({}) })
  const t = mcpTracker(s.call, specOf({ states: LABELS, comments: { tool: 'list_comments', args: { task_id: '{id}' }, rows: 'items', author: 'by', text: 'text' } }), 'factory', [])
  await t.setState('PROJ-12', 'done')
  // The labels are read with no comment: one call.
  expect(s.calls).toEqual([
    ['show_task', { task_id: 'PROJ-12' }],
    ['edit_item', { key: 'PROJ-12', fields: { labels: ['bug', 'factory', 'factory:done'] } }],
  ])
  // An item that cannot be read is not written.
  const broken = server({ show_task: text('No such task.', true), edit_item: json({}) })
  await expect(mcpTracker(broken.call, specOf({ states: LABELS }), 'factory', []).setState('PROJ-12', 'done')).rejects.toThrow('show_task: the item could not be read')
  expect(broken.calls.map(([tool]) => tool)).toEqual(['show_task'])
  // A write that the server refuses fails the move.
  const refused = server({ edit_item: text('No rights.', true) })
  await expect(mcpTracker(refused.call, specOf({ states: LABELS }), 'factory', []).setState('PROJ-12', 'done')).rejects.toThrow('edit_item: No rights.')
})

test('a write that answers a plain sentence passed; one that says isError failed', async () => {
  const s = server()
  await mcpTracker(s.call, SPEC, 'factory', []).comment('PROJ-12', 'Hello')
  const refused = server({ add_comment: text('Comments are closed.\nSecond line', true) })
  await expect(mcpTracker(refused.call, SPEC, 'factory', []).comment('PROJ-12', 'Hello')).rejects.toThrow('add_comment: Comments are closed.')
  const gone = server({ add_comment: { failed: 'no-server', why: 'no such tool on a connected server' } })
  await expect(mcpTracker(gone.call, SPEC, 'factory', []).comment('PROJ-12', 'Hello')).rejects.toThrow('add_comment: no such tool on a connected server')
})

test('with no linkPr the address is a comment; a bad address is refused before any call', async () => {
  const s = server()
  const t = mcpTracker(s.call, specOf({ linkPr: undefined }), 'factory', [])
  await t.linkPr('PROJ-12', PR)
  expect(s.calls).toEqual([['add_comment', { task_id: 'PROJ-12', text: `Pull request: ${PR}` }]])
  s.calls.length = 0
  for (const tracker of [t, mcpTracker(s.call, SPEC, 'factory', [])]) {
    for (const bad of ['http://code.example.com/7', 'https://code.example.com/a b', '']) await expect(tracker.linkPr('PROJ-12', bad)).rejects.toThrow('not a pull request address')
  }
  expect(s.calls).toEqual([])
})

test('a forbidden word stops the comment before any call', async () => {
  const s = server()
  const t = mcpTracker(s.call, specOf({ linkPr: undefined }), 'factory', ['secret', 'pull'])
  await expect(t.comment('PROJ-12', 'A SECRET plan')).rejects.toThrow('the comment was not sent: a forbidden word')
  await expect(t.comment('PROJ-12', '  ')).rejects.toThrow('the comment was not sent: empty')
  // The address as a comment is held to the same rule.
  await expect(t.linkPr('PROJ-12', PR)).rejects.toThrow('the comment was not sent: a forbidden word')
  expect(s.calls).toEqual([])
  // What is sent is the cleaned text.
  await mcpTracker(s.call, SPEC, 'factory', []).comment('PROJ-12', 'a​b\nc')
  expect(s.calls).toEqual([['add_comment', { task_id: 'PROJ-12', text: 'ab\nc' }]])
})

test('the server did not answer: the note says how to connect it', async () => {
  const empty = { items: null, claimed: [], result: null }
  const scanWith = (answer: Answer) => mcpTracker(server({ find_tasks: answer }).call, SPEC, 'factory', []).scan()
  expect(NO_SERVER('tasks')).toBe('The MCP server tasks did not answer. Connect it with /mcp, or check the tool names in the settings.')
  expect(await scanWith({ failed: 'no-server', why: 'not connected' })).toEqual({ ...empty, note: NO_SERVER('tasks') })
  expect(await scanWith({ failed: 'timeout', why: 'no answer in time' })).toEqual({ ...empty, note: 'The MCP server tasks did not answer in time.' })
  expect(await scanWith({ failed: 'other', why: 'it broke' })).toEqual({ ...empty, note: 'find_tasks: it broke' })
  expect(await scanWith(text('Unknown label.', true))).toEqual({ ...empty, note: 'find_tasks: Unknown label.' })
  expect(await scanWith(text('not json'))).toEqual({ ...empty, note: 'find_tasks: the answer is not JSON' })
  expect(await scanWith(json({ more: true }))).toEqual({ ...empty, note: 'find_tasks: the answer holds no list of rows' })
  expect(await mcpTracker(server({ find_tasks: text('x', true) }).call, SPEC, 'factory', []).list('factory')).toEqual([])
  // A claimed list that cannot be read leaves the queue as it is.
  const half = server({ find_tasks: args => (JSON.stringify(args.states) === '["open"]' ? json({ tasks: [{ id: 'PROJ-12', title: 'A' }] }) : text('down', true)) })
  expect(await mcpTracker(half.call, SPEC, 'factory', []).scan()).toEqual({ items: [{ id: 'PROJ-12', title: 'A', state: '' }], claimed: [], result: null, note: null })
  // With no claimed call, nothing is claimed.
  const one = server()
  expect((await mcpTracker(one.call, specOf({ claimed: undefined }), 'factory', []).scan()).claimed).toEqual([])
  expect(one.calls.length).toBe(1)
})

test('hasMark: by the labels, in any case; without labels, by the list', async () => {
  const marked = server({ show_task: json({ ...TASK, labels: ['Bug', { name: 'FACTORY' }] }) })
  expect(await mcpTracker(marked.call, SPEC, 'factory', []).hasMark('PROJ-12')).toBe(true)
  expect(marked.calls.map(([tool]) => tool)).toEqual(['show_task'])
  expect(await mcpTracker(server({ show_task: json({ ...TASK, labels: ['bug'] }) }).call, SPEC, 'factory', []).hasMark('PROJ-12')).toBe(false)
  expect(await mcpTracker(server({ show_task: json({ ...TASK, labels: 'factory' }) }).call, SPEC, 'factory', []).hasMark('PROJ-12')).toBe(false)
  expect(await mcpTracker(server({ show_task: text('x', true) }).call, SPEC, 'factory', []).hasMark('PROJ-12')).toBe(false)
  // No labels in the read: the item must be a row of the list or of the claimed.
  const read = { ...GOOD.read, labels: undefined }
  const s = server()
  const t = mcpTracker(s.call, specOf({ read }), 'factory', [])
  expect([await t.hasMark('PROJ-12'), await t.hasMark('PROJ-13'), await t.hasMark('PROJ-14')]).toEqual([true, true, false])
  expect(s.calls.every(([tool]) => tool === 'find_tasks')).toBe(true)
  expect(await mcpTracker(server({ find_tasks: text('x', true) }).call, specOf({ read }), 'factory', []).hasMark('PROJ-12')).toBe(false)
})

test('an id that breaks the rule calls nothing', async () => {
  const s = server()
  for (const spec of [SPEC, specOf({ read: { ...GOOD.read, labels: undefined } }), specOf({ states: LABELS })]) {
    const t = mcpTracker(s.call, spec, 'factory', [])
    expect(await t.read('a b')).toBe(null)
    expect(await t.hasMark('a b')).toBe(false)
    await expect(t.comment('a b', 'Hello')).rejects.toThrow('add_comment: not sent (a value broke a rule)')
    await expect(t.setState('a b', 'done')).rejects.toThrow()
    await expect(t.linkPr('a b', PR)).rejects.toThrow()
  }
  expect(s.calls).toEqual([])
})

test("with a comments call, the read's own comment keys are set aside; comments that cannot be read leave no item", async () => {
  const comments = { tool: 'list_comments', args: { task_id: '{id}' }, rows: 'items', author: 'by', text: 'text' }
  const { comments: _, ...bare } = TASK
  const s = server({ show_task: json(bare), list_comments: json({ items: [{ by: 'Author', text: 'From the author' }, { by: 3, text: 'x' }] }) })
  const t = mcpTracker(s.call, specOf({ comments }), 'factory', [])
  expect((await t.read('PROJ-12'))?.comments).toEqual([{ author: 'author', text: 'From the author' }])
  expect(s.calls).toEqual([
    ['show_task', { task_id: 'PROJ-12' }],
    ['list_comments', { task_id: 'PROJ-12' }],
  ])
  // Read alone: one call, no comment.
  s.calls.length = 0
  expect((await t.read('PROJ-12', false))?.comments).toEqual([])
  expect(s.calls.length).toBe(1)
  for (const answer of [text('down', true), json({ other: [] }), text('not json')]) {
    expect(await mcpTracker(server({ show_task: json(bare), list_comments: answer }).call, specOf({ comments }), 'factory', []).read('PROJ-12')).toBe(null)
  }
  // Without a comments call, an item whose comments are not in the answer is not read.
  expect(await mcpTracker(server({ show_task: json(bare) }).call, SPEC, 'factory', []).read('PROJ-12')).toBe(null)
  expect((await mcpTracker(server({ show_task: json(bare) }).call, SPEC, 'factory', []).read('PROJ-12', false))?.title).toBe('Add dark mode')
})

test('me: none without the call; a failure is asked once too', async () => {
  const s = server()
  expect(await mcpTracker(s.call, specOf({ me: undefined }), 'factory', []).me()).toBe(null)
  expect(s.calls).toEqual([])
  for (const answer of [text('x', true), json({ name: 7 }), json({ name: '' })]) {
    const f = server({ who_am_i: answer })
    const t = mcpTracker(f.call, SPEC, 'factory', [])
    expect([await t.me(), await t.me()]).toEqual([null, null])
    expect(f.calls.length).toBe(1)
  }
  expect(await mcpTracker(server({ who_am_i: json({ name: 'R'.repeat(300) }) }).call, SPEC, 'factory', []).me()).toBe('r'.repeat(200))
})

test("the engine's result is copied: text blocks only, isError only when true, structuredContent only as a plain object", () => {
  const raw = { content: [{ type: 'text', text: '{"a":1}', extra: 1 }, { type: 'image', data: 'x' }, 'junk', null], isError: 'yes', structuredContent: { a: [1] }, other: 2 }
  const copied = resultOf(raw)
  expect(copied).toEqual({ content: [{ type: 'text', text: '{"a":1}' }], isError: false, structuredContent: { a: [1] } })
  expect((copied as { structuredContent: unknown }).structuredContent).not.toBe(raw.structuredContent)
  expect(resultOf({ content: 'x', isError: true, structuredContent: [1] })).toEqual({ content: [], isError: true })
  for (const odd of [null, 'x', 3, []]) expect(resultOf(odd)).toEqual({ content: [], isError: false })
})

test('a rejection of the engine: a tool that is not there, or another failure', () => {
  expect(rejectedOf(new Error('factory: $.mcp.call: no connected MCP tool "find_tasks" on a server named "tasks"'))).toEqual({ failed: 'no-server', why: 'no such tool on a connected server' })
  expect(rejectedOf(new Error('\u001b[31mit broke\u001b[0m\nsecond line'))).toEqual({ failed: 'other', why: '[31mit broke[0m' })
  expect(rejectedOf('x'.repeat(400))).toEqual({ failed: 'other', why: 'x'.repeat(150) })
  expect(rejectedOf(undefined)).toEqual({ failed: 'other', why: 'failed' })
})

const SETTINGS = { '/r/.claude/factory.json': JSON.stringify({ tracker: GOOD }) }
const LINES = mcpLines(SPEC, 'factory')

const ANSWER = (_: string, tool: string, args: Record<string, unknown>) =>
  tool === 'find_tasks' ? { content: [{ type: 'text', text: JSON.stringify({ tasks: JSON.stringify(args.states) === '["open"]' ? [{ id: 'PROJ-12', title: 'A' }] : [] }) }], isError: false } : undefined

test('the panel asks no MCP tool while the calls are not approved', async ($, on) => {
  const world = engine(on, { files: { ...SETTINGS }, remote: 'git@github.com:a/b.git', mcp: ANSWER, store: { [storeKey('/r')]: LINES.slice(1) } })
  await $.session.start(START)
  await $.command.run(cmd(''))
  expect(world.mcpCalls).toEqual([])
})

test('the panel reads the queue through the engine, never at session start', async ($, on) => {
  const world = engine(on, { files: { ...SETTINGS }, remote: 'git@github.com:a/b.git', mcp: ANSWER, store: { [storeKey('/r')]: LINES } })
  await $.session.start(START)
  expect(world.mcpCalls).toEqual([])
  await $.command.run(cmd(''))
  expect(await paneText($, 80)).toContain('QUEUE  1 item with the mark')
  expect(world.mcpCalls).toEqual([
    ['tasks', 'find_tasks', { label: 'factory', states: ['open'] }],
    ['tasks', 'find_tasks', { label: 'factory', states: ['started'] }],
  ])
})

test('the panel says when the MCP server is not connected', async ($, on) => {
  const world = engine(on, { files: { ...SETTINGS }, remote: 'git@github.com:a/b.git', store: { [storeKey('/r')]: LINES } })
  await $.session.start(START)
  await $.command.run(cmd(''))
  // The list failed: the claimed items are not asked.
  expect(world.mcpCalls.length).toBe(1)
  expect((await paneText($, 200)).some(row => row.includes(NO_SERVER('tasks')))).toBe(true)
})

test('a server that hangs is cut off by the time limit', async ($, on) => {
  const world = engine(on, { files: { ...SETTINGS }, remote: 'git@github.com:a/b.git', store: { [storeKey('/r')]: LINES }, mcp: () => new Promise(() => undefined) })
  await $.session.start(START)
  const opened = $.command.run(cmd(''))
  for (let i = 0; i < 10; i++) await world.clock.advance(2_000)
  await opened
  expect((await paneText($, 200)).some(row => row.includes('The MCP server tasks did not answer in time.'))).toBe(true)
})
