# Phase 4 (a tracker through its MCP server): decisions

Plan: `docs/superpowers/plans/2026-11-13-phase-4-mcp-tracker.md`. Design:
`docs/superpowers/specs/2026-11-13-phase-4-mcp-tracker-design.md`. Built on branch
`phase-4-mcp-tracker` (on top of `phase-3-azure-devops`), 2026-11-13. 573 tests. A
reviewer read each task, and an automated security review read the commits as they
came. The final review of the whole branch found what its fix wave changed: see "The
final review's fix wave" below.

## The decision that shaped the work

**The owner chose to build only the general `mcp` kind.** `tracker.kind: "mcp"` names
one MCP server and, for each action of the tracker contract, a tool, its arguments and
where the answer's fields are. Jira and Asana are example pages (`docs/trackers/jira.md`,
`docs/trackers/asana.md`) that nobody ran; each says so. So:

- The five actions were run by hand on the owner's own MCP tracker, on one test item
  that was cancelled at the end. That showed the shape of the answers before the design
  (`docs/notes/r3-check.md`, "The five actions, by hand").
- The engine check ran a throw-away mod, headless, and made reads only
  (`docs/notes/r3-check.md`). It showed that `$.mcp.call` works from the hooks the line
  runs in, that every failure to find a tool reads alike, and that the call can reach
  the plugin's own shell tool.
- On 2026-11-13 the owner's real settings were parsed by the plugin's parser, and the
  adapter was run against the recorded answers of the real tracker. It read them and
  sent the expected calls. No live session was used.
- **The live run was done by the owner on 2026-11-13**, after the merge: `/factory`,
  `/factory approve` and `/factory tracker <id of a test item>` in a real session on the
  real tracker (`docs/notes/r3-check.md`, "The live run, by a person"). Nothing differed
  from what the adapter expected. Goal G4 of the design (proven on a real engine and a
  real MCP tracker) is met for reading. No write was made in a live session: a full run
  of the line on a real MCP tracker is still a hand check (`docs/notes/r1-check.md`,
  "An MCP tracker, by hand").

## Decisions made while building

Each says what it costs if it is wrong.

1. **Only the first 200 rows of an answer are the queue.** Bad rows are dropped after
   the cut, as the design words it. Cost: a queue can show fewer than 200 when rows are
   bad.
2. **The count of labels is left out of `/factory tracker`.** The contract has no labels
   and G3 keeps the contract; `carries the mark` covers the need. Cost: a person does not
   see how many labels an item has.
3. **A server that does not answer gets one note.** "The MCP server `<name>` did not
   answer. Connect it with /mcp, or check the tool names in the settings." A wrong tool
   name and a missing server reject alike in the engine, so one sentence covers both.
   Cost: a longer note than the design's sentence, and no way to say which one it was.
4. **The mark has its own line to approve:** `[tracker] mcp <server> · mark: <mark>`
   (`mcpLines(spec, mark)`). The mark is filled into approved calls, so it is part of what
   a person approves. The design said "the whole action" and did not list it. Cost: one
   more line to read (12 for the example).
5. **The plugin's own server cannot be named in any spelling.** A settings file that
   names `factory`, or a spelling of it, is refused. The engine check showed that
   `$.mcp.call('factory', 'sh')` reaches the plugin's own shell tool. Cost: none that
   a real tracker meets.
6. **A field name may not be `__proto__`, `constructor` or `prototype`.** This is the
   approval boundary, and it fails closed. Cost: a tracker field with such a name cannot
   be mapped. None is known.
7. **The three comment keys of `read` go together.** The parser refuses a settings file
   that sets one or two of `comments`, `commentAuthor` and `commentText`, and the reader
   answers no item for a half-set trio. An item whose comments cannot be read is not
   started. Cost: a file with one of the three keys is refused where it parsed before.
   None existed.
8. **`/factory tracker` reads the first item of the queue** when it gets no id, and the
   item named by the id when it gets one. The first version read no item; the controller
   found that against the design and reopened the task. Cost: one more read call on each
   run of the command.
9. **The fence denies every `mcp__*` tool for an agent of the line**, except the plugin's
   own shell tool. The pin test found that the fence answered nothing for a tool outside a
   role's list. Cost: an agent of the line can call no MCP tool of its own, which is the
   aim (A5).
10. **Task 7 is split.** The approval of a real session is a person's act, so the
    controller made the proof without a live session and left the live run to the owner.
    Cost: G4 waits for the owner.
11. **No plan review by the owner.** The owner agreed that the plan be written and built
    without coming back to them first. The design they approved binds the plan. Cost: a
    plan the owner did not read.

## The final review's fix wave

The final review of the whole branch found these; each was fixed with a test first.

12. **An item id is at most 40 characters** (`^[A-Za-z0-9][A-Za-z0-9_.#-]{0,39}$`). The
    line keeps 40 characters of an id, so a longer one was listed and read whole, then
    its comment, state and link went to the cut prefix: another item, if the prefix is
    one. Cost: a tracker with longer ids is not served.
13. **Labels that cannot be read are not written over.** One entry that is neither text
    nor an object with a `name` makes the labels unknown: the labels form sets no state,
    and the item does not carry the mark. Before, the entry was skipped, and the write of
    the whole list dropped it. Cost: such an item cannot be moved by the labels form.
