# R2c check: can the builder's shell be somewhere else than the person's machine?

Checked on 2026-11-12 with Claude Code 2.1.322, headless (`claude -p`), with a throw-away
mod, two small agents on the fast model, and Docker Desktop 29.5.3. It follows
`r2-check.md` and `r2b-check.md`.

## What was asked, and the answer

| Question | Answer |
|---|---|
| Can an agent call a tool that the plugin itself provides? | Yes. `$.tool.register({ name: 'sh', … })` gives `mcp__<plugin>__sh`. An agent type whose `tools` list holds only that name can call it. |
| Who answers that call? | The plugin's own `tool.call` hook. It gets the tool's arguments at the top of the event (`e.command`, not `e.input.command`), the `agentId`, and it answers `{ result: <text> }`. |
| Can the hook run the command in a container? | Yes. The hook ran `docker run --rm --network none … sh -c <command>` through `$.process.run` and gave the output back. The command saw a Debian system, the user `root`, no `/Users` folder. |
| Does `tool.check` come first for such a tool? | Yes, with the `agentId`; core says `ask`, the plugin's `allow` runs the call. |
| Does the plugin's `tool.call` hook see an agent's `Bash` call? | Yes (for an agent started from a running hook). `r2-check.md` said no; that was wrong. |
| Can the hook rewrite an agent's `Bash` call into a container call? | Not tried in a way that works, and not needed: a builder with no `Bash` at all is the stronger form. |
| Can the plugin fetch an image? | `docker pull` did not answer on the machine of the check. The plugin does not fetch images: the person does. |

## What this means for the factory

- The builder gets no `Bash`. It gets the plugin's shell tool, and the plugin runs each
  command with `docker exec` in the job's own container. The command text is one
  argument of `sh -c` inside the container: the person's machine never reads it as a
  command.
- The builder's file tools stay as they are: they work on the job's worktree on the
  person's machine, which is mounted into the container, and the fence holds them to
  the job by real path.
- The gate runs agent-written code too, so its commands run in a container as well.
- An agent's hand-back, its `tool.check` and its `turn.complete` are as in `r2b-check.md`.

## Not checked

- A command that runs for many minutes inside `docker exec` under a `tool.call` hook.
- Podman, or Docker on Linux (file ownership in the mounted folder).
