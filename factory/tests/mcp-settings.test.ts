import { expect, test } from 'claude-code/testing'

import { mcpLines, parseMcpTracker } from '../core/mcp-tracker'
import type { McpTracker } from '../core/mcp-tracker'
import { CONTROL_CHAR } from '../core/rules'

import { GOOD, step } from './mcp-good'

const with_ = (change: Record<string, unknown>): Record<string, unknown> => ({ ...GOOD, ...change })
const reason = (v: Record<string, unknown>): string => {
  const r = parseMcpTracker(v)
  if (!('no' in r)) throw new Error('was not refused')

  return r.no
}
const good = (): McpTracker => (parseMcpTracker(GOOD) as { ok: McpTracker }).ok

test('the example of the design parses', async () => {
  const { ok } = parseMcpTracker(GOOD) as { ok: McpTracker }
  expect(ok.server).toBe('tasks')
  expect(ok.url).toBe('https://tracker.example.com/tasks/{id}')
  expect(ok.list).toEqual({ tool: 'find_tasks', args: { label: '{mark}', states: ['open'] }, rows: 'tasks', id: 'id', title: 'title', state: 'state' })
  expect(ok.states).toEqual({
    as: 'calls',
    steps: {
      'in-progress': [{ tool: 'move_task', args: { task_id: '{id}', to: 'started' }, optional: false }],
      'needs-human': [{ tool: 'move_task', args: { task_id: '{id}', to: 'waiting' }, optional: true }],
      done: [{ tool: 'move_task', args: { task_id: '{id}', to: 'closed' }, optional: false }],
      rejected: [{ tool: 'cancel_task', args: { task_id: '{id}' }, optional: false }],
    },
  })
  expect(ok.me).toEqual({ tool: 'who_am_i', args: {}, name: 'name' })
  expect(ok.read.commentAuthor).toBe('by')
  expect(ok.comments).toBe(null)
  expect(ok.linkPr).toEqual({ tool: 'attach_link', args: { task_id: '{id}', ref: '{url}' } })
})

test('the keys that are optional may be left out', async () => {
  const { ok } = parseMcpTracker({
    kind: 'mcp',
    server: 'tasks',
    list: { tool: 'find', id: 'id', title: 'title' },
    read: { tool: 'get', title: 'title', text: 'body' },
    comment: { tool: 'add', args: { text: '{text}' } },
    states: { done: [{ tool: 'close', args: { id: '{id}' } }] },
  }) as { ok: McpTracker }
  expect(ok.url).toBe(null)
  expect(ok.claimed).toBe(null)
  expect(ok.me).toBe(null)
  expect(ok.linkPr).toBe(null)
  expect(ok.list).toEqual({ tool: 'find', args: {}, rows: null, id: 'id', title: 'title', state: null })
  expect(ok.states).toEqual({ as: 'calls', steps: { done: [{ tool: 'close', args: { id: '{id}' }, optional: false }] } })
})

test('the labels form of states', async () => {
  const labels = { tool: 'edit_item', args: { key: '{id}', fields: { labels: '{labels}' } } }
  const { ok } = parseMcpTracker(with_({ states: { labels } })) as { ok: McpTracker }
  expect(ok.states).toEqual({ as: 'labels', write: labels, names: null })

  const names = { 'in-progress': 'factory-doing', 'needs-human': 'factory-help', done: 'factory-done', rejected: 'factory-no' }
  const named = parseMcpTracker(with_({ states: { labels: { ...labels, names } } })) as { ok: McpTracker }
  expect(named.ok.states).toEqual({ as: 'labels', write: labels, names })

  const three = { ...names, rejected: undefined }
  expect(reason(with_({ states: { labels: { ...labels, names: three } } }))).toContain('states.labels.names')
  expect(reason(with_({ states: { labels: { ...labels, names: { ...names, done: 'a\nb' } } } }))).toContain('states.labels.names')
  expect(reason(with_({ states: { labels } , read: { ...GOOD.read, labels: undefined } }))).toContain('read.labels')
  expect(reason(with_({ states: { labels, done: [step('closed')] } }))).toContain('states')
})

