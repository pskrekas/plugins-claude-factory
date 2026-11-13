# A tracker through its MCP server

With `"kind": "mcp"` the factory works with any tracker whose MCP server you connected in Claude Code. The settings file names the server and, for each action of the line, the tool to call, its arguments, and where the fields of the answer are. The plugin holds no code for any one tracker, and no login.

Two worked examples: [Jira](jira.md) and [Asana](asana.md). Neither was tested.

## Before you start

- Connect the tracker's server with `/mcp`, and sign in there. The plugin stores no login and no token: every call uses the sign-in of the server you connected.
- Note the server's name as `/mcp` (or `claude mcp list`) shows it. The settings name the server with exactly that name.
- Find the names of the server's tools and their arguments. `/mcp` lists the tools of a connected server. You can also ask Claude in the chat which tools the server has.
- A server that a plugin brings (`plugin:<plugin>:<server>`) cannot be named: a `:` is not allowed in a server name. A claude.ai connector is listed as `claude.ai <Name>`; use that name. (A connector was not tried yet.)

## An example

For an imagined tracker. Every name in it is the tracker's own, not the plugin's.

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

The queue is the open tasks with the label `factory`. The line reads a task with `get_task`, writes a comment with `add_comment`, and moves the task through its steps with `set_step`. The pull request is linked with `link_code`.

## The keys

