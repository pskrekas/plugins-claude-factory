# Asana, through Asana's MCP server

Not tested. Nobody ran this mapping against Asana.

This page says what Asana's MCP server can and cannot do for the factory. It is written from Asana's developer pages (developers.asana.com). The sign-in facts are from "Integrating with Asana's MCP server" (updated 2026-10-08) and "Using Asana's MCP server". The tools are from "MCP tools reference" (updated 2026-11-04). The documents name the tools, and only some of their arguments. The rest is in the server's own tool list, which you see in `/mcp` once you are connected.

The reference for every key is [mcp.md](mcp.md).

## The server

- The server is `https://mcp.asana.com/v2/mcp`, over streamable HTTP.
- It signs in with OAuth, through an "MCP app" that you register in Asana's developer console. The app gives a client id and a client secret. The server has no dynamic client registration, so a sign-in cannot start without them.
- Add the server to Claude Code as an HTTP server with that client id and secret, then sign in with `/mcp`. Note the name `/mcp` shows for it.
- A session of the server is for one workspace.

## The tools that exist

| Tool | What the documents say |
| --- | --- |
| `get_tasks` | Lists tasks by project, section, tag or user task list. `completed_since: "now"` gives only the open tasks. The name of the tag argument is not in the documents. |
| `get_task` | Reads one task. Its comments come with it by default (`include_comments`, `comment_limit`). |
| `get_task_stories` | Reads a task's stories (its comments and its history). |
| `add_comment` | Adds a comment. It takes exactly one of `text` or `html_text`. |
| `update_tasks` | Changes up to 50 tasks at once, their completion among other fields. |
| `get_me` | Names the person who is signed in. |
| `search_objects` | Finds an object by its name, a tag among them. |

## What cannot be written

No documented tool adds or removes a tag, moves a task to a section by its name, or attaches a link to a task. For the factory this means:

- **The mark is a tag** that you put on a task by hand. The plugin never adds or removes a tag.
- **`done` and `rejected`** can be written: both complete the task with `update_tasks`. A completed task leaves the queue.
- **`in-progress` and `needs-human`** cannot be written. They have no entry in `states`, so the plugin calls nothing for them. The line's own comments on the task say what happens (`The factory started on this.`, the pull request's address).
- **A rejected task** keeps its tag. It is out of the queue because it is completed. To put it back, open it again; to keep it out for good, take its tag away by hand.
- **No `claimed` list.** Asana cannot show that a task is in progress, so a task that the line works on stays in the queue. The machine that runs the line knows its own jobs and does not start one twice. A second machine would. Run the line from one machine.
- **The pull request is a comment**, because no tool attaches a link. There is no `linkPr`.

## A mapping, with names to fill

This is not a working file: fill the names from the server's own tool list.

Every value in angle brackets is a name to fill. `<from /mcp>` is a name that Asana's documents do not give: only the server's tool list (or one of its answers) gives it. The names that the documents give are filled in (`completed_since`, `include_comments`, `task_id` of `get_task_stories`, `text` of `add_comment`). The plugin refuses this file until each one is filled, because `<` is not allowed in a field name. An argument name left as `<from /mcp>` would pass the plugin's rules, and then every call would fail on the server.

```json
{
  "tracker": {
    "kind": "mcp",
    "mark": "factory",
    "server": "asana",
    "list": {
      "tool": "get_tasks",
      "args": { "<from /mcp: the tag argument>": "<the tag's id, from search_objects>", "completed_since": "now" },
      "rows": "<from /mcp>", "id": "<from /mcp>", "title": "<from /mcp>"
    },
    "read": {
      "tool": "get_task",
      "args": { "<from /mcp: the task argument>": "{id}", "include_comments": false },
      "title": "<from /mcp>", "text": "<from /mcp>", "author": "<from /mcp>", "labels": "<from /mcp>"
    },
    "comments": {
      "tool": "get_task_stories",
      "args": { "task_id": "{id}" },
      "rows": "<from /mcp>", "author": "<from /mcp>", "text": "<from /mcp>"
    },
    "comment": {
      "tool": "add_comment",
      "args": { "<from /mcp: the task argument>": "{id}", "text": "{text}" }
    },
    "states": {
      "done": [{ "tool": "update_tasks", "args": { "<from /mcp: the list of tasks>": [{ "<from /mcp: the task>": "{id}", "<from /mcp: completed>": true }] } }],
      "rejected": [{ "tool": "update_tasks", "args": { "<from /mcp: the list of tasks>": [{ "<from /mcp: the task>": "{id}", "<from /mcp: completed>": true }] } }]
    },
    "me": { "tool": "get_me", "args": {}, "name": "<from /mcp>" }
  }
}
```

Notes on the mapping:

- **The tag.** The mapping assumes that `get_tasks` wants the tag's id, not its name. Find the id with `search_objects` and write it in `args`. With a tag id there, the mark does not stand in the call, but the mark must still be the tag's name (the approval's `mark` line shows it): the plugin looks for the mark among the task's tags (`read.labels`) to know that a task carries it. A tag is read by its `name` when the answer gives tags as objects. If the tool takes the tag's name instead, write `"{mark}"` there.
- **The server** is named `asana` here. Use the name `/mcp` shows.
- **The comments.** `get_task_stories` gives the task's history too. A history entry with an author and a text reads as a comment of that person. To read only the comments, leave out `comments`, set `include_comments` to `true` (or leave it out), and give `read` the three comment keys instead.
- **The address.** There is no `url` key, so a task has no address in the pane. Add `url` with the address of a task in your workspace, with `{id}` in it, or `read.url` with a field of `get_task`'s answer that holds it.
- **The author.** Choose a field with a user id over a name when the answer has one, for `author`, the comments' `author` and `me` alike.
- Try it with `/factory tracker` and then `/factory tracker <a task's id>` before you run the line.
