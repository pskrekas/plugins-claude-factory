# Phase 4: a tracker through its MCP server: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tracker.kind: "mcp"`: the factory works with any tracker whose MCP server the person connected, from the settings file alone, and calls no tool that the person did not approve.

**Architecture:** A pure part (`core/mcp-tracker.ts`) holds every rule: it parses the settings, builds the approval lines, fills placeholders and reads fields from an answer. A thin adapter (`adapters/mcp-tracker.ts`) is the `Tracker` contract on top of it and one `call` closure. `Io.mcp` wraps `$.mcp.call`; `adaptersOf` gives the adapter only when every line of it is approved.

**Tech Stack:** TypeScript, the Claude Code mod API (`claude-code`, `claude-code/testing`). Run from the repo top: `claude plugin test factory` and `claude plugin validate factory`.

**Spec:** `docs/superpowers/specs/2026-11-13-phase-4-mcp-tracker-design.md` (read it whole first; "6.x" below names its sections).

## Global Constraints

- Public repo: no name of the owner's own tracker, company or people, in code, tests, documents or commit texts. Sample names only: `PROJ-12`, `tracker.example.com`, server `tasks`.
- `$` is used only as `$.noun.method(...)` inside a hook; everything else takes an `Io`.
- A command's answer (`{ text }`) reaches the session's model: it holds counts, ids that passed the id rule, and cut error texts. Never a title, a text, an author or a line of the settings.
- No tool is called while one approval line of the tracker is not in the store: not a write, not a read, not the panel's queue.
- Outside text (`{text}`, `{url}`) is only ever a whole JSON value. `{mark}` and `{id}` pass their rule before use. A placeholder is never read in a key, in `tool` or in `server`.
- A value that is not text where text is expected is "not there", never `String(value)`. Everything fails closed.
- Limits: `args` of one action ≤ 1,000 characters as JSON and ≤ 4 levels deep; ≤ 4 steps per state; a field name has 1 to 6 parts of `[A-Za-z0-9_]+`; `server` and `tool` match `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$`; an id matches `^[A-Za-z0-9][A-Za-z0-9_.#-]{0,39}$` (40 characters at most); an answer ≤ 1 MB; a queue is the first 200 rows; 50 comments of 5,000 characters; an item's text 20,000; a title 300; an author 200, in lower case.
- Commits: one per task at least, message style of the repo (`feat:`, `fix:`, `docs:`, `test:`), ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Never push.
- After every task: `claude plugin test factory` shows 0 fail and `claude plugin validate factory` passes.

## Review Focus

1. **The server is not connected, or asks for a sign-in.** The panel shows `The MCP server <name> did not answer. Connect it with /mcp.` and `/factory run` does not start. (Task 4)
2. **The settings change after the approval** (one argument of one action). No call at all runs, the panel's queue included, until the new line is approved. (Task 4)
3. **A write answers a plain sentence, not JSON.** The write passed: `isError` alone decides. (Tasks 3, 4)
4. **Outside text that looks like a placeholder** (a comment with `{id}` or `{mark}` in it). It is sent as it is: a value is filled once, never read again. (Task 3)
5. **Shapes of real answers**: an id that is a JSON number; labels as `[{ "name": "x" }]`; the mark in another case (`Factory`); a row with no title. The first three work, the last is no item. (Task 3)

---

## File structure

| File | Responsibility |
|---|---|
| `factory/core/mcp-tracker.ts` (new) | Types; `parseMcpTracker`; `mcpLines`; `fill`; reading an answer. Pure. |
| `factory/adapters/mcp-tracker.ts` (new) | `mcpTracker(call, spec, mark, forbidden): Tracker`. |
| `factory/adapters/tracker.ts` | `kind` gains `'mcp'`; `scan` gains `note`. |
| `factory/core/settings.ts` | `TrackerKind`; `tracker()` reads the `mcp` keys; `commandsOf` adds the lines. |
| `factory/hooks/io.ts`, `factory/hooks/register.tsx`, `factory/tests/kit.ts` | `Io.mcp`, real and fake. |
| `factory/hooks/adapters.ts` | Chooses the adapter; refuses while a line is not approved. |
| `factory/hooks/readers/factory.ts`, `factory/hooks/commands.ts`, `factory/hooks/start.ts` | Use `scan().note`; `/factory tracker`. |
| `docs/trackers/mcp.md`, `jira.md`, `asana.md`, `README.md`, `docs/notes/r3-check.md`, `docs/notes/r1-check.md`, `docs/notes/phase-4-decisions.md` | Documents. |

---

### Task 1: The engine check

Nothing of the plugin changes. A throwaway mod answers the six points of spec 9.2.

