# Phase 4: a tracker through its MCP server (`tracker.kind: "mcp"`): design

Date: 2026-11-13. Branch: `phase-4-mcp-tracker`, on top of `phase-3-azure-devops`.
This document replaces sections 7.2 (the Jira and Asana rows) and 7.3 of
`2026-11-12-factory-plugin-design.md` for phase 4. Everything else there holds.

## 1. Intent

A person signs in to a tracker's MCP server in Claude Code. The factory then works
with that tracker through the settings file alone: no code for that tracker in the
plugin, and no token in the plugin.

The first design gave Jira and Asana an adapter each, and a general `mcp` kind
beside them. The owner decided on 2026-11-13 to build **only the general kind**:
Jira and Asana are settings examples in the documents, not code. Why: the plugin
cannot test Jira or Asana where it is built, and code that nobody ran is not
support. A person who has the tracker fits the example to it and tries it with a
read-only command.

## 2. Goals

- G1. `tracker.kind: "mcp"`: the settings name one MCP server and, for each action
  of the tracker contract, the tool to call, its arguments and where the answer's
  fields are.
- G2. No tool is called before the person approved it. Every call that the settings
  can make is a line the person reads in the pane, whole, and approves with
  `/factory approve`.
- G3. The line and its commands do not change: they use the `Tracker` contract
  (`factory/adapters/tracker.ts`), and the new adapter is one more behind it. Two
  small changes are accepted: `scan` carries a plain note (6.7), and the pane's list
  of lines to approve shows a long line whole (6.6).
- G4. Proven on a real engine and a real MCP tracker before the phase is called done
  (section 9).
- G5. A person can try a mapping without a write: `/factory tracker` runs the reading
  actions and shows what the plugin understood.
- G6. Documents: the settings reference, and one worked example each for Jira
  (Atlassian's MCP server) and Asana (Asana's MCP server), each marked **not tested**
  with what is known and what is not.

## 3. Non-goals

- Code for Jira or Asana. The kinds `jira` and `asana` leave `TrackerKind`; a
  settings file that names one gets the error "use kind mcp: see docs/trackers".
  (My call: a built-in kind that was never run would read as support.)
- A sign-in. The person connects the server (`/mcp`). The plugin lists no server in
  its own manifest and stores no credential.
- A pull request host through MCP. The host is still GitHub or Azure Repos, from the
  remote.
- More than the first page of a list. A queue is the first 200 rows of the answer.
- `/factory init` for an MCP tracker. It still drafts GitHub and Azure Boards only.

## 4. What must never happen

- A1. A settings file makes the plugin call a tool that nobody approved.
  `$.mcp.call` asks no permission, and it uses the person's own sign-in on every
  connected server. A settings file arrives with a clone. Without the approval, a
  hostile clone could send a message or delete a record in the person's name.
- A2. Text from outside (a title, a description, a comment, an id from a list)
  chooses a server, a tool or the name of an argument.
- A3. An action counts as done when the tool said it failed.
- A4. The settings hold a program: no expression, no condition, no loop. They hold
  names, fixed values, six placeholders and dotted field names.
- A5. A factory agent calls the tracker's server itself.
- A6. Text from the tracker, or a line of a settings file that is not approved,
  reaches the session's model through a command's answer. (Today's rule: an
  answer holds counts and cut error texts; `core/brief.ts`, `hooks/refresh.ts`.)
- A7. The public repo names the owner's own tracker, in code, tests or documents.

## 5. Constraints

