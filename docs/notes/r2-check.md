# R2 check (design section 12): what a mod can do with agents

Checked on 2026-11-12 with Claude Code 2.1.322, in a headless session (`claude -p`) with a
throw-away mod, a scratch git repo and a worktree. Two runs, small agents on the fast model.

## What was asked, and the answer

| Question | Answer |
|---|---|
| Can the plugin start an agent of a type it registered? | Yes. `$.agent.register` then `$.agent.spawn({ subagentType })` answers `{ model, agentId }` at once. The model alias in the registration is used. |
| Can a hook wait for the agent to finish? | **No.** A hook has a budget of 10 seconds of its own time. A hook that waits on a promise of its own is dropped ("ran past its 10s budget"). A `$` call in flight does not count. |
| How does the plugin learn that an agent finished? | The `turn.complete` event, with `agentId`, `answer` (the agent's last text), `durationMs` and `usage` (input, output and cache token counts, and the model). It fires for agents the plugin started from a hook that already returned. |
| Can an agent run in its own folder (a job's worktree)? | **Yes, in one way only.** `cwd` given to `$.agent.spawn` is ignored (the agent ran in the session's folder, for a folder inside and outside the repo). A hook on the `agent.spawn` event that answers `next({ ...e, cwd })` works: the agent's shell and files are in that folder. Telling the agent to `cd` works too. |
| Can the plugin let its agents run commands with no question to the person? | Yes. A `tool.check` hook gets every call of an agent with its `agentId`, and its `{ decision: 'allow' }` runs the call; core alone had answered `ask`. |
| Can the plugin refuse a command of an agent? | Yes. `{ decision: 'deny', reason }` from the same hook; the agent reads the reason and goes on. |
| Must the fence answer for every tool? | **No, and it must not.** An `allow` for the agent's hand-back tool (`SubagentHandback`) is refused by the engine ("Only the auto-mode classifier can allow"). The fence answers only for the tools it names and passes every other verdict through. The agent's answer still arrives in `turn.complete`. |
| Does the plugin see an agent's tool calls? | Only at `tool.check`. Its `tool.call` hook did not hear the calls of agents it started. Refused commands are counted at `tool.check`. |
| Does `$.fs.write` make missing folders? | Yes. |
| Does `env.PATH` given to `$.process.run` govern where the program is found? | Yes. With a `PATH` that has no `git`, `git` is not found. |
| What does a missing program look like? | A rejection: `… failed to start: ENOENT: Executable not found in $PATH: "<name>"`. |
| Can `$` be passed to a function? | To a function declared at the top of a file of the mod, yes. To a method of an object or a closure, no. |

## What this means for the factory

- The line is **driven by events and a timer**, never by a hook that waits: a command or a
  timer starts a station and returns; `turn.complete` records the agent's answer; the next
  tick moves the job.
- A job's agents get their folder from the plugin's own `agent.spawn` hook.
- The fence is a `tool.check` hook with a list of tools per role; it never answers for a tool
  that is not on the list.
- Cost per job is the sum of the `usage` of its agents' `turn.complete` events.

## Not checked

- An agent that runs for many minutes, and what happens to it when the session ends.
- A person-facing session (not headless): whether anything asks the person despite the fence.
- Whether two terminals that resume one session have one session id.