| Key | Needed | What it is |
| --- | --- | --- |
| `server` | yes | The MCP server, as `/mcp` names it. Letters, digits, space, `.`, `_` and `-`, at most 100, with a letter or a digit first and last. The plugin's own server (`factory`, in any spelling) is refused. |
| `mark` | no (`factory`) | The label that lets an item into the line. Letters, digits, space, `:`, `_` and `-`, at most 50. Only you put it on an item. |
| `url` | no | The address of an item, with `{id}` once (`https://` only, at most 300 characters, no space). Without it an item has no address. |
| `list` | yes | The queue: marked, open, and not taken. `rows` is the field that holds the list of rows. `id` and `title` are fields of a row; `state` is optional. |
| `claimed` | no | The items the tracker says are in progress. The same shape as `list`. Without it, none. |
| `read` | yes | One item. `title` and `text` are needed. `author`, `state`, `labels`, `url` (a field that holds the item's address; it is used before the `url` key) and the three comment keys `comments`, `commentAuthor` and `commentText` are optional. The three comment keys go together: all three or none. |
| `comments` | no | A second call for the comments, for a tracker whose read does not give them: `tool`, `args`, `rows`, `author`, `text`. When it is there, the comments of `read`'s answer are not used. |
| `comment` | yes | Writes a comment. Uses `{text}`. |
| `states` | yes | How a state is set. See "The four states". |
| `linkPr` | no | Links the pull request to the item. Uses `{url}`. Without it, the plugin writes a comment `Pull request: <address>`. |
| `me` | no | Who runs the line, as the tracker names an author. `name` is the field of the answer. Without it the plugin does not know you, and your own comments on an item reach no agent. |

Each call has `tool` (the tool's name, with the same rule as `server`) and `args` (left out: `{}`). A key that is not in this table is an error, so a mistyped `linkPR` is not ignored. `project` is accepted and not used.

A settings file that says `"kind": "jira"` or `"kind": "asana"` is refused with `use kind mcp: see docs/trackers`.

## Arguments and placeholders

`args` is JSON: objects, lists, text, numbers, `true`, `false` and `null`. The plugin sends it as it is, after it puts in the values of six placeholders:

| Placeholder | The value | Where it may stand | In which calls |
| --- | --- | --- | --- |
| `{mark}` | The mark. | Alone, or inside a longer text. | All. |
| `{id}` | The item's id. | Alone, or inside a longer text. | All but `list`, `claimed` and `me`. |
| `{text}` | A comment's text. | Alone only. | `comment`. |
| `{url}` | The pull request's address. | Alone only. | `linkPr`. |
| `{labels}` | The item's new list of labels. | Alone only. | `states.labels`. |
| `{state}` | `in-progress`, `needs-human`, `done` or `rejected`. | Alone, or inside a longer text. | A step of `states`. |

- "Alone" means the whole JSON value is the placeholder. The value then keeps its type: `{labels}` becomes a list of texts.
- `{text}` and `{url}` never stand inside a longer text. Text from outside is never mixed into a query of the tracker.
- `{mark}` and `{id}` may, because each passes a rule first. The mark is yours, and it holds no quote. An id must match `^[A-Za-z0-9][A-Za-z0-9_.#-]{0,63}$`: a row whose id does not match is no item, and an id you type (`/factory run PROJ-12`) passes the same rule.
- A placeholder is never read in a key, in `tool` or in `server`. A `{name}` that is not one of the six is an error.
- `{id}` is always sent as text.
- Limits: the `args` of one call are at most 1,000 characters as compact JSON, and four levels deep. No control character, anywhere.

## How an answer is read

- **The data.** It is the answer's `structuredContent` when that is an object. Otherwise it is the first text block, read as JSON. Otherwise the call failed (`<tool>: the answer is not JSON`). A text answer over 1 MB failed.
- **A write** (`comment`, a step of `states`, `linkPr`) passed when the server did not say `isError: true`. Many servers answer a write with a plain sentence, so the text is not read.
- **A failure.** `isError: true` is a failure. Its reason is the first line of the first text block, as `<tool>: <reason>`, at most 200 characters.
- **A field name** is dotted (`fields.summary`): one to six parts of letters, digits and `_`. No index and no wildcard. A part may not be `__proto__`, `constructor` or `prototype`. A part that meets a list, or a missing part, gives "not there".
- **Rows.** `rows` must end at a list (`<tool>: the answer holds no list of rows`). Without `rows`, the answer itself must be the list.
- **An id** is a text, or a whole number that JSON holds exactly (it is read as its digits).
- **An item.** A row with no id, or with no title, is no item. A value that is not text where text is expected is "not there".
- **Labels** are a list of texts, or a list of objects with a `name` text.
- **Comments.** A comment with no author or no text is skipped. Authors are compared with no regard to case.
- **Limits.** A queue is the first 200 rows of the answer. A title is cut to 300 characters, a text to 20,000, an author to 200. The comments read are the first 50 of the answer, in the answer's order, each cut to 5,000 characters. When a tracker gives the oldest comment first, an item with more than 50 comments loses its newest ones: use the separate `comments` call, with the tool's own order or limit argument when it has one.
- **It fails closed.** A queue that cannot be read is no queue: the panel shows the reason and `/factory run` does not start. A claimed list that cannot be read is empty, and the queue stays as it is. An item that cannot be read, or whose comments cannot be read, is not started: its author may have answered a question there.

## The four states

The line sets four states: `in-progress`, `needs-human`, `done` and `rejected`. `states` has one of two forms.

**Calls.** One entry for each state: a list of one to four steps, run in order. A step that fails stops the move, and the move failed. A step with `"optional": true` may fail: the next step runs, and the move did not fail. A state with no entry calls nothing. A step takes no `{text}`: a tracker whose move needs a reason is not served.

**Labels.** For a tracker where a state is a label, and the labels are written as the whole list:

```json
"states": {
  "labels": {
    "tool": "edit_item",
    "args": { "key": "{id}", "fields": { "labels": "{labels}" } }
  }
}
```

The plugin reads the item (`read` must have `labels`), takes away the four state labels, adds `<mark>:<state>`, and writes the list. The names are the same as on GitHub and Azure Boards. `"names"` beside `tool` gives other names for the four, for a tracker that takes no `:` in a label: all four, each letters, digits, space, `:`, `_` and `-`, at most 50. The read and the write are two calls: a label that someone changes in the moment between them is written over.

In the labels form, your `list` call must leave out the items that carry a state label, and `claimed` asks for `<mark>:in-progress`. Only the tracker's own query can do that in one call, so it is the settings' work. The [Jira example](jira.md) shows it.

**Does an item carry the mark?** With `read.labels`, the plugin looks for the mark among the item's labels. Without it, the item must be a row of `list` or of `claimed`.

## The approval

**Every call is a line.** The pane shows each call of the settings as one line, whole, and `/factory approve` allows the lines, as for a gate command. The example above gives twelve lines:

```text
[tracker] mcp tasks · list: find_tasks {"label":"{mark}","states":["open"]} → rows=tasks id=id title=title state=state
[tracker] mcp tasks · claimed: find_tasks {"label":"{mark}","states":["doing"]} → rows=tasks id=id title=title state=state
[tracker] mcp tasks · read: get_task {"task_id":"{id}"} → title=title text=description author=made_by state=state labels=labels comments=comments commentAuthor=by commentText=text
[tracker] mcp tasks · comment: add_comment {"task_id":"{id}","text":"{text}"}
[tracker] mcp tasks · state in-progress 1/1: set_step {"step":"doing","task_id":"{id}"}
[tracker] mcp tasks · state needs-human 1/1 (optional): set_step {"step":"review","task_id":"{id}"}
[tracker] mcp tasks · state done 1/1: set_step {"step":"done","task_id":"{id}"}
[tracker] mcp tasks · state rejected 1/1: cancel_task {"task_id":"{id}"}
[tracker] mcp tasks · linkPr: link_code {"ref":"{url}","task_id":"{id}"}
[tracker] mcp tasks · me: who_am_i {} → name=name
[tracker] mcp tasks · url: https://tracker.example.com/tasks/{id}
[tracker] mcp tasks · mark: factory
```

The JSON in a line is compact, with its keys sorted. A character of an argument that is not plain ASCII shows as `\uXXXX`, so nothing can hide in a line. The pane wraps a long line and never cuts it: scroll to the last line before you approve.

**Any change needs a new approval.** A new server, tool, argument, field name, `optional`, `url` or mark is a new line. No call of the tracker runs while one of its lines is not approved: not a write, not a read, not the panel's queue. The pane and `/factory run` then say `The MCP tracker's calls are not approved. Read them in the pane, then /factory approve.` A state, `linkPr` or `me` that you remove from approved settings shows no new line: the lines that are left are all approved, and the plugin stops making that call.

**Why.** A call through an MCP server asks you nothing, and it acts with your own sign-in. A settings file arrives with a clone. `/factory approve` is the only thing between that file and your sign-in. Read each line as a call that the plugin will make in your name.

## `/factory tracker`

`/factory tracker` reads the tracker and says what the plugin understood. It never writes. It reads the queue, `me`, and the first item of the queue whose id passes the id rule, with its comments, then whether it carries the mark. `/factory tracker PROJ-12` reads that item instead. With an empty queue, or a queue that could not be read, a plain `/factory tracker` reads no item. Use it after each change of the settings.

Its answer goes to the chat, so it holds no text of the tracker: no title, no author, no state, no address. It prints counts, ids, and for each field `found` or `not there`:

```text
Tracker: mcp
Queue: 4 items (PROJ-12, PROJ-14, PROJ-15). Claimed: 1.
Me: read.
PROJ-12: title found (15 characters) · text found (18 characters) · author found · state found · address found
PROJ-12: carries the mark: yes · 4 comments (2 of the author or the runner)
```

- The queue line names at most three ids. The two item lines are for the first item of the queue, or for the id you gave.
- `Queue: 0 items. Nothing to read. Is the mark right?` A label filter that names no known label often answers an empty list, not an error.
- `Queue: not read (<reason>)`: the reason of the failed call.
- `Me: not known.`: no `me` in the settings, or its field was not there.
- `PROJ-12: not read.`: the read failed, the title was not there, or the comments could not be read.
- The comments it counts as "of the author or the runner" are the ones an agent reads.
- With lines that are not approved, it says so and calls nothing.

## When it fails

- `The MCP server <name> did not answer. Connect it with /mcp, or check the tool names in the settings.` The server is not connected, it needs a sign-in, or a tool name is wrong. These look alike to the plugin. Look in `/mcp`, then check the names. A write that fails this way says `<tool>: no such tool on a connected server`.
- `The MCP server <name> did not answer in time.` Each call has a time limit.
- `<tool>: <reason>`: the server refused the call. The reason is the server's own first line.
- `<tool>: not sent (a value broke a rule)`: an id or an address did not pass its rule, so nothing was sent.
- **At the start of a session** the servers are not connected yet, and the plugin cannot call one. The panel's queue appears at its first refresh after that (the pane reads again once a minute, and `/factory` reads at once).

## What it cannot do

- **More than the first page.** A queue is the first 200 rows of one answer. Put a limit or a page size in `args` if the tool takes one.
- **An id as a number.** `{id}` is sent as text. A tool that wants a number for an id is not served.
- **A state with text.** A step of `states` takes no `{text}`. A tracker whose state change needs a reason is not served.
- **An error that says it is not one.** A server that answers a failed write with `isError: false` and an error sentence counts as a success. The plugin does not read the text of a write.
- **Tell two people with one name apart.** An author is what its field holds. When that is a display name, two people with the same name read as one author, and both of their comments reach an agent. Choose a field with an id or an email when the tracker has one, for `author`, `commentAuthor` and `me` alike.
- **A server that a plugin brings.** Its name holds a `:`.
- **`/factory init`.** It drafts settings for GitHub and Azure Boards only. Write an MCP tracker's settings by hand.
- **A pull request host through MCP.** The code is still on GitHub or Azure Repos, read from the remote.