- The engine's call is `$.mcp.call(server, tool, args)`: positional, no permission
  prompt, the engine's own connection. It answers `{ content, isError,
  structuredContent? }`. `server` is the name `/mcp` lists.
- `$` cannot be passed to a function. `Io` (`factory/hooks/io.ts`) gains one
  closure, `mcp(server, tool, args, timeoutMs)`, that never rejects.
- A hook has a budget of about 10 seconds (`docs/notes/r2-check.md`). Every MCP call
  has a time limit, and a list is one call.
- The approval store holds the full approved lines, never a digest
  (`factory/core/consent.ts`). A call runs only when its exact line is in the store.
- The public repo rule: sample names only (`PROJ-12`, `tracker.example.com`).

## 6. The settings

### 6.1 Shape

An example for an imagined tracker. Every name in it is the tracker's own.

```json
{
  "tracker": {
    "kind": "mcp",
    "mark": "factory",
    "server": "tasks",
    "url": "https://tracker.example.com/tasks/{id}",
    "list": {
      "tool": "find_tasks",
      "args": { "label": "{mark}", "states": ["open"] },
      "rows": "tasks", "id": "id", "title": "title", "state": "state"
    },
    "claimed": {
      "tool": "find_tasks",
      "args": { "label": "{mark}", "states": ["doing"] },
      "rows": "tasks", "id": "id", "title": "title", "state": "state"
    },
    "read": {
      "tool": "get_task",
      "args": { "task_id": "{id}" },
      "title": "title", "text": "description", "author": "made_by",
      "state": "state", "labels": "labels",
      "comments": "comments", "commentAuthor": "by", "commentText": "text"
    },
    "comment": { "tool": "add_comment", "args": { "task_id": "{id}", "text": "{text}" } },
    "states": {
      "in-progress": [{ "tool": "set_step", "args": { "task_id": "{id}", "step": "doing" } }],
      "needs-human": [{ "tool": "set_step", "args": { "task_id": "{id}", "step": "review" }, "optional": true }],
      "done": [{ "tool": "set_step", "args": { "task_id": "{id}", "step": "done" } }],
      "rejected": [{ "tool": "cancel_task", "args": { "task_id": "{id}" } }]
    },
    "linkPr": { "tool": "link_code", "args": { "task_id": "{id}", "ref": "{url}" } },
    "me": { "tool": "who_am_i", "args": {}, "name": "name" }
  }
}
```

### 6.2 The keys

| Key | Needed | What it is |
|---|---|---|
| `server` | yes | The MCP server, as `/mcp` names it. |
| `mark` | no (`factory`) | As today. |
| `url` | no | The address of an item, with `{id}`. Without it an item has no address. |
| `list` | yes | The queue: marked, open, not taken. `rows` is the field that holds the list; `id`, `title`, `state` are fields of a row. |
| `claimed` | no | The items the tracker says are in progress. Same shape as `list`. Without it, none. |
| `read` | yes | One item. `title` and `text` are needed. `author`, `state`, `labels`, `url` (a field with the address, used before the `url` key) and the three comment keys are optional. |
| `comments` | no | A second call for the comments, for a tracker whose read does not give them: `tool`, `args`, `rows`, `author`, `text`. When it is there, `read`'s comment keys are not used. |
| `comment` | yes | Writes a comment. Uses `{text}`. |
| `states` | yes | How a state is set: section 6.5. |
| `linkPr` | no | Links the pull request. Uses `{url}`. Without it, the plugin writes a comment with the address. |
| `me` | no | Who runs the line, as the tracker names an author. `name` is the field. Without it, `me()` answers null (today's meaning: the runner's own comments reach no agent). |

`tracker.project` is not used with `mcp`. A key that is not in this table is an
error for `kind: "mcp"` (a mistyped `linkPR` must not be ignored in silence).

### 6.3 Arguments and placeholders

`args` is JSON: objects, lists, text, numbers, true, false. The plugin sends it as
it is, after it puts values in for these six placeholders:

| Placeholder | The value | Where it may stand |
|---|---|---|
| `{mark}` | The mark. | Alone, or inside a longer text. |
| `{id}` | The item's id. | Alone, or inside a longer text. |
| `{text}` | A comment's text. | Alone only. `comment` only. |
| `{url}` | The pull request's address. | Alone only. `linkPr`. |
| `{labels}` | The item's new list of labels. | Alone only. `states.labels` (6.5). |
| `{state}` | `in-progress`, `needs-human`, `done` or `rejected`. | Alone, or inside a longer text. Steps of `states`. |

- "Alone" means the whole JSON value is the placeholder. The value then keeps its
  type: `{labels}` becomes a list of texts.
- `{text}` and `{url}` never stand inside a longer text: text from outside is never
  mixed into a query or a command of the tracker (a JQL text, for example).
- `{mark}` and `{id}` may, because each passes a rule first: the mark is the
  settings' own (the parser's `isMark`), and an id must match
  `^[A-Za-z0-9][A-Za-z0-9_.#-]{0,63}$`. A row whose id does not match is no item. An
  id that the person types (`/factory run PROJ-12`) passes the same rule.
- A placeholder is never read in a key, in `tool` or in `server`. An unknown
  `{name}` in a value is an error of the settings.
- A step of `states` takes no `{text}`: `setState` has no text in the contract, and
  the contract does not change for it. (My call. A tracker whose state change needs
  a reason is not served in this phase.)
- `{id}` is always sent as text. A tool that wants a number for an id is not served
  in this phase; the reference says so.

### 6.4 Reading an answer

- For an action that reads fields (`list`, `claimed`, `read`, `comments`, `me`): the
  answer's data is `structuredContent` when it is an object. Otherwise it is the
  first `text` block of `content`, read as JSON. Otherwise the call failed ("the
  answer is not JSON"). An answer over 1 MB failed.
- For an action that reads no field (`comment`, a step of `states`, `linkPr`):
  `isError` alone decides. Many servers answer a write with a plain sentence. A
  server that answers `isError: false` with an error in its text is not served: the
  reference says so.
- `isError: true` is a failure. Its reason is the first line of the first text
  block, cleaned and cut, as the other adapters do with a command's error text.
- A field name is dotted (`fields.summary`): one to six parts, each
  `[A-Za-z0-9_]+`. No index, no wildcard. A part that meets a list, or a missing
  part, gives "not there". `rows` (and a comments list) must end at a list. Without
  `rows`, the answer itself must be the list.
- An id is a text, or a whole number that JSON holds exactly (it is read as its
  digits). A row with no id or no title is no item. An item whose `title` is not text is no
  item. Text fields are cut to the limits the other adapters use. A value that is
  not text where text is expected is "not there", never `String(value)`.
- `labels` must be a list of texts (or a list of objects with a `name` text: my
  call, because several trackers answer so).
- Everything fails closed: a list that cannot be read is `items: null` (the panel
  shows a note, `/factory run` does not start); an item that cannot be read is not
  started.

### 6.5 The four states

`states` has one of two forms.

**Calls.** One entry per state: a list of up to four steps, run in order. A step
that fails stops the move and the move failed, unless the step says
`"optional": true` (then the next step runs, and the move did not fail). A state
with no entry calls nothing.

**Labels.** For a tracker where a state is a label, and a label is written as the
whole list:

```json
"states": {
  "labels": {
    "tool": "edit_item",
    "args": { "key": "{id}", "fields": { "labels": "{labels}" } }
  }
}
```

The adapter reads the item (`read` must have `labels`), takes away the four state
labels, adds `<mark>:<state>`, and writes the list. The names are the same as on
GitHub and Azure Boards. `"names"` beside `tool` may give other names for the four
(a tracker that takes no `:` in a label). The read and the write are two calls: the
same small window as on Azure Boards, said in the README.

In the labels form, the `list` call must leave out the items that carry a state
label, and `claimed` asks for `<mark>:in-progress`. That is the settings' work (the
examples show it), because only the tracker's own query can do it in one call.

`hasMark(id)`: the item's `labels` hold the mark (compared with no regard to case).
When `read` has no `labels`, the item must be a row of `list` or of `claimed`.

### 6.6 The approval

Every action is one line in the pane, and `/factory approve` allows the lines, as
for a gate command. A line holds the **whole** action in a fixed form, so that any
change (a tool, an argument, a field name, the server, the `url`) is a new line
that is not approved:

```text
[tracker] mcp tasks · list: find_tasks {"label":"{mark}","states":["open"]} → rows=tasks id=id title=title state=state
[tracker] mcp tasks · state in-progress 1/1: set_step {"step":"doing","task_id":"{id}"}
[tracker] mcp tasks · url: https://tracker.example.com/tasks/{id}
```

The mark has its own line, `[tracker] mcp tasks · mark: factory`, because the mark is put into the approved calls.

- The JSON in a line is compact, with sorted keys. The exact form is the builder's.
- No call of the adapter runs while one of its lines is not approved: not a write,
  not a read, not the panel's queue. (`adaptersOf` gives no tracker, with the reason
  that phase 3 gives for a place that is not approved.)
