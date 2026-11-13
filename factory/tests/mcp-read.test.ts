import { expect, test } from 'claude-code/testing'

import { at, commentsOf, dataOf, errorOf, fill, isItemId, itemOf, itemProblem, labelsAfter, listedOf, parseMcpTracker } from '../core/mcp-tracker'
import type { McpResult, McpTracker, ReadSpec } from '../core/mcp-tracker'

import { GOOD } from './mcp-good'

const READ: ReadSpec = (parseMcpTracker(GOOD) as { ok: McpTracker }).ok.read
const URL_T = 'https://tracker.example.com/tasks/{id}'
const text = (t: string, isError = false): McpResult => ({ content: [{ type: 'text', text: t }], isError })

test('isItemId', () => {
  expect(isItemId('PROJ-12')).toBe(true)
  expect(isItemId('a#1.b_c')).toBe(true)
  for (const bad of ['', '-x', 'a b', 'a'.repeat(41), '.a']) expect(isItemId(bad)).toBe(false)
  expect(isItemId('a'.repeat(40))).toBe(true)
})

// The line keeps 40 characters of an id: a longer one would be cut, and its writes would go to another item.
test('an id over 40 characters is no item and is never sent', () => {
  const spec = { tool: 't', args: {}, rows: 'tasks', id: 'id', title: 'title', state: null }
  const long = 'A-' + '1'.repeat(39)
  expect(long.length).toBe(41)
  expect(listedOf({ tasks: [{ id: long, title: 'x' }, { id: long.slice(0, 40), title: 'y' }] }, spec)).toEqual([{ id: long.slice(0, 40), title: 'y', state: '' }])
  expect(fill({ k: '{id}' }, { mark: 'm', id: long })).toBe(null)
  expect(fill({ k: 'key = {id}' }, { mark: 'm', id: long })).toBe(null)
  expect(fill({ k: '{id}' }, { mark: 'm', id: long.slice(0, 40) })).toEqual({ k: long.slice(0, 40) })
})

test('fill: a lone placeholder keeps its type; mark and id go inside a text', () => {
  expect(
    fill(
      { k: '{id}', q: 'label = "{mark}" and key = {id}', n: 3, l: '{labels}', deep: [{ s: '{state}' }] },
      { mark: 'factory', id: 'PROJ-12', labels: ['a', 'b'], state: 'done' },
    ),
  ).toEqual({ k: 'PROJ-12', q: 'label = "factory" and key = PROJ-12', n: 3, l: ['a', 'b'], deep: [{ s: 'done' }] })
})

test('fill: outside text is sent as it is, and is never read again', () => {
  expect(fill({ text: '{text}' }, { mark: 'm', id: 'A-1', text: 'see {id} and {mark} and {labels}' })).toEqual({
    text: 'see {id} and {mark} and {labels}',
  })
  // a mark that holds a placeholder is put in once
  expect(fill({ q: '{mark} {id}' }, { mark: '{id}', id: 'A-1' })).toEqual({ q: '{id} A-1' })
})

test('fill: a placeholder is lower case only', () => {
  expect(fill({ a: '{ID}', b: 'x {Mark}' }, { mark: 'm', id: 'A-1' })).toEqual({ a: '{ID}', b: 'x {Mark}' })
})

test('fill: nothing is sent when a value is missing or breaks its rule', () => {
  expect(fill({ k: '{id}' }, { mark: 'm' })).toBe(null)
  expect(fill({ k: '{id}' }, { mark: 'm', id: 'a b' })).toBe(null)
  expect(fill({ k: '{id}' }, { mark: 'm', id: '-x' })).toBe(null)
  expect(fill({ k: 'x {id}' }, { mark: 'm', id: 'a b' })).toBe(null)
  expect(fill({ k: '{url}' }, { mark: 'm', url: 'javascript:1' })).toBe(null)
  expect(fill({ k: '{url}' }, { mark: 'm', url: 'https://a b' })).toBe(null)
  expect(fill({ k: '{url}' }, { mark: 'm', url: 'https://x.example.com/' + 'a'.repeat(2000) })).toBe(null)
  expect(fill({ k: '{url}' }, { mark: 'm', url: 'https://x.example.com/1' })).toEqual({ k: 'https://x.example.com/1' })
  expect(fill({ k: '{state}' }, { mark: 'm' })).toBe(null)
  expect(fill({ k: '{labels}' }, { mark: 'm' })).toBe(null)
  expect(fill({ k: '{text}' }, { mark: 'm' })).toBe(null)
  expect(fill({ k: 'a {state}' }, { mark: 'm' })).toBe(null)
})