14. **Fixed sentences where a command's answer would hold text of a settings file.** A
    place that the settings name and that is not approved: `The tracker's place is
    named by the settings file, not by the remote. Read its [tracker] line in the pane,
    then /factory approve.` A tracker that the parser refused: `The tracker in the
    settings file was refused. The pane's settings line says why.` The pane's
    `settings:` row is wrapped, never cut, and a key that a reason names is cleaned and
    cut to 40 characters. Cost: the reason is read in the pane, not in the chat.
15. **A field name is at most 200 characters in all.** The rule bounded the parts, not
    their length, so one name could make an approval line of any length. Cost: none
    that a real tracker meets.
16. **The contract gains one optional method, `why`:** the reason of the adapter's last
    failed reading call, as `scan().note` is. Only the MCP adapter gives one, in fixed
    words or a tool's own cut error line; `/factory tracker` prints it after `not read`
    and `Me: not known`. A pure `itemProblem` tells a missing title from a missing list
    of comments. Cost: a third change to the contract that G3 kept small.
17. **Each call must hold the placeholders it needs.** `read`, `comments`, `comment`,
    every step, `states.labels` and `linkPr` must hold `{id}`; `comment` `{text}`,
    `linkPr` `{url}`, `states.labels` `{labels}`. A call without them would act on no
    item, or on every item. Cost: a tracker whose tool takes the id in a way the
    settings cannot write is not served.
18. **The example's tool names changed** (`show_task`, `move_task` with a `to` argument,
    `attach_link`), so that the imagined tracker shares no tool name with the tracker the
    check ran on. History was not rewritten. Cost: none.
19. **Smaller fixes.** An address from an answer is printable ASCII only; the authors in an
    agent's `item.md` are quoted as the title is; the panel's note and the sentence under
    the lines to approve are wrapped, never cut; `/factory run` and `/factory plan` name
    `mcp` among the tracker kinds; the registered command names `tracker`.

## Known gaps

- **The labels form reads and writes in two calls.** A tracker that sets labels as a
  whole list is read, changed and written back. A label that a person changes in the
  moment between the two can be written over.
- **Authors are display names.** Two people with one display name read as one author, and
  no tool says who "me" is, so `me` is optional. The reference tells a person to map a
  field with an id or an email when the tracker has one.
- **The first 200 rows and the first 50 comments, in the answer's order.** A queue or a
  conversation longer than that is cut, and the cut follows the server's order.
- **`{id}` is always sent as text.** A tracker whose tool wants a number for an id is not
  served.
- **A state step takes no text.** A tracker whose move needs a reason is not served.
- **A server that answers an error with `isError: false`** reads as a success. The
  plugin trusts the flag.
- **A server that a plugin provides cannot be named.** Its name holds a `:`
  (`plugin:<plugin>:<server>`), which the settings refuse.
- **Each call may wait its whole time limit.** Several calls in one hook can add up. A
  hook may run into its own limit.
- **Jira and Asana were never run.** Their pages are examples with what is known and what
  is not.

## Small findings, not fixed

Found by the reviews and left for later. Each was true at the last review of its task.

- `core/mcp-tracker.ts` is about 720 lines (parser, filler, reader). Its split is the
  first commit of the next phase.
- `isPlain` is written twice (the core file and the adapter).
- `/factory tracker #7` and `/factory run #7` take a leading `#` differently.
- A call past its time limit may still complete on the server.
- The fence does not name `ListMcpResourcesTool` and `ReadMcpResourceTool`, and the spawn
  window's list does not either; the agent type's own tool list holds them out.
- Step reasons in a parse refusal repeat the path (`states.done: states.done[0].args: …`).
- A `server` that is not text gets the reason `is needed`.
- No cap on the count or the length of `{labels}` in a fill, and `{state}` is not checked
  against the four states. Both come from the adapter.
- `setState` has a guard that throws `not an item id`; the design's wording is that the
  item could not be read. Nothing is called either way.
- Two tests (`tests/mcp-tracker.test.ts`) assert `.rejects.toThrow()` with no message.
- If `$.clock.after` is refused, a call has no time limit.
- `resultOf` and `rejectedOf` live in the adapter; a small file of their own would split
  them.
- `me` is lower-cased and cut but not passed through `clean` (it fails closed).
- No test counts the `read` calls of `/factory tracker`.
- A tool's error text (200 characters at most, cleaned) from the tracker's server reaches
  the answer of `/factory tracker` (`Queue: not read (…)`, `not read (…)`). The final
  review weighed it against A6 and kept it.
- Tools that are not `mcp__*` and are outside a role's list (`WebFetch`, `NotebookEdit`,
  `Agent`) still get no answer from the fence and rely on the agent type's own list. The
  spawn window's `FENCED_TOOLS` does not hold `mcp__*`. No engine-level `tool.check` test
  covers the new `mcp__` deny.
- `dataOf` takes a `structuredContent` object with no size limit; the 1 MB limit is on
  the text block only.

## Not checked

- Whether a person can scroll the pane to the last line of a long list of lines to
  approve. In the live run the pane showed 5 of 11 lines.
- The writes in a live session: `/factory run`, a comment, the states, the pull request
  link and `/factory reject` have been run by hand and against recorded answers only.
- A call on a claude.ai connector (the two spellings of its name are from the types only).
- A real tool name on a server that needs a sign-in, and whether the call would start one.
- A person-facing session: how long its servers take to connect, and whether anything
  asks the person for a plugin's call.
- A server that drops or hangs in the middle of a call, and a very large answer.
- A server that disconnects during a session and comes back.
- Jira's and Asana's servers.
