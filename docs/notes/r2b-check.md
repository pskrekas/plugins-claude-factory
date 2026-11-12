# R2b check: where a mod may start an agent from, and what happens when it ends

Checked on 2026-11-12 with Claude Code 2.1.322, headless (`claude -p`), with a throw-away
mod, a scratch git repo and small agents on the fast model. It follows `r2-check.md`.

## What was asked, and the answer

| Question | Answer |
|---|---|
| Can a timer callback (`$.clock.every`) start an agent? | **It can, and it must not.** The agent starts and its `turn.complete` arrives. But the plugin's own `agent.spawn` hook and `tool.check` hook do **not** run for it: the agent ran in the session's folder, and its shell commands ran with no check at all. The `$` of a hook that already returned reaches the engine under the plugin's hooks. |
| Does the plugin's own `clock.every` hook run for its own timer? | No. A timer gives no hook to start an agent from. |
| From where is an agent fenced? | From a **hook that has not returned yet**: `prompt.submit`, `tool.call` (R2), and `turn.complete` were tried. The `agent.spawn` hook set the folder, and `tool.check` saw every call with the `agentId`. |
| Can a hook work for longer than its 10 seconds? | Yes, while a `$` call is in flight. A `turn.complete` hook awaited a 40-second `$.process.run`, was not dropped, and then started an agent that was fenced. A timer callback awaited a 60-second run too, and later periods fired while it waited. |
| Does a long agent report? | An agent of 94 seconds gave `turn.complete` with `usage` (token counts and the model id). Three minutes was not reached: Claude Code refuses a foreground `sleep` in an agent's shell. |
| What is in `$.agent.list()` after `turn.complete`? | The agent, with `status: "completed"`. |
| What happens in the session when an agent ends? | Its report is a **new prompt for the session's model** (`prompt.submit`, `origin.kind` `peer`, text `<agent-message from="<agentId>">…`). The model reads it and answers. |
| Can the plugin keep that prompt from the model? | Yes. A `prompt.submit` hook that answers `{ drop: "<reason>" }` for it: the model heard nothing, and the agent's `turn.complete` answer was unchanged (`DONE`). |
| Can the fence refuse the hand-back instead? | It stops the prompt too, but the agent then tries again and ends with other text as its answer. Not used. |
| Can an agent type require the shell sandbox? | No field of the agent spec does it (`tools`, `disallowedTools`, `model`, `effort`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, …). |
| Is the model kept from seeing the plugin's agent types (`agent.offer`)? | Not checked again; done as in R2 (`{ isOffered: false }` for each type). |

## What this means for the factory

- **An agent is started only from a hook that is still running**: the hook of `/factory run`,
  of `/factory answer`, and the `turn.complete` hook of a factory agent that just ended.
  Never from a timer. The plan's "tick on a timer" is replaced by a function that advances
  the jobs and is called in those hooks.
- **The gate runs inside such a hook** (its commands are `$.process.run` calls in flight).
  One hook advances the jobs at a time; while it runs a gate, the other jobs wait.
- **The timer starts nothing.** It keeps the lock alive, sees a merged pull request, and
  sees an agent that is gone or too slow. For such an agent it cannot start another one: the
  job stops and asks, and `/factory answer <id>` starts the station again.
- **The plugin checks that its fence saw each agent it started.** The `agent.spawn` hook
  notes every spawn it sees; a spawn it did not see stops the line and tells the person.
- **The plugin drops the report prompt of its own agents**, so the session's model is not
  woken at every station and never reads text that an agent wrote.
- A builder must not use `sleep` in the foreground.

## A mistake made in the check, kept as a warning

A `prompt.submit` hook that starts an agent with no guard loops: each agent's report is a
prompt, which started the next agent. About thirty small agents ran before it was stopped.
The factory starts no agent from `prompt.submit`.

## Not checked

- A person-facing session (not headless): whether anything asks the person despite the fence.
- What happens to a running agent when the session ends.
- An agent that runs for many minutes.