test('fill: the input is never changed', () => {
  const args = Object.freeze({ k: Object.freeze(['{id}']), o: Object.freeze({ m: '{mark}' }) }) as { [key: string]: any }
  const out = fill(args, { mark: 'm', id: 'A-1' })
  expect(out).toEqual({ k: ['A-1'], o: { m: 'm' } })
  expect(args.k).toEqual(['{id}'])
  expect(out).not.toBe(args)
})

test('the data of an answer', () => {
  expect(dataOf(text('{"a":1}'))).toEqual({ a: 1 })
  expect(dataOf({ content: [{ type: 'text', text: '{"a":1}' }], isError: false, structuredContent: { b: 2 } })).toEqual({ b: 2 })
  expect(dataOf({ content: [{ type: 'text', text: '[1]' }], isError: false, structuredContent: [9] as unknown })).toEqual([1])
  expect(dataOf({ content: [{ type: 'image' }, { type: 'text', text: '{"a":1}' }], isError: false })).toEqual({ a: 1 })
  for (const bad of [
    text('Done.'),
    { content: [], isError: false },
    text('{"a":1}', true),
    { failed: 'timeout' as const, why: 'x' },
    text('"' + 'x'.repeat(1_048_577) + '"'),
    text('null'),
    { content: [{ type: 'text', text: 'Done.' }, { type: 'text', text: '{"a":1}' }], isError: false },
    { content: [{ type: 'text', text: '{"a":1}' }], isError: true, structuredContent: { b: 2 } },
  ])
    expect(dataOf(bad as McpResult)).toBe(undefined)
})

test('a write is judged by isError alone', () => {
  expect(errorOf('add_comment', text('Done.'))).toBe(null)
  expect(errorOf('move_task', text('Tick every point first.\nmore\u001b[2J', true))).toBe('move_task: Tick every point first.')
  expect(errorOf('move_task', text('\n\nsecond\nthird', true))).toBe('move_task: second')
  expect(errorOf('move_task', { content: [], isError: true })).toBe('move_task: failed')
  expect(errorOf('move_task', text('', true))).toBe('move_task: failed')
  expect(errorOf('x', { failed: 'timeout', why: 'no answer in time' })).toBe('x: no answer in time')
  expect(errorOf('x', text('e'.repeat(500), true))?.length).toBe(200)
  expect(errorOf('x', { failed: 'other', why: 'e'.repeat(500) })?.length).toBe(200)
})

test('at: a dotted name, and nothing else', () => {
  const data = { fields: { summary: 'S', list: [{ a: 1 }] }, 'a.b': 1 }
  expect(at(data, 'fields.summary')).toBe('S')
  for (const path of ['fields.none', 'fields.list.a', 'fields.summary.length', '__proto__', 'constructor.name', 'a.b', '']) {
    expect(at(data, path)).toBe(undefined)
  }
  expect(at(JSON.parse('{"__proto__":{"x":1}}'), '__proto__.x')).toBe(undefined)
  expect(at([1], 'length')).toBe(undefined)
  expect(at(null, 'a')).toBe(undefined)
})

test('a list: ids as text or whole numbers; a bad row is no item; 200 rows', () => {
  const spec = { tool: 't', args: {}, rows: 'tasks', id: 'id', title: 'title', state: 'state' }
  expect(
    listedOf(
      { tasks: [{ id: 'PROJ-12', title: 'A', state: 'Open' }, { id: 7, title: 'B' }, { id: 1.5, title: 'x' }, { id: 'a b', title: 'x' }, { id: 'N-1' }, { id: 'N-2', title: 5 }, 'row'] },
      spec,
    ),
  ).toEqual([{ id: 'PROJ-12', title: 'A', state: 'open' }, { id: '7', title: 'B', state: '' }])
  expect(listedOf({ tasks: 'no' }, spec)).toBe(null)
  expect(listedOf({}, spec)).toBe(null)
  expect(listedOf({ tasks: [] }, spec)).toEqual([])
  expect(listedOf([{ id: 'A-1', title: 'A' }], { ...spec, rows: null })?.length).toBe(1)
  expect(listedOf({ a: 1 }, { ...spec, rows: null })).toBe(null)
  expect(listedOf({ tasks: Array.from({ length: 300 }, (_, i) => ({ id: `A-${i}`, title: 'x' })) }, spec)?.length).toBe(200)
  expect(listedOf({ tasks: [{ id: 'A-1', title: 'x'.repeat(400) }] }, spec)?.[0]?.title.length).toBe(300)
})