test('what is refused, each with a reason that names the key', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ server: undefined }, 'server'],
    [with_({ server: 'factory' }), 'server'],
    [with_({ server: 'Factory' }), 'server'],
    [with_({ server: 'plugin:factory:x' }), 'server'],
    [with_({ server: 'PLUGIN:Factory' }), 'server'],
    [with_({ server: 'a\nb' }), 'server'],
    [with_({ server: 'factory ' }), 'server'],
    [with_({ server: 'Factory.' }), 'server'],
    [with_({ server: 'factory-' }), 'server'],
    [with_({ server: 'factory_' }), 'server'],
    [with_({ server: 'FACTORY' }), 'server'],
    [with_({ server: 'f.a.c.t.o.r.y' }), 'server'],
    [with_({ server: 'Plugin_Factory' }), 'server'],
    [with_({ list: { ...GOOD.list, tool: 'find_tasks ' } }), 'list.tool'],
    [with_({ list: { ...GOOD.list, id: 'a.__proto__' } }), 'list.id'],
    [with_({ list: { ...GOOD.list, id: 'constructor' } }), 'list.id'],
    [with_({ read: { ...GOOD.read, text: 'a.prototype.b' } }), 'read.text'],
    [with_({ server: 'a'.repeat(101) }), 'server'],
    [with_({ server: '-a' }), 'server'],
    [with_({ list: { ...GOOD.list, tool: 'a\u0007b' } }), 'list.tool'],
    [with_({ list: { ...GOOD.list, tool: 'a'.repeat(101) } }), 'list.tool'],
    [with_({ list: { ...GOOD.list, tool: '{id}' } }), 'list.tool'],
    [with_({ linkPR: GOOD.linkPr }), 'linkPR'],
    [with_({ list: { ...GOOD.list, id: undefined } }), 'list.id'],
    [with_({ list: { ...GOOD.list, extra: 'x' } }), 'list.extra'],
    [with_({ read: { ...GOOD.read, title: undefined } }), 'read.title'],
    [with_({ read: { ...GOOD.read, text: undefined } }), 'read.text'],
    [with_({ list: undefined }), 'list'],
    [with_({ comment: undefined }), 'comment'],
    [with_({ states: undefined }), 'states'],
    [with_({ list: { ...GOOD.list, id: 'a.b.c.d.e.f.g' } }), 'list.id'],
    [with_({ list: { ...GOOD.list, id: 'a..b' } }), 'list.id'],
    [with_({ list: { ...GOOD.list, id: 'a[0]' } }), 'list.id'],
    [with_({ list: { ...GOOD.list, id: 'a.*' } }), 'list.id'],
    [with_({ list: { ...GOOD.list, rows: '' } }), 'list.rows'],
    [with_({ read: { ...GOOD.read, labels: 5 } }), 'read.labels'],
    [with_({ me: { tool: 'who', args: {} } }), 'me.name'],
    [with_({ list: { ...GOOD.list, args: { q: 'x'.repeat(1000) } } }), 'list.args'],
    [with_({ list: { ...GOOD.list, args: { a: { b: { c: { d: { e: 1 } } } } } } }), 'list.args'],
    [with_({ list: { ...GOOD.list, args: ['x'] } }), 'list.args'],
    [with_({ list: { ...GOOD.list, args: { a: Number.POSITIVE_INFINITY } } }), 'list.args'],
    [with_({ list: { ...GOOD.list, args: { a: 'x\u0007' } } }), 'list.args'],
    [with_({ list: { ...GOOD.list, args: { a: '{nope}' } } }), 'list.args'],
    [with_({ list: { ...GOOD.list, args: { a: '{text}' } } }), 'list.args'],
    [with_({ list: { ...GOOD.list, args: { a: '{id}' } } }), 'list.args'],
    [with_({ comment: { tool: 'add', args: { text: 're: {text}' } } }), 'comment.args'],
    [with_({ comment: { tool: 'add', args: { text: '{url}' } } }), 'comment.args'],
    [with_({ read: { ...GOOD.read, args: { a: '{url}' } } }), 'read.args'],
    [with_({ read: { ...GOOD.read, args: { a: '{labels}' } } }), 'read.args'],
    [with_({ read: { ...GOOD.read, args: { a: '{state}' } } }), 'read.args'],
    [with_({ states: { done: [{ tool: 'x', args: { a: '{text}' } }] } }), 'states.done'],
    [with_({ states: { done: [{ tool: 'x', args: { a: '{labels}' } }] } }), 'states.done'],
    [with_({ linkPr: { tool: 'x', args: { a: 'see {url}' } } }), 'linkPr.args'],
    [with_({ comment: { tool: 'add', args: { '{id}': 1 } } }), 'comment.args'],
    [with_({ comment: { tool: 'add', args: { a: { '{mark}': 1 } } } }), 'comment.args'],
    [with_({ states: { done: [1, 2, 3, 4, 5].map(() => step('x')) } }), 'states.done'],
    [with_({ states: { done: [] } }), 'states.done'],
    [with_({ states: { finished: [step('x')] } }), 'states.finished'],
    [with_({ states: { done: [{ ...step('x'), optional: 'yes' }] } }), 'states.done'],
    [with_({ url: 'https://tracker.example.com/tasks' }), 'url'],
    [with_({ url: 'http://tracker.example.com/{id}' }), 'url'],
    [with_({ url: 'https://tracker.example.com/{id}/{id}' }), 'url'],
    [with_({ url: 'https://tracker.example.com/{id}/{mark}' }), 'url'],
    [with_({ url: 'https://tracker.example.com/{id}\n' }), 'url'],
    [with_({ url: 'https://tracker.example.com/a b/{id}' }), 'url'],
    [with_({ url: 'https://t.example.com/' + 'a'.repeat(300) + '{id}' }), 'url'],
    [with_({ comments: { tool: 'c', args: {}, author: 'by' } }), 'comments.text'],
  ]
  for (const [settings, key] of cases) {
    const r = parseMcpTracker(settings)
    const no = 'no' in r ? r.no : `NOT REFUSED ${key} ${JSON.stringify(settings).slice(-150)}`
    expect(no.startsWith('NOT REFUSED') ? no : '').toBe('')
    expect(no.length).toBeLessThan(160)
    expect(no).toContain(key)
  }
})

