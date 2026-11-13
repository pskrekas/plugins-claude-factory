# R3 check: a tracker's MCP tools, called from the plugin

Checked on 2026-11-13 with Claude Code 2.1.323 (the mod API types of 2.1.322: the
types that come with the tool are one patch older than the program that ran), headless
(`claude -p`, the fast model), with a throw-away mod and an MCP tracker of the owner's
(an HTTP server the person added; `tasks` in the examples below). On the tracker only
reading tools were called. No other connected server was called. It follows
`r2c-check.md`.

The mod declared `/r3 <point>`. Its `command.run` hook called `$.mcp.call(server, tool,
args)` and wrote what came back to a file with `$.fs`: the keys of the result,
`isError`, the kind and length of each content block, the milliseconds, or the
rejection's text. A `turn.complete` hook, a `$.clock.after` timer and a `$.clock.every`
timer (both set in `session.start`) made the same reading call once each.

## What was asked, and the answer

| Question | Answer |
|---|---|
| 1. Does `$.mcp.call` work from the hooks the line runs in, on a server the person connected? | **Yes**, from a `command.run` hook, a `turn.complete` hook, a `$.clock.after` callback and a `$.clock.every` callback (the timers were set in `session.start`, whose hook had returned). **Not in `session.start` itself**: there no server is connected yet, and the call rejects at once (below). It does not dial the server or wait for it. In the headless run the tracker's tools were there about 0.6 s after the start (a `$.clock.every` of 250 ms failed once, then answered). |
| 2. What does the result hold for a tool that answers JSON? | `{ content, isError }` and nothing else: **no `structuredContent`**. One block, `{ type: 'text', text }`, the text being the JSON (`{"labels":[…],…}` for the label list; `{"tasks":[…],"more":true}` for a list of one task). |
| 3a. A server name that does not exist? | **Rejects** (a `HooksError`, its only own key `name`), in 1 to 3 ms: `<plugin>: $.mcp.call: no connected MCP tool "no_such_tool" on a server named "no-such-server"`. |
| 3b. A server that is configured but not connected yet (the call in `session.start`)? | **Rejects**, the same text: `<plugin>: $.mcp.call: no connected MCP tool "<a tool that lists labels>" on a server named "tasks"`. |
| 3c. A server that `claude mcp list` shows as "Needs authentication"? | **Rejects**, the same text: `… no connected MCP tool "no_such_tool" on a server named "<server>"`. Such a server lists no tools in the session, so every name is unknown there. (Only a made-up tool name was tried on it.) |
| 3d. A tool name that does not exist, on the tracker? | **Rejects**, the same text: `<plugin>: $.mcp.call: no connected MCP tool "no_such_tool" on a server named "tasks"`. The engine checks the name against the session's tool list before anything goes to the server. |
| 3e. A known tool with a wrong argument (`limit: "many"`)? | **Resolves** with `isError: true` and one text block, the server's own sentence: `Error executing tool <a tool that lists tasks>: 1 validation error for <the tool's own schema name>` / `limit` / `Input should be a valid integer, unable to parse string as an integer [type=int_parsing, input_value='many', input_type=str]` / a link to the validation library's page. |
| 4. How long does a call take? | 78 to 102 ms for an answer from the tracker (six calls); 0 to 3 ms for a rejection. A hook has 10 s (and more while a `$` call is in flight, `r2b-check.md`). |
| 5. The server's name as the call takes it? | The person's own server: the name `claude mcp list` shows (`tasks`), the same as in its tools' names (`mcp__tasks__<tool>`); a `-` in it stays. A claude.ai connector: listed as `claude.ai <Name>`, its tools as `mcp__claude_ai_<Name>__…`; the types say the call takes either spelling (not called: no other server was). A plugin's server: `plugin:<plugin>:<server>`, its tools `mcp__plugin_<plugin>_<server>__…`. A tool a plugin registers with `$.tool.register`: the server is the plugin's name (`factory`). |
| 6. Does `$.mcp.call('factory', 'sh', { command: 'true' })` reach the plugin's own tool? | **Yes.** With the factory loaded beside the mod, the server `factory` reached the factory's own `tool.call` hook, which refused it (no `agentId`, so not a builder), and the call **rejected**: `<plugin>: $.mcp.call(factory, sh) refused: This tool is for the builder of the factory line.` The names `plugin:factory:factory` and `cc-plugin-factory` reject as unknown (`no connected MCP tool "sh" on a server named …`). |

## What this means for the factory

- **The data is the text block.** The adapter parses the JSON of the first `text` block.
  It may take `structuredContent` first when a server gives one, but the owner's tracker
  gives none.
- **Two ways to fail, both to handle.** A rejection says the tool is not in the session:
  a wrong server name, a wrong tool name, a server not connected yet, or a server that
  needs a sign-in. Its text cannot tell these apart, and it starts with the calling
  plugin's name. The adapter shows the server and tool names it asked for and tells the
  person to check `/mcp` (connected, signed in) and the names in the settings. An answer
  with `isError: true` is the server's own refusal (a wrong argument, a rule of the
  tracker): its text block is the sentence to show, cut to a short length.
- **A rejection is not a broken tracker.** At a session's start the servers are not
  connected yet, and the call does not wait for them. The adapter never calls the
  tracker in `session.start`; a call that rejects is tried again at the next command,
  end of a turn or timer, and the first one rejects quietly.
- **The hooks of the line can all call it**: a command, the end of a turn, the panel's
  timer. So the panel's refresh can read the queue on its timer.
- **Time is not a limit.** A call takes about a tenth of a second. A time limit in the
  adapter (a few seconds) only guards against a server that hangs.
- **The server name is the one `/mcp` and `claude mcp list` show.** The settings carry it
  as the person sees it.
- **The adapter must refuse the server `factory` itself**: the call reaches the plugin's
  own shell tool, and only the shell hook's check of the builder stopped it here.

## The five actions, by hand

The five actions were run by hand on the owner's tracker before the design, on one test
item that was cancelled at the end (design 9.1). What it showed:

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

## The adapter against the recorded answers

On 2026-11-13 the owner's real settings for the tracker were parsed by the plugin's
own parser, and the adapter was run against the answers the real tracker gave when the
five actions were done by hand that day: a list, an item with its author, and a comment.
The settings parsed. They give 11 lines of calls plus the line of the mark. The adapter
read the queue row, and the item's title, text, author, state, address and comment.
`hasMark` answered true for a label of the item. The adapter also sent the expected calls
for in-progress, a comment, a pull request link and rejected. This ran as a throw-away
test that was deleted and never committed. It used no live session and called no tool.
So it proves the parser and the adapter against the real answers, and it proves nothing
about a live session or the approval.

## Still owed by a person

The live run of `/factory tracker` on the real tracker is open. An approval is a person's
own act at the prompt, so a headless run cannot give it, and nobody may write the approval
store for the person. To do:

1. Open a scratch repository outside this one, with the owner's settings in
   `.claude/factory.json`, and load the plugin from this branch:
   `claude --plugin-dir <this repo>/factory`.
2. `/factory`. Read each line of the pane, to the last one.
3. `/factory approve`.
4. `/factory tracker`, then `/factory tracker <id of a test item>`. The calls only read.
5. Write the answer's lines here, with every id replaced by `PROJ-n`, and say what
   differed from what the adapter expected. Fix what differed, with a test.

Answer of `/factory tracker`: (not recorded yet)

Answer of `/factory tracker <id>`: (not recorded yet)

## Not checked

- A call on a claude.ai connector (no other server was called), so the two spellings of
  its name are from the types only.
- A real tool name on a server that needs a sign-in (whether the call would start one).
- A person-facing session: how long its servers take to connect, and whether anything
  asks the person for a plugin's call.
- A server that drops or hangs in the middle of a call, and a very large answer.
- A server that disconnects during a session and comes back.