const DATA = {
  made_by: 'Ann Lee',
  title: 'T',
  description: 'D',
  state: 'Open',
  labels: ['Factory', 'bug'],
  comments: [{ by: 'Bo', text: 'hi' }, { by: 5, text: 'x' }, { by: 'C' }],
}
const data = (more: Record<string, unknown> = {}): Record<string, unknown> => ({ ...DATA, ...more })

test('an item: its fields, its labels, its address', () => {
  expect(itemOf(data(), READ, 'PROJ-12', URL_T)).toEqual({
    item: {
      id: 'PROJ-12',
      title: 'T',
      state: 'open',
      text: 'D',
      author: 'ann lee',
      url: 'https://tracker.example.com/tasks/PROJ-12',
      comments: [{ author: 'bo', text: 'hi' }],
    },
    labels: ['Factory', 'bug'],
  })
  expect(itemOf(data({ labels: [{ name: 'x' }, 'y'] }), READ, 'A-1', null)?.labels).toEqual(['x', 'y'])
  expect(itemOf(data({ labels: [] }), READ, 'A-1', null)?.labels).toEqual([])
  // One entry that cannot be read: the list is not known, so it is never written back.
  for (const labels of [[{ name: 'x' }, { name: 2 }, 'y'], [12, 15], [{ id: 1, title: 'bug' }], ['x', null]]) {
    const read = itemOf(data({ labels }), READ, 'A-1', null)
    expect([read?.item.title, read?.labels]).toEqual(['T', null])
  }
  expect(itemOf(data({ labels: 'no' }), READ, 'A-1', null)?.labels).toBe(null)
  expect(itemOf(data(), { ...READ, labels: null }, 'A-1', null)?.labels).toBe(null)
})

test('an item: the address', () => {
  const spec = { ...READ, url: 'web_url' }
  expect(itemOf(data({ web_url: 'https://t.example.com/1' }), spec, 'A-1', URL_T)?.item.url).toBe('https://t.example.com/1')
  expect(itemOf(data({ web_url: 'ftp://x' }), spec, 'A-1', URL_T)?.item.url).toBe('https://tracker.example.com/tasks/A-1')
  expect(itemOf(data({ web_url: 'ftp://x' }), spec, 'A-1', null)?.item.url).toBe('')
  expect(itemOf(data(), READ, 'A-1', null)?.item.url).toBe('')
})

test('an item: limits and what is missing', () => {
  expect(itemOf(data({ title: 'x'.repeat(400) }), READ, 'A-1', null)?.item.title.length).toBe(300)
  expect(itemOf(data({ description: 'x'.repeat(30_000) }), READ, 'A-1', null)?.item.text.length).toBe(20_000)
  const many = Array.from({ length: 60 }, () => ({ by: 'A', text: 'x' }))
  expect(itemOf(data({ comments: many }), READ, 'A-1', null)?.item.comments.length).toBe(50)
  expect(itemOf(data({ comments: [{ by: 'A', text: 'x'.repeat(6000) }] }), READ, 'A-1', null)?.item.comments[0]?.text.length).toBe(5000)
  expect(itemOf(data({ title: undefined }), READ, 'A-1', null)).toBe(null)
  expect(itemOf(data({ title: 5 }), READ, 'A-1', null)).toBe(null)
  expect(itemOf(data({ description: undefined }), READ, 'A-1', null)?.item.text).toBe('')
  expect(itemOf(data({ comments: 'no' }), READ, 'A-1', null)).toBe(null)
  expect(itemOf(data({ comments: undefined }), READ, 'A-1', null)).toBe(null)
  expect(itemOf(data(), { ...READ, comments: null, commentAuthor: null, commentText: null }, 'A-1', null)?.item.comments).toEqual([])
  expect(itemOf('no', READ, 'A-1', null)).toBe(null)
})

test('comments', () => {
  expect(commentsOf({ c: [{ a: 'Bo', t: 'x' }, { a: 1, t: 'x' }] }, 'c', 'a', 't')).toEqual([{ author: 'bo', text: 'x' }])
  expect(commentsOf([], null, 'a', 't')).toEqual([])
  expect(commentsOf({ c: 1 }, 'c', 'a', 't')).toBe(null)
  expect(commentsOf({}, null, 'a', 't')).toBe(null)
})

