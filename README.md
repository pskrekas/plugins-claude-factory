# Factory

**A Claude Code plugin that shows the state of your work in a docked panel.** A later version adds a software factory on top of it.

The panel answers four questions without a prompt: what is my task, how far is each build, what waits for me, and is my environment correct. It knows no project: a repo tells it what to show through one settings file, `.claude/factory.json`.

This is an early version. It has the panel only. The factory line (a marked tracker item goes through Intake, Spec, Build, Gate, Review and Approve, and comes out as a ready pull request that a person merges) is the next phase. The design is in [`docs/superpowers/specs`](docs/superpowers/specs).

## Install

Inside Claude Code (2.1.322 or later):

```
/plugin marketplace add pskrekas/plugins-claude-factory
/plugin install factory@plugins-claude-factory
/reload-plugins
/factory
```

Or load it from a clone, for one session:

```sh
git clone https://github.com/pskrekas/plugins-claude-factory
claude --plugin-dir ./plugins-claude-factory/factory
```

Mods are an early-access Claude Code feature and their API can change between releases.

## What you see

A section with nothing to show takes no room.

| Section | Shows | From |
| --- | --- | --- |
| **TASK** | the item of the current branch (id, title, state), its pull request, build state and approvals | the branch name matched by `ticketPattern`; `gh issue view`; `gh pr view` |
| **PROGRESS** | each long build: its name, its percent, and `BLOCKED: …` when a line says so. The eight newest files; the rest are counted | the progress files the settings name |
| **AGENTS** | the running subagents and how long each has run | the session's agent list |
| **CHECKS** | each environment check: `ok`, or the wrong value | the commands in the settings |
| **PORTS** | each local service: `up` or `DOWN` | `nc -z` on the ports in the settings |
| **MORE** | the number of worktrees and how many are merged; the number of open items in your owed list | `git`; the owed file |

The status line shows the task id, the first progress percent, the checks and a block. A toast and a short sound tell you when progress becomes blocked, a check turns wrong or a port goes down. At the start of a session the plugin adds a few lines to the system prompt (the ticket id, the branch, the progress percents, the owed count), so the session knows where you are. It builds them once and does not change them during the session.

## Use

| Command | Does |
| --- | --- |
| `/factory` | opens the pane and reads everything |
| `/factory close` | closes it |
| `/factory init` | looks at the repo and writes a first `.claude/factory.json`; it never overwrites one |
| `/factory approve` | opens the pane and allows the commands it shows (see below). Only your own Enter at the prompt counts |

While the pane is on screen it reads again once a minute.

Two options, in `/config`: `openOnStart` (open the pane when a session starts, off by default) and `sound` (the alert sound, on by default).

It works on macOS and Linux. It uses `df` and `nc`, which Windows does not have.

## Settings

One file per repo, `.claude/factory.json`. Every key is optional. With no file the panel shows the branch, its pull request, the agents and the worktrees.

```json
{
  "ticketPattern": "PROJ-\\d+",
  "tracker": { "kind": "github" },
  "baseBranch": "main",
  "progress": { "files": "docs/plans/*/progress.md" },
  "checks": [
    { "name": "cloud account", "run": ["cloud", "config", "get", "account"], "want": "me@example.com" },
    { "name": "disk", "minFreeGb": 10 }
  ],
  "ports": { "database": 5432 },
  "owed": ".claude/owed.md"
}
```

| Key | Meaning |
| --- | --- |
| `ticketPattern` | finds the ticket id in the branch name. A small subset of regular expressions: plain characters, `.`, `\d` `\w` `\s`, simple character classes, `^` `$`, up to three repeats, one capture group (its text is the id). |
| `tracker` | `{ "kind": "github" }` reads the item with `gh`. Other trackers come in later versions. |
| `prHost` | `auto` (the default) reads the git remote; `github` forces it. Azure DevOps Repos comes later. |
| `baseBranch` | the branch worktrees are compared with, `main` by default. |
| `progress` | `files`: a path with `*` in a segment. A file's percent is its done lines over its done and open lines. `done`, `open` and `blocked` are plain text marks (`- [x]`, `- [ ]`, `BLOCKED` by default). A later line with `UNBLOCKED` or `RESUMED` clears a block. |
| `checks` | `run` with `want`: ok when the output equals `want`. `run` alone: ok on exit 0. `minFreeGb`: ok when the disk has that much free. At most 20. |
| `ports` | a name and a port on this machine. At most 20. |
| `owed` | a markdown file; its open checkboxes are counted. |

## What it can reach

The panel reads. It changes nothing but its own state and, when you ask, `.claude/factory.json`.

- **It runs** `git` and `gh` (to read the branch, the worktrees, the issue, the pull request), `df` for a disk check and `nc` for the ports a settings file names, and, only after your approval, the commands (`run`) a settings file names.
- **It stores no password and no token.** `gh` uses your own login.
- **It runs no command from a settings file until you approve it.** A settings file arrives with a clone, so the panel first shows `SETTINGS NOT APPROVED`, the number of commands and every command in full. `/factory approve` allows exactly the lines the pane showed while it was on screen, for that repo; a file the pane has not shown yet is shown first, and a second `/factory approve` allows it. Only your own Enter at the prompt can approve. The approved lines are kept outside the repo, for the repo and all its worktrees; a line that changes asks again.
- **What an approval covers.** It covers the command line you read, not the code that command runs. A check must name a program on your `PATH` (never a file of the repo), runs with a `PATH` that leaves the repo out, and is not run when one of its arguments names a file of the repo. These are guards against the plain cases, not a boundary: a command that runs repo code by its nature (an inline script, a build tool) runs what the repo holds at that time. Approve a check as you would approve the same command in a shell.
- **It reads only files inside the repo.** A progress file, the owed file or the settings file that is a link to somewhere else is not read. `/factory init` does not write through a link.
- **What the model is told.** The session brief holds facts the plugin worked out (a ticket id, a branch, a percent, a count). It leaves out text other people wrote: an issue's title, a progress file's name, the reason in a blocked line. The answer of `/factory approve` holds a count, never the command lines.
- Text from files, the tracker and commands is shown with control characters removed.

`claude plugin validate factory` prints exactly what it hooks and calls.

## Troubleshooting

**The pane does not appear.** Check `claude --version` is 2.1.322 or later, then `/reload-plugins` and `/factory`. A dim line that starts with `factory:` in the transcript names the reason.

**`gh could not start` or `gh is not logged in`.** Install the GitHub CLI, then run `gh auth login`.

**`SETTINGS NOT APPROVED`.** Read the commands in the pane, then run `/factory approve`. If the pane had not shown them yet, or the file changed since, the pane shows them now; read them and run the command again.

**A check shows `names a repo file`.** A check cannot hand a file of the repo to a program.

**`settings: …`.** The settings file has a key the panel refused. The rest of the file still works.

## Develop

```sh
claude --plugin-dir ./factory     # load it; edits hot-reload
claude plugin validate factory
claude plugin test factory
npx -p typescript tsc -p factory  # after the first load, which writes factory/.claude-plugin/types/
```

All behaviour is in `factory/core/` as pure functions with tests. `factory/hooks/register.tsx` is the only file that touches the engine: it builds a small set of plain functions (`hooks/io.ts`) that the readers use.

## Next

The factory line: jobs, stations, loops and limits, on GitHub Issues first, then Azure DevOps, Jira and Asana.

## License

MIT