test('placeholders where they may stand', async () => {
  const ok = (change: Record<string, unknown>) => expect('ok' in parseMcpTracker(with_(change))).toBe(true)
  ok({ comment: { tool: 'add', args: { text: '{text}', note: 'by {mark} on {id}' } } })
  ok({ states: { done: [{ tool: 'x', args: { id: '{id}', s: 'now {state} for {mark}' } }] } })
  ok({ list: { ...GOOD.list, args: { n: 5, flag: true, none: null, q: 'label = {mark} and x' } } })
  ok({ comments: { tool: 'c', args: { id: '{id}' }, rows: 'items', author: 'by', text: 'body' } })
})

test('the lines: one for each call, whole, in a fixed form', async () => {
  const ok = good()
  const lines = mcpLines(ok, 'factory')
  expect(lines).toContain('[tracker] mcp tasks · list: find_tasks {"label":"{mark}","states":["open"]} → rows=tasks id=id title=title state=state')
  expect(lines).toContain('[tracker] mcp tasks · state in-progress 1/1: move_task {"task_id":"{id}","to":"started"}')
  expect(lines).toContain('[tracker] mcp tasks · state needs-human 1/1 (optional): move_task {"task_id":"{id}","to":"waiting"}')
  expect(lines).toContain('[tracker] mcp tasks · url: https://tracker.example.com/tasks/{id}')
  expect(lines).toContain('[tracker] mcp tasks · me: who_am_i {} → name=name')
  expect(lines.length).toBe(12)
  expect(new Set(lines).size).toBe(12)
  expect(lines).toContain('[tracker] mcp tasks · mark: factory')
  expect(lines.every(line => !CONTROL_CHAR.test(line))).toBe(true)

  // A key's order is not a change; every other change gives another line.
  expect(mcpLines({ ...ok, list: { ...ok.list, args: { states: ['open'], label: '{mark}' } } }, 'factory')).toEqual(lines)
  const other = [
    { ...ok, list: { ...ok.list, id: 'key' } },
    { ...ok, list: { ...ok.list, tool: 'other' } },
    { ...ok, list: { ...ok.list, args: { label: '{mark}', states: ['closed'] } } },
    { ...ok, server: 'other' },
    { ...ok, url: 'https://tracker.example.com/t/{id}' },
    { ...ok, read: { ...ok.read, text: 'body' } },
    { ...ok, states: { as: 'calls' as const, steps: { ...(ok.states as { steps: object }).steps, 'needs-human': [{ tool: 'move_task', args: { task_id: '{id}', to: 'waiting' }, optional: false }] } } },
  ]
  expect(mcpLines(ok, 'factory OR labels is not EMPTY')).not.toEqual(lines)
  expect(mcpLines(ok, 'other').filter(l => !lines.includes(l))).toEqual(['[tracker] mcp tasks · mark: other'])
  for (const changed of other) expect(mcpLines(changed as McpTracker, 'factory')).not.toEqual(lines)
})