test('labelsAfter: the four state labels go, the new one comes, the rest stays', () => {
  expect(labelsAfter(['bug', 'factory', 'Factory:In-Progress'], 'factory', 'done', null)).toEqual(['bug', 'factory', 'factory:done'])
  expect(
    labelsAfter(['factory', 'f-doing'], 'factory', 'rejected', { 'in-progress': 'f-doing', 'needs-human': 'f-ask', done: 'f-done', rejected: 'f-no' }),
  ).toEqual(['factory', 'f-no'])
  expect(labelsAfter(['FACTORY:DONE', 'x'], 'factory', 'done', null)).toEqual(['x', 'factory:done'])
})

test('an item with a half-set comment trio is not read', () => {
  expect(itemOf(data(), { ...READ, commentAuthor: null }, 'A-1', null)).toBe(null)
  expect(itemOf(data(), { ...READ, commentText: null }, 'A-1', null)).toBe(null)
  expect(itemOf(data(), { ...READ, comments: null, commentAuthor: null, commentText: null }, 'A-1', null)?.item.comments).toEqual([])
})

test('at: a name over 200 characters is not there', () => {
  const long = 'a'.repeat(201)
  expect(at({ [long]: 1 }, long)).toBe(undefined)
  expect(at({ ['a'.repeat(200)]: 1 }, 'a'.repeat(200))).toBe(1)
})

test('at checks its own path', () => {
  const x = { a: { b: 1 }, 'a-b': 1, '': 1 }
  for (const p of ['a-b', 'a..b', '', 'a.b.c.d.e.f.g', 'a.__proto__']) expect(at(x, p)).toBe(undefined)
  expect(at(x, 'a.b')).toBe(1)
})

test('an answer whose shape is wrong is no answer, not a crash', () => {
  for (const content of ['x', [null, 5, { type: 'text' }]]) {
    const r = { content, isError: true } as never
    expect(errorOf('t', r)).toBe('t: failed')
    expect(dataOf({ content, isError: false } as never)).toBe(undefined)
  }
})

test('an error text is cut early and never in half of an emoji', () => {
  const t0 = Date.now()
  expect(errorOf('t', text('e'.repeat(2_000_000), true))?.length).toBe(200)
  expect(Date.now() - t0).toBeLessThan(500)
  expect(errorOf('x', text('a'.repeat(196) + '😀tail', true))).toBe('x: ' + 'a'.repeat(196))
})

// An address is printable ASCII only: no control character and no character that only hides (a bidi mark, a zero-width space).
test('an address with a character that is not printable ASCII is no address', () => {
  for (const url of ['https://x.example.com/\u202e1', 'https://x.example.com/\u200b1', 'https://x.example.com/\u00a01', 'https://x.example.com/\u00e9']) {
    expect(fill({ k: '{url}' }, { mark: 'm', url })).toBe(null)
    expect(itemOf(data({ web_url: url }), { ...READ, url: 'web_url' }, 'A-1', URL_T)?.item.url).toBe('https://tracker.example.com/tasks/A-1')
  }
  expect(itemOf(data({ web_url: 'https://x.example.com/~a?b=1#c' }), { ...READ, url: 'web_url' }, 'A-1', URL_T)?.item.url).toBe('https://x.example.com/~a?b=1#c')
})

test('fill: text and url never stand inside a longer text', () => {
  expect(fill({ k: 'x {text}' }, { mark: 'm', text: 't' })).toBe(null)
  expect(fill({ k: 'see {url}' }, { mark: 'm', url: 'https://a.example/1' })).toBe(null)
})

test('itemProblem: why an answer is no item, in fixed words', () => {
  expect(itemProblem(data(), READ)).toBe(null)
  expect(itemProblem(data({ title: undefined }), READ)).toBe('title not there')
  expect(itemProblem(data({ title: '' }), READ)).toBe('title not there')
  expect(itemProblem(data({ title: 5 }), READ)).toBe('title not there')
  expect(itemProblem('no', READ)).toBe('title not there')
  expect(itemProblem(data({ comments: 'no' }), READ)).toBe('no list of comments')
  expect(itemProblem(data({ comments: 'no' }), { ...READ, comments: null, commentAuthor: null, commentText: null })).toBe(null)
  for (const d of [data(), data({ title: undefined }), data({ comments: 'no' }), 'no']) expect(itemProblem(d, READ) === null).toBe(itemOf(d, READ, 'A-1', null) !== null)
})