- A line must be readable whole **in the pane** before it can be approved: the pane
  wraps a long line and never cuts it, and a list that is longer than the pane can
  be read to its end (folded, paged or scrolled: the builder's choice). The answer
  of `/factory approve` still holds a count and never a line (A6). The builder
  checks how the pane shows fifteen 300-character lines today, and fixes what
  cuts or hides one. `/factory approve` allows nothing while a line was not on
  screen whole (today's "shown" rule, kept).
- Limits, so that a line stays readable: `args` of one action is at most 1,000
  characters as JSON, four levels deep; no control character anywhere (the rule of
  a command); `server` and `tool` match `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$`.
- The server may not be the plugin's own (`factory`, or a name that the engine gives
  the plugin's tools): the settings must not reach `mcp__factory__sh`.

### 6.7 Failures the person sees

- The server is not connected, or needs a sign-in: the panel's note and
  `/factory run` say `The MCP server <name> did not answer. Connect it with /mcp.`
  The note today is built from a command's result with the tool's name (`gh`,
  `az`); the contract's `scan` gains a plain `note` text for this. (Builder's
  choice of shape.)
- A tool that answers an error: the first line of its text, as a reason
  (`<tool>: <reason>`), where a `gh` failure text goes today.

## 7. The parts

| Part | What it does |
|---|---|
| `core/mcp-tracker.ts` (pure) | Parses and checks the `mcp` settings; builds the approval lines; fills placeholders; reads fields from an answer. All rules of section 6 are here, with tests. |
| `adapters/mcp-tracker.ts` | The `Tracker` for `kind: 'mcp'`, on top of the pure part and one `call` closure. |
| `hooks/io.ts`, `register.tsx` | `Io.mcp`: `$.mcp.call` in a closure, with a time limit, never rejects. |
| `hooks/adapters.ts` | Chooses the adapter; refuses while a line is not approved. |
| `core/settings.ts` | `TrackerKind` is `github | azure-boards | mcp`; `commandsOf` adds the lines. |
| `hooks/commands.ts` | `/factory tracker` (section 8). |
| The pane's approval list | Shows each line whole (6.6). |
| The fence and the agents | A rule test: no factory agent type lists an MCP tool of a tracker's server or an `mcpServers` entry, and the fence refuses `mcp__*` tools that are not the plugin's own for a factory agent. If today's fence already does this, the test only pins it. |

Names are the builder's. The split between a pure part and a thin adapter is not:
the rules must be testable with no engine.

## 8. `/factory tracker`

For any tracker kind (it uses the contract). It never writes.

- It runs `scan()` and `me()`, and `read` of the first item of the queue (or of the
  id the person gives: `/factory tracker PROJ-12`), with comments.
- Its answer goes to the session's model, so it holds no text from the tracker
  (A6). It prints: how many items are in the queue and how many are claimed; the
  first three ids (an id passed the id rule); whether "me" was read; and for the
  item, each field as `found (N characters)` or `not there` (title, text, author,
  state, address), how many labels, whether it carries the mark, how many comments,
  and how many of them are the author's or the runner's.
- For each action that failed, the reason, cut as an error text is today.
- With lines that are not approved, it says so and calls nothing.

## 9. Proof

### 9.1 Done before this design (2026-11-13)

The five actions were run by hand on a real MCP tracker (the owner's own; not named
here), on one test item that was cancelled at the end. What it showed:

- Every answer is JSON in a text block.
- A label filter that names no known label answers an empty list, not an error. A
  wrong mark is a quiet empty queue. `/factory tracker` makes that visible.
- A list with no state filter also answers closed items: the state filter belongs
  in `args`.
- Neither the list nor the read answers the item's address. So the `url` key exists.
- Authors are display names, and no tool says who "me" is. So `me` is optional. Two
  people with one display name read as one author: the reference tells a person to
  choose a field with an id or an email when the tracker has one.
- A move to "in review" can be refused by a rule of the tracker (the tool answers an
  error with a sentence). So a step can be `optional`.
- A done item cannot be cancelled. A move to a state the item is in already is no
  error.
- A link to a pull request on a host the tracker does not follow is saved as a
  plain link, with no error.

### 9.2 The engine check (the plan's first task)

A throwaway mod, run in a real session, answers these. The builder runs it. On the
owner's own tracker it calls reading tools only; a write there is only ever on a
test item in the tracker's test project (the owner's word of 2026-11-13: "do the
test"). No other connected server is called, except to learn its name (point 5,
from the engine's list, with no call). The result goes in
`docs/notes/r3-check.md`. If the first point fails, the work stops and goes back to
the owner.

1. `$.mcp.call` works from the hooks the line runs in (a command, the end of a
   turn, the panel's refresh), on a server the person connected.
2. What the result holds for a tool that answers JSON: `structuredContent`, a text
   block, or both.
3. What happens for a server that is not connected, one that needs a sign-in, a
   wrong tool name and a wrong argument: a rejection or `isError`, and the text.
4. How long a call takes, against the hook's budget.
5. The server's name as the call takes it, for a server of each kind the machine has
   (a person's own, a claude.ai connector).
6. Whether `$.mcp.call('factory', 'sh', …)` reaches the plugin's own tool. (It must
   be refused in the adapter either way.)

### 9.3 At the end

The builder writes the owner's settings for the real tracker in a scratch
repository outside this one (its path goes to the owner, not into the repo), and
runs `/factory tracker` there: reads only. The phase is done when the engine check,
the five actions by hand (9.1) and that `/factory tracker` run are recorded in
`docs/notes/r3-check.md`. A full run of the line on the real tracker is a
hand-check section in `docs/notes/r1-check.md` for the owner, as in every phase.
Jira and Asana are **not** run by anyone in this phase.

## 10. Documents

- `docs/trackers/mcp.md`: the reference (section 6), with the imagined example.
- `docs/trackers/jira.md`: a mapping for Atlassian's MCP server, states as labels,
  the pull request as a comment (the server has no tool for a remote link). Marked
  not tested. Names of tools and arguments from the server's own tool list as read
  on 2026-11-13 (`searchJiraIssuesUsingJql`, `getJiraIssue`,
  `addCommentToJiraIssue`, `editJiraIssue`, `atlassianUserInfo`; each takes a
  `cloudId`). What is not known: whether a label takes a `:`, and the fields of
  `atlassianUserInfo`.
- `docs/trackers/asana.md`: what Asana's MCP server (V2, `https://mcp.asana.com/v2/mcp`)
  can and cannot do for the factory, from its documents of 2026-11-04. It needs a
  registered "MCP app" before a person can sign in. Its documented tools read tasks
  by tag (`get_tasks`), read a task and its comments (`get_task`,
  `get_task_stories`), add a comment (`add_comment`), complete a task
  (`update_tasks`) and name the person (`get_me`). No documented tool adds or
  removes a tag, or attaches a link. So on Asana only `done` and `rejected` can be
  written (both complete the task), `in-progress` and `needs-human` are comments
  only, and a rejected task must lose its tag by a person's hand or be completed.
  The names of the arguments are not in Asana's documents (the server's `tools/list`
  has them), so the page gives a mapping with the unknown names marked, and tells
  the person to fill them from `/mcp`.
- The README: a short "Other trackers" section that links the three pages, and the
  approval of an MCP tracker.

## 11. Left to the builder

- File and function names; the exact form of an approval line; the wording of every
  message, within the plain style of the others.
- The limits not named here (the cut of each text field, the time limit of a call
  within the hook's budget).
- How `scan` carries its note, and how `toolOf` in `hooks/commands.ts` names an MCP
  tracker in a failure text.

## 12. Not in this phase

- Moving the repo to another GitHub owner, and the author's name in the manifest
  (the owner asked on 2026-11-13; it waits for the new owner's exact name).
- A built-in kind for any tracker that someone later tests for real: a tested
  mapping can become a named preset then.