test('the lines of the other forms', async () => {
  const labels = { tool: 'edit_item', args: { key: '{id}', fields: { labels: '{labels}' } } }
  const names = { 'in-progress': 'f-doing', 'needs-human': 'f-help', done: 'f-done', rejected: 'f-no' }
  const plain = (parseMcpTracker(with_({ states: { labels } })) as { ok: McpTracker }).ok
  const named = (parseMcpTracker(with_({ states: { labels: { ...labels, names } } })) as { ok: McpTracker }).ok
  expect(mcpLines(plain, 'factory')).toContain('[tracker] mcp tasks · states as labels: edit_item {"fields":{"labels":"{labels}"},"key":"{id}"}')
  expect(mcpLines(named, 'factory')).toContain('[tracker] mcp tasks · states as labels: edit_item {"fields":{"labels":"{labels}"},"key":"{id}"} → in-progress=f-doing needs-human=f-help done=f-done rejected=f-no')
  expect(mcpLines(plain, 'factory').length).toBe(9)

  const second = (parseMcpTracker(with_({ comments: { tool: 'c', args: { id: '{id}' }, rows: 'items', author: 'by', text: 'body' } })) as { ok: McpTracker }).ok
  expect(mcpLines(second, 'factory')).toContain('[tracker] mcp tasks · comments: c {"id":"{id}"} → rows=items author=by text=body')

  const steps = { 'in-progress': [step('a'), step('b')] }
  const two = (parseMcpTracker(with_({ states: steps })) as { ok: McpTracker }).ok
  expect(mcpLines(two, 'factory').filter(l => l.includes('state in-progress'))).toEqual([
    '[tracker] mcp tasks · state in-progress 1/2: move_task {"task_id":"{id}","to":"a"}',
    '[tracker] mcp tasks · state in-progress 2/2: move_task {"task_id":"{id}","to":"b"}',
  ])
})

test('a character that hides in a line is shown as an escape', async () => {
  const hidden = (parseMcpTracker(with_({ comment: { tool: 'add', args: { text: '{text}', note: 'a\u202eb\u2028c' } } })) as { ok: McpTracker }).ok
  const line = mcpLines(hidden, 'factory').find(l => l.includes('· comment:')) ?? ''
  expect(line).toContain('a\\u202eb\\u2028c')
  expect(/[^\x20-\x7e]/.test(line.replace('·', ''))).toBe(false)
})

test('a server that is close to the plugin itself is refused, a different one is not', async () => {
  for (const server of ['tasks', 'factory-tasks']) expect('ok' in parseMcpTracker(with_({ server }))).toBe(true)
})

test('the three comment keys of read go together', async () => {
  for (const drop of [['commentAuthor'], ['commentText'], ['comments'], ['commentAuthor', 'commentText'], ['comments', 'commentText']]) {
    const read = { ...GOOD.read }
    for (const k of drop) delete read[k]
    const why = reason(with_({ read }))
    expect(why).toContain('read')
    expect(why).toContain('together')
  }
  const none = { ...GOOD.read }
  for (const k of ['comments', 'commentAuthor', 'commentText']) delete none[k]
  expect('ok' in parseMcpTracker(with_({ read: none }))).toBe(true)
})

// A key of the settings file echoed in a reason is cut and cleaned: the reason is shown in the pane.
test('a key named in a reason is cut to 40 characters and holds no control character', async () => {
  const key = '\u001b[2J' + 'k'.repeat(100)
  for (const v of [{ ...GOOD, [key]: 1 }, with_({ list: { ...GOOD.list, [key]: 1 } }), with_({ states: { [key]: [step('x')] } })]) {
    const no = reason(v)
    expect(no.includes('k'.repeat(41))).toBe(false)
    expect(no.includes('k'.repeat(37))).toBe(true)
    expect(CONTROL_CHAR.test(no)).toBe(false)
    expect(no.includes('\u001b')).toBe(false)
  }
})