**Files:**
- Create: `docs/notes/r3-check.md`
- The mod: in a new folder under the session's scratch directory, never in the repo.

- [ ] **Step 1: Write the mod.** One hooks module. A command `/r3 <point>` whose `command.run` hook calls `$.mcp.call` and writes what came back (the keys of the result, `isError`, the type and length of each content block, the milliseconds, or the rejection's text) to a file with `$.fs`. A `turn.complete` hook and a `$.clock` timer do the same call once each, to learn whether the call works outside a command. Read `docs/notes/r2c-check.md` for how the last check ran a mod headless (`claude -p --plugin-dir <folder>`).
- [ ] **Step 2: Run it.** Allowed calls: reading tools only, on the owner's own tracker (the server whose tools list tasks and labels; its name is in `claude mcp list`). One call each: a tool that answers JSON; a tool name that does not exist; a known tool with a wrong argument; a server name that does not exist; a server that `claude mcp list` shows as "Needs authentication"; `$.mcp.call('factory', 'sh', { command: 'true' })` with the factory plugin loaded beside the mod. No write. No call on any other connected server.
- [ ] **Step 3: Write `docs/notes/r3-check.md`** in the form of `r2c-check.md`: a table "what was asked, and the answer" for the six points, "what this means for the factory", "not checked". Add the nine facts of spec 9.1 under "The five actions, by hand" as written there. The tracker is "an MCP tracker of the owner's": no name, no address, no id of a task.
- [ ] **Step 4: Stop rule.** If `$.mcp.call` does not work from a `command.run` hook, stop and report BLOCKED: the plan cannot go on. If it works there but not from `turn.complete` or a timer, go on and write it in the note (the adapter's calls all start in a command or the end of a turn; the panel's refresh is the timer case, and then the panel reads the queue only on `/factory`).
- [ ] **Step 5: Commit** `docs: the R3 check (a tracker's MCP tools, called from the plugin)`.

**Produces for later tasks:** the facts in `r3-check.md`: whether the data is in `structuredContent` or a text block; whether a missing server rejects or answers `isError`; the text of each failure.

---

### Task 2: The settings of an MCP tracker and its approval lines

**Files:**
- Create: `factory/core/mcp-tracker.ts`, `factory/tests/mcp-settings.test.ts`
- Modify: `factory/core/settings.ts` (`TrackerKind`, `tracker()`, `commandsOf`), `factory/tests/factory-settings.test.ts`, `factory/tests/settings.test.ts`

**Interfaces — Produces:**

```ts
// factory/core/mcp-tracker.ts
import type { TrackerState } from '../adapters/tracker'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type McpCall = { tool: string; args: { [key: string]: Json } }
export type ListSpec = McpCall & { rows: string | null; id: string; title: string; state: string | null }
export type ReadSpec = McpCall & {
  title: string; text: string
  author: string | null; state: string | null; labels: string | null; url: string | null
  comments: string | null; commentAuthor: string | null; commentText: string | null
}
export type CommentsSpec = McpCall & { rows: string | null; author: string; text: string }
export type Step = McpCall & { optional: boolean }
export type StatesSpec =
  | { as: 'calls'; steps: Partial<Record<TrackerState, Step[]>> }
  | { as: 'labels'; write: McpCall; names: Record<TrackerState, string> | null }
export type McpTracker = {
  server: string; url: string | null
  list: ListSpec; claimed: ListSpec | null; read: ReadSpec; comments: CommentsSpec | null
  comment: McpCall; states: StatesSpec; linkPr: McpCall | null
  me: (McpCall & { name: string }) | null
}
export function parseMcpTracker(v: Record<string, unknown>): { ok: McpTracker } | { no: string }
export function mcpLines(spec: McpTracker): string[]
```

`Settings['tracker']` becomes `{ kind: TrackerKind; mark: string; project: string | null; mcp: McpTracker | null } | null`, with `TrackerKind = 'github' | 'azure-boards' | 'mcp'`. `mcp` is non-null exactly when `kind === 'mcp'`.

- [ ] **Step 1: Write the failing tests** in `factory/tests/mcp-settings.test.ts`. `GOOD` is the JSON of spec 6.1 (the `tracker` object). Tests, each with its own asserts:

```ts
test('the example of the design parses', () => {
  const { ok } = parseMcpTracker(GOOD) as { ok: McpTracker }
  expect(ok.server).toBe('tasks')
  expect(ok.list).toEqual({ tool: 'find_tasks', args: { label: '{mark}', states: ['open'] }, rows: 'tasks', id: 'id', title: 'title', state: 'state' })
  expect(ok.states).toEqual({ as: 'calls', steps: { 'in-progress': [{ tool: 'move_task', args: { task_id: '{id}', to: 'started' }, optional: false }], 'needs-human': [{ tool: 'move_task', args: { task_id: '{id}', to: 'waiting' }, optional: true }], done: [/* … */], rejected: [/* … */] } })
  expect(ok.me).toEqual({ tool: 'who_am_i', args: {}, name: 'name' })
})
test('the labels form of states', () => {
  // { states: { labels: { tool: 'edit_item', args: { key: '{id}', fields: { labels: '{labels}' } } } } } → as: 'labels', names: null
  // with "names": { 'in-progress': 'factory-doing', … all four } → names kept; three names only → refused
  // refused when `read` has no `labels`
})
test('what is refused, each with a reason', () => {
  // one case per rule; every `no` is a short text that names the key:
  // no server; server 'factory'; server 'plugin:factory:x'; a server or tool with a control character or 101 characters
  // an unknown key ('linkPR'); `list` with no `id`; `read` with no `title` or no `text`
  // a field name 'a.b.c.d.e.f.g' (seven parts), 'a..b', 'a[0]', 'a.*'
  // args of 1,001 characters; args five levels deep; args that is a list
  // '{nope}' in a value; '{text}' in `list`; '{text}' inside a longer text ('re: {text}') in `comment`
  // '{url}' outside `linkPr`; '{labels}' outside `states.labels`; '{state}' outside a step; '{text}' in a step
  // a placeholder in a key ({ '{id}': 1 }); five steps for one state; a state name that is not one of the four
  // `url` with no '{id}', or not https, or with a control character
  // `comments` together with read.comments is allowed: `comments` wins (not refused)
})
test('the lines: one for each call, whole, in a fixed form', () => {
  const lines = mcpLines(ok)
  expect(lines).toContain('[tracker] mcp tasks · list: find_tasks {"label":"{mark}","states":["open"]} → rows=tasks id=id title=title state=state')
  expect(lines).toContain('[tracker] mcp tasks · state in-progress 1/1: move_task {"task_id":"{id}","to":"started"}')
  expect(lines).toContain('[tracker] mcp tasks · state needs-human 1/1 (optional): move_task {"task_id":"{id}","to":"waiting"}')
  expect(lines).toContain('[tracker] mcp tasks · url: https://tracker.example.com/tasks/{id}')
  expect(lines.length).toBe(11) // list, claimed, read, comment, 4 states, linkPr, me, url
  // any change gives another line: for each of { a tool, an argument's value, an argument's key order (same line!), a field name, the server, optional }:
  expect(mcpLines({ ...ok, list: { ...ok.list, args: { states: ['open'], label: '{mark}' } } })).toEqual(lines) // key order is not a change
  expect(mcpLines({ ...ok, list: { ...ok.list, id: 'key' } })).not.toEqual(lines)
  expect(lines.every(line => !CONTROL_CHAR.test(line))).toBe(true)
})
```

In `factory-settings.test.ts`: `parseSettings` of a file with `tracker.kind: "mcp"` and `GOOD` gives `settings.tracker.mcp` non-null and `commandsOf(settings)` holds the 11 lines after the gate lines; a bad `mcp` tracker gives `tracker: null` and `error` `tracker: <reason>`; `kind: "jira"` and `kind: "asana"` give `tracker: null` and the error `tracker: use kind mcp: see docs/trackers`; a `github` tracker has `mcp: null`. Fix the existing asserts that compare a whole tracker object (`settings.test.ts:78`, `init.test.tsx:18,46`, `factory-settings.test.ts:152`) for the new `mcp: null` key.

- [ ] **Step 2: Run** `claude plugin test factory`. Expected: the new tests fail (no such module).
- [ ] **Step 3: Implement.** `parseMcpTracker` checks every key against a fixed table of allowed keys per action. The line of an action: `[tracker] mcp <server> · <action>: <tool> <args as JSON with sorted keys, no spaces>`, then ` → k=v` for each field name the action has, in the fixed order of the type. A read placeholder is found with one pattern, `/\{[a-z]+\}/g`, over every text value. `settings.ts`: `tracker()` calls `parseMcpTracker` for `kind: 'mcp'`; `commandsOf` appends `mcpLines` after the place line.
- [ ] **Step 4: Run** the tests. Expected: 0 fail.
- [ ] **Step 5: Commit** `feat: the settings of an MCP tracker, and a line to approve for each call`.

---

### Task 3: Filling a call and reading an answer

**Files:**
- Modify: `factory/core/mcp-tracker.ts`
- Create: `factory/tests/mcp-read.test.ts`

**Interfaces — Consumes:** the types of Task 2. **Produces:**

```ts
export type McpResult =
  | { content: { type: string; text?: string }[]; isError: boolean; structuredContent?: unknown }
  | { failed: 'timeout' | 'no-server' | 'other'; why: string }
export type Fill = { mark: string; id?: string; text?: string; url?: string; labels?: string[]; state?: TrackerState }
export const isItemId = (id: string): boolean // ^[A-Za-z0-9][A-Za-z0-9_.#-]{0,39}$
// The arguments to send, or null when a value it needs is missing or breaks its rule.
export function fill(args: { [key: string]: Json }, values: Fill): { [key: string]: Json } | null
// Why the call failed, as one clean line of at most 200 characters; null when it did not.
export function errorOf(tool: string, result: McpResult): string | null
// The answer's data for an action that reads fields; undefined when there is none.
export function dataOf(result: McpResult): unknown
export function at(data: unknown, path: string): unknown // undefined = not there
export function listedOf(data: unknown, spec: ListSpec): Listed[] | null
export function itemOf(data: unknown, spec: ReadSpec, id: string, urlTemplate: string | null): { item: TrackerItem; labels: string[] | null } | null
export function commentsOf(data: unknown, rows: string | null, author: string, text: string): { author: string; text: string }[] | null
export function labelsAfter(labels: string[], mark: string, state: TrackerState, names: Record<TrackerState, string> | null): string[]
```

- [ ] **Step 1: Write the failing tests** in `factory/tests/mcp-read.test.ts`:

```ts
test('fill: a lone placeholder keeps its type; mark and id go inside a text', () => {
  expect(fill({ k: '{id}', q: 'label = "{mark}" and key = {id}', n: 3, l: '{labels}', deep: [{ s: '{state}' }] },
    { mark: 'factory', id: 'PROJ-12', labels: ['a', 'b'], state: 'done' }))
    .toEqual({ k: 'PROJ-12', q: 'label = "factory" and key = PROJ-12', n: 3, l: ['a', 'b'], deep: [{ s: 'done' }] })
})
test('fill: outside text is sent as it is, and is never read again', () => {
  expect(fill({ text: '{text}' }, { mark: 'm', id: 'A-1', text: 'see {id} and {mark} and {labels}' })).toEqual({ text: 'see {id} and {mark} and {labels}' })
})
test('fill: nothing is sent when a value is missing or breaks its rule', () => {
  expect(fill({ k: '{id}' }, { mark: 'm' })).toBe(null)
  expect(fill({ k: '{id}' }, { mark: 'm', id: 'a b' })).toBe(null)
  expect(fill({ k: '{id}' }, { mark: 'm', id: '-x' })).toBe(null)
  expect(fill({ k: '{url}' }, { mark: 'm', url: 'javascript:1' })).toBe(null) // only https://, no space
})
test('the data of an answer', () => {
  expect(dataOf({ content: [{ type: 'text', text: '{"a":1}' }], isError: false })).toEqual({ a: 1 })
  expect(dataOf({ content: [{ type: 'text', text: '{"a":1}' }], isError: false, structuredContent: { b: 2 } })).toEqual({ b: 2 })
  expect(dataOf({ content: [{ type: 'text', text: '[1]' }], isError: false, structuredContent: [9] as unknown })).toEqual([1]) // structuredContent counts only as an object
  for (const bad of [{ content: [{ type: 'text', text: 'Done.' }], isError: false }, { content: [], isError: false }, { content: [{ type: 'text', text: '{"a":1}' }], isError: true }, { failed: 'timeout' as const, why: 'x' }, { content: [{ type: 'text', text: '"' + 'x'.repeat(1_048_577) + '"' }], isError: false }])
    expect(dataOf(bad)).toBe(undefined)
})
test('a write is judged by isError alone', () => {
  expect(errorOf('add_comment', { content: [{ type: 'text', text: 'Done.' }], isError: false })).toBe(null)
  expect(errorOf('move_task', { content: [{ type: 'text', text: 'Tick every point first.\nmore\u001b[2J' }], isError: true })).toBe('move_task: Tick every point first.')
  expect(errorOf('move_task', { content: [], isError: true })).toBe('move_task: failed')
  expect(errorOf('x', { failed: 'timeout', why: 'no answer in time' })).toBe('x: no answer in time')
  expect(errorOf('x', { content: [{ type: 'text', text: 'e'.repeat(500) }], isError: true })?.length).toBe(200)
})
test('at: a dotted name, and nothing else', () => {
  const data = { fields: { summary: 'S', list: [{ a: 1 }] }, 'a.b': 1 }
  expect(at(data, 'fields.summary')).toBe('S')
  for (const path of ['fields.none', 'fields.list.a', 'fields.summary.length', '__proto__', 'constructor.name', 'a.b']) expect(at(data, path)).toBe(undefined)
})
test('a list: ids as text or whole numbers; a bad row is no item; 200 rows', () => {
  const spec = { tool: 't', args: {}, rows: 'tasks', id: 'id', title: 'title', state: 'state' }
  expect(listedOf({ tasks: [{ id: 'PROJ-12', title: 'A', state: 'Open' }, { id: 7, title: 'B' }, { id: 1.5, title: 'x' }, { id: 'a b', title: 'x' }, { id: 'N-1' }, { id: 'N-2', title: 5 }, 'row'] }, spec))
    .toEqual([{ id: 'PROJ-12', title: 'A', state: 'open' }, { id: '7', title: 'B', state: '' }])
  expect(listedOf({ tasks: 'no' }, spec)).toBe(null)
  expect(listedOf([{ id: 'A-1', title: 'A' }], { ...spec, rows: null })?.length).toBe(1) // the answer itself is the list
  expect(listedOf({ tasks: Array.from({ length: 300 }, (_, i) => ({ id: `A-${i}`, title: 'x' })) }, spec)?.length).toBe(200)
})
test('an item: its fields, its labels in both shapes, its address', () => {
  // spec READ = the read of the design's example; data with made_by 'Ann Lee', comments [{by:'Bo',text:'hi'},{by:5,text:'x'},{by:'C'}], labels ['Factory','bug']
  // → item { id:'PROJ-12', title, state lower-cased, text, author:'ann lee', url:'https://tracker.example.com/tasks/PROJ-12', comments:[{author:'bo',text:'hi'}] }, labels ['Factory','bug']
  // labels [{name:'x'},{name:2},'y'] → ['x','y']; labels 'no' → null; spec.labels null → null
  // spec.url 'web_url' and data.web_url 'https://t.example.com/1' → that address; data.web_url 'ftp://x' → the template's; no template → ''
  // title 400 characters → 300; text 30,000 → 20,000; 60 comments → 50; a comment of 6,000 → 5,000
  // title missing, or a number → null (no item); text missing → '' (an item with no description is an item)
})
test('labelsAfter: the four state labels go, the new one comes, the rest stays', () => {
  expect(labelsAfter(['bug', 'factory', 'Factory:In-Progress'], 'factory', 'done', null)).toEqual(['bug', 'factory', 'factory:done'])
  expect(labelsAfter(['factory', 'f-doing'], 'factory', 'rejected', { 'in-progress': 'f-doing', 'needs-human': 'f-ask', done: 'f-done', rejected: 'f-no' })).toEqual(['factory', 'f-no'])
})
```

- [ ] **Step 2: Run** the tests. Expected: they fail (the functions are not there).
- [ ] **Step 3: Implement.** `fill` walks the JSON once and builds a new value; a text value that is exactly one placeholder becomes the value; in any other text only `{mark}`, `{id}` and `{state}` are put in, with one `replace` over the original text (the result is never read again). `at` uses `Object.hasOwn` at every step and stops at anything that is not a plain object. Use `clean` of `core/rows.ts` for an error line.
- [ ] **Step 4: Run** the tests. Expected: 0 fail.
- [ ] **Step 5: Commit** `feat: an MCP tracker's calls are filled and its answers read by fixed rules`.

---

### Task 4: The adapter, `Io.mcp`, and who may call

**Files:**
- Create: `factory/adapters/mcp-tracker.ts`, `factory/tests/mcp-tracker.test.ts`
- Modify: `factory/adapters/tracker.ts`, `factory/hooks/io.ts`, `factory/hooks/register.tsx` (the `Io` built in `session.start`), `factory/tests/kit.ts` (`fakeIo` and `engine`), `factory/hooks/adapters.ts`, `factory/hooks/readers/factory.ts`, `factory/hooks/commands.ts` (`toolOf`, line 146), `factory/hooks/start.ts` (where a scan that failed is said), `factory/tests/line-run.test.ts`

**Interfaces — Consumes:** Tasks 2 and 3. **Produces:**

```ts
// adapters/tracker.ts
kind: 'github' | 'azure-boards' | 'mcp'
scan(): Promise<{ items: Listed[] | null; claimed: Listed[]; result: RunResult | null; note?: string | null }>
// hooks/io.ts — never rejects
mcp: (server: string, tool: string, args: Record<string, unknown>, timeoutMs: number) => Promise<McpResult>
// adapters/mcp-tracker.ts
export type Call = (tool: string, args: { [key: string]: Json }) => Promise<McpResult>
export function mcpTracker(call: Call, spec: McpTracker, mark: string, forbidden: string[]): Tracker
export const NO_SERVER = (server: string) => `The MCP server ${server} did not answer. Connect it with /mcp.`
```

Behaviour of each method (spec 6.4, 6.5, 6.7):

| Method | What it does |
|---|---|
| `scan` | `list`, then `claimed` when there is one. A failed `list` → `{ items: null, claimed: [], result: null, note }`; `note` is `NO_SERVER(server)` for `failed: 'no-server'` or `'timeout'`, else `errorOf`. A failed `claimed` → `claimed: []` (the queue still shows). |
| `list` | `(await scan()).items ?? []` |
| `hasMark` | With `read.labels`: the item's labels hold the mark, with no regard to case. Without: the id is a row of `list` or `claimed`. A failed call → false. |
| `me` | The `me` call once, cached; the `name` field as text, lower case, ≤ 200; else null. |
| `read` | One call. With `comments` spec and `withComments`: a second call; an item whose comments cannot be read is null (the rule of Azure Boards). |
| `comment` | `commentOf(markdown, forbidden)` first (throws `the comment was not sent: <why>` as the others do); then the call; throws `errorOf`. |
| `setState` | Calls form: the steps in order; a failed step throws `errorOf` unless `optional`. No entry: nothing. Labels form: `read` (throws `<tool>: the item could not be read` when null or with no labels), then the write with `labelsAfter`. |
| `linkPr` | Refuses an address that is not `https://` with no space (`not a pull request address`). With `linkPr`: the call. Without: `comment(id, 'Pull request: <url>')`. |

Every call goes through `fill`; a null from `fill` throws `<tool>: not sent (a value broke a rule)` for a write and reads as a failed call for a read. Nothing is called then.

`adaptersOf`: for `wanted.kind === 'mcp'`, every line of `mcpLines(wanted.mcp)` must be in the approved store (`approvedOf(await io.storeGet(storeKey(await consentKeyOf(io, root))))`); else `tracker` stays null and `why` is `The MCP tracker's calls are not approved. Read them in the pane, then /factory approve.` The `call` closure is `(tool, args) => io.mcp(wanted.mcp.server, tool, args, timeoutMs)`.

`register.tsx`: `mcp` wraps `$.mcp.call(server, tool, args)` in a race with a `$.clock` timer of `timeoutMs` (`{ failed: 'timeout', why: 'no answer in time' }`); a rejection becomes `{ failed: 'no-server' | 'other', why }` as `docs/notes/r3-check.md` says a missing or signed-out server answers. The result's `content` blocks are copied as `{ type, text }` only.

- [ ] **Step 1: Write the failing tests.** In `factory/tests/mcp-tracker.test.ts`, with a fake `call` that records `[tool, args]` and answers from a table:

```ts
test('the five actions call the tools of the settings, with the values in place', async () => {
  // scan → find_tasks {label:'factory',states:['open']} and find_tasks {…['started']}; items and claimed as parsed
  // read('PROJ-12') → show_task {task_id:'PROJ-12'}; comment → add_comment {task_id, text}; linkPr → attach_link {task_id, ref:url}
  // setState('PROJ-12','in-progress') → move_task {task_id, to:'started'}
})
test('an optional step that fails does not fail the move; another one does', async () => {
  // needs-human: move_task answers isError 'Tick every point first.' → setState resolves
  // done: move_task answers isError → rejects with 'move_task: …'; and a second step of that state is not called
})
test('states as labels: read, then write the whole list', async () => { /* calls in order: show_task, edit_item {key, fields:{labels:['bug','factory','factory:done']}}; read fails → throws, no write */ })
test('a write that answers a plain sentence passed', async () => { /* comment resolves when add_comment answers text 'Saved.' */ })
test('with no linkPr the address is a comment; a bad address is refused before any call', async () => {})
test('a forbidden word stops the comment before any call', async () => {})
test('the server did not answer: the note says how to connect it', async () => {
  // call answers { failed: 'no-server', why: 'not connected' } → scan() = { items: null, claimed: [], result: null, note: 'The MCP server tasks did not answer. Connect it with /mcp.' }
})
test('hasMark: by the labels, in any case; without labels, by the list', async () => {})
test('an id that breaks the rule calls nothing', async () => { /* read('a b') → null, hasMark → false, comment rejects; calls.length === 0 */ })
```

In `factory/tests/line-run.test.ts` (the world's `fakeIo` gains `mcpCalls: [server, tool, args][]` and `mcpAnswer`):

```ts
test('an MCP tracker is asked nothing while one of its lines is not approved', async () => {
  // settings: tracker GOOD (kind mcp). Store: the gate lines only.
  // startRun → "The MCP tracker's calls are not approved. Read them in the pane, then /factory approve."
  // refresh(io) → factory.queue null; io.mcpCalls.length === 0
  // store gains mcpLines(GOOD) → refresh shows queue 1; then the settings change one argument (states ['open','new']) → mcpCalls gains nothing more, queue null again
})
test('with an MCP tracker one item goes from the queue to a ready pull request', async () => {
  // as the Azure DevOps test of this file: the calls in order hold move_task started, add_comment, attach_link, and no gh issue / az boards call
})
test('the panel says when the MCP server did not answer, and /factory run does not start', async () => {})
```

- [ ] **Step 2: Run** the tests. Expected: they fail.
- [ ] **Step 3: Implement** the adapter, `Io.mcp` (real and fake), the choice in `adaptersOf`, and `note` in the panel reader (`note ??= listed.note ?? …`), in `toolOf`/the failure text of `commands.ts`, and where `start.ts` says why the tracker cannot be read.
- [ ] **Step 4: Run** all tests and `claude plugin validate factory`. Expected: 0 fail; validation passed.
- [ ] **Step 5: Commit** `feat: the line and the panel run on a tracker's MCP server`.

---

### Task 5: `/factory tracker`

**Files:**
- Modify: `factory/hooks/commands.ts` (new `trackerCheck`), `factory/hooks/register.tsx` (the command word and the help text), `factory/tests/commands.test.tsx`

**Interfaces — Consumes:** `context(io)` (`hooks/context.ts`), the `Tracker` contract. **Produces:** `export async function trackerCheck(io: Io, id: string | null): Promise<string>`.

The answer, one fact per line (spec 8). It goes to the model: no text of the tracker in it.

```text
Tracker: mcp
Queue: 3 items (PROJ-12, PROJ-14, PROJ-15). Claimed: 1.
Me: read.
PROJ-12: title found (41 characters) · text found (1203 characters) · author found · state found · address found
PROJ-12: carries the mark: yes · 4 comments (2 of the author or the runner)
```

- No tracker: `ctx.trackerNote ?? 'No tracker in the settings.'`. A failed scan: `Queue: not read (<note or cut reason>)`. `Me: not known.` An empty queue with no id given: `Queue: 0 items. Nothing to read. Is the mark right?`. An id that breaks the id rule: `Not an id.` and no call. An item that cannot be read: `<id>: not read.`
- The contract does not change for this: `hasMark(id)` gives the mark, and the count of labels of spec 8 is left out (the contract has no labels).
- It is not one of the "only a person" commands: it reads only.

- [ ] **Step 1: Write the failing tests** in `commands.test.tsx`: the answer above for an MCP world (asserting each line, and that the answer holds neither the title, the text, an author's name nor a comment's text of the fake item); the same command on a GitHub world (kind `github`); the five refusals; `/factory tracker PROJ-14` reads that item; no write tool is called (`mcpCalls` holds only `find_tasks`, `show_task`, `who_am_i`).
- [ ] **Step 2: Run.** Expected: fail.
- [ ] **Step 3: Implement** `trackerCheck` and the command word; add `/factory tracker [id]` to the help text.
- [ ] **Step 4: Run** all tests. Expected: 0 fail.
- [ ] **Step 5: Commit** `feat: /factory tracker reads the tracker and says what it understood`.

---

### Task 6: The fence is pinned, and the documents

**Files:**
- Modify: `factory/tests/fence.test.ts`, `factory/tests/agents.test.ts`, `README.md`, `docs/notes/r1-check.md`
- Create: `docs/trackers/mcp.md`, `docs/trackers/jira.md`, `docs/trackers/asana.md`

- [ ] **Step 1: Write the pin tests.** `agents.test.ts`: for every role and both shells, `toolsOf(role, shell)` holds no name that starts with `mcp__` except `SHELL_TOOL`, and the registered agent types carry no `mcpServers`. `fence.test.ts`: a `tool.check` for an agent of the line with `tool: 'mcp__tasks__move_task'` is denied, for every role. If one fails, the fence has a hole: fix it in `core/fence.ts` and say so in the task report.
- [ ] **Step 2: Run.** Expected: pass at once (the fence refuses a tool outside its role's list, `core/fence.ts:335`), or the fix of Step 1.
- [ ] **Step 3: Write `docs/trackers/mcp.md`**: what it is (three sentences), "Before you start" (connect the server with `/mcp`; the plugin stores no login), the example of spec 6.1, the table of keys (6.2), the placeholders (6.3), how an answer is read (6.4) with the limits, the two forms of states (6.5), the approval (6.6: every call is a line; any change needs a new approval; why: a settings file comes with a clone and `/factory approve` is the only thing between it and your sign-in), `/factory tracker`, and "What it cannot do" (first 200 rows; `{id}` is sent as text; a state step takes no text; a server that answers an error with `isError: false`; an author that is a display name: choose a field with an id or an email when the tracker has one).
- [ ] **Step 4: Write `docs/trackers/jira.md`.** First line under the title: `Not tested. Nobody ran this mapping against Jira.` A whole `tracker` object for Atlassian's MCP server: `list` and `claimed` with `searchJiraIssuesUsingJql` (`cloudId`, `jql` with `project = PROJ AND labels = "{mark}" AND labels not in ("{mark}:in-progress", "{mark}:needs-human", "{mark}:done", "{mark}:rejected") AND statusCategory != Done`, `fields: ["summary","status"]`; `rows: "issues"`, `id: "key"`, `title: "fields.summary"`, `state: "fields.status.name"`), `read` with `getJiraIssue` (`fields` with `comment`, `responseContentFormat: "markdown"`; `text: "fields.description"`, `author: "fields.reporter.displayName"`, `labels: "fields.labels"`, `comments: "fields.comment.comments"`, `commentAuthor: "author.displayName"`, `commentText: "body"`), `comment` with `addCommentToJiraIssue` (`commentBody: "{text}"`, `contentFormat: "markdown"`), `states.labels` with `editJiraIssue` (`fields: { "labels": "{labels}" }`), no `linkPr` (the server has no tool for a remote link: the address is a comment), `url: "https://<your-site>.atlassian.net/browse/{id}"`. Then "What to check first": the `cloudId` (the site's address works); whether a label takes a `:` (if not, use `names`); the fields of `atlassianUserInfo` for `me`; that `/factory tracker` reads an issue.
- [ ] **Step 5: Write `docs/trackers/asana.md`** from spec section 10: not tested; the server and the registered "MCP app"; the tools that exist; what cannot be written (a tag, a link) and what that means for the four states; a mapping with `get_tasks`, `get_task`, `get_task_stories`, `add_comment`, `update_tasks`, `get_me` in which every argument name that Asana's documents do not give is `"<from /mcp>"`, with the sentence "This is not a working file: fill the names from the server's own tool list." (A value `<from /mcp>` is refused by nothing, so say plainly that the calls will fail until it is replaced.)
- [ ] **Step 6: README.** A section "Other trackers (through an MCP server)" after the Azure DevOps one: four sentences and the three links; add `/factory tracker` to the command list; in the approval section, one sentence on an MCP tracker's lines. `docs/notes/r1-check.md`: a section "An MCP tracker, by hand" (connect, write the settings, read each line in the pane and scroll to the last, `/factory approve`, `/factory tracker`, mark one test item, `/factory run`, see the comment, the state and the link on the item).
- [ ] **Step 7: Run** `claude plugin test factory`, `claude plugin validate factory`, and `grep -rniE "<the owner's tracker and company names, given in the task brief>" docs README.md factory` (expected: no line).
- [ ] **Step 8: Commit** `docs: trackers through an MCP server; Jira and Asana as examples` (and `test:` for the pins, in the same or a second commit).

---

### Task 7: The proof on the real tracker, and the decisions

**Files:**
- Modify: `docs/notes/r3-check.md`
- Create: `docs/notes/phase-4-decisions.md`
- Outside the repo: a scratch git repository with `.claude/factory.json` for the owner's tracker.

- [ ] **Step 1:** Make the scratch repository (a new folder outside this repo, `git init`, one commit, a GitHub-shaped `origin` that need not exist). Write its `.claude/factory.json` with the `mcp` mapping of the owner's tracker (the tool and field names are in the task brief; they never go into this repo). The mark is a label that exists there.
- [ ] **Step 2:** In a real session with the plugin loaded from this branch (`claude --plugin-dir <repo>/factory`, in the scratch repository): the pane shows the lines; `/factory approve` (a person's act: if a headless run cannot do it, hand this step to the owner with the exact commands and stop here, reporting what is left); `/factory tracker`. Reads only.
- [ ] **Step 3:** Record in `docs/notes/r3-check.md`, section "`/factory tracker` on the real tracker": the answer's lines with ids replaced by `PROJ-n`, and anything that differed from what the adapter expected. Fix what differed (with a test) before the note is closed.
- [ ] **Step 4:** Write `docs/notes/phase-4-decisions.md` in the form of `phase-3-decisions.md`: the decision that shaped the work (only the general kind; who tested what), decisions made while building, known gaps (the two calls of the labels form; display names; first 200 rows; Jira and Asana never run), small findings not fixed, not checked.
- [ ] **Step 5: Commit** `docs: phase 4 decisions and the proof on a real MCP tracker`.
