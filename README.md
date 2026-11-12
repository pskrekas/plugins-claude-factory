# Factory

**A Claude Code plugin that shows the state of your work in a docked panel.** A later version adds a software factory on top of it.

The panel answers four questions without a prompt: what is my task, how far is each build, what waits for me, and is my environment correct. It knows no project: a repo tells it what to show through one settings file, `.claude/factory.json`.

This is an early version. It has the panel, and the parts of the factory line that code and a person do: jobs, the gate, the writes to GitHub, and the commands to stop the line, answer a job and reject a job. The agents that do the work at each station (a marked tracker item goes through Intake, Spec, Build, Gate, Review and Approve, and comes out as a ready pull request that a person merges) are the next phase. The design is in [`docs/superpowers/specs`](docs/superpowers/specs).

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
| `/factory where` | says where the factory keeps its state for this repository |
| `/factory approve` | opens the pane and allows the commands it shows (see below). Only your own Enter at the prompt counts |
| `/factory stop` | the line starts no new station. Agents that run finish theirs. It works from any session |
| `/factory answer <id> [text]` | lets a job that waits for you go on. The text is given to the next agent; a question for the item's author needs text. For a job that one of its own limits stopped, it grants that limit once more (one round, or the job's cost or time limit again). A limit of the day is not lifted: raise it in the settings, or wait for the next day. For a ready job, text sends it back to Build |
| `/factory reject <id> <reason>` | drops a job: a comment with the reason on the item, the pull request closed, the item closed as not planned, the worktree removed. It also drops an item that the tracker says is in progress and that has no job on this machine |

`stop`, `answer` and `reject` change things, so only your own Enter at the prompt counts for them too. Two sessions never change one job: `answer` and `reject` first take the lock, and say so when another session holds it.

While the pane is on screen it reads again once a minute.

Two options, in `/config`: `openOnStart` (open the pane when a session starts, off by default) and `sound` (the alert sound, on by default).

It works on macOS and Linux. It uses `df` and `nc`, which Windows does not have.

## The factory line (not running yet)

The next version runs the line: a tracker item with a mark goes through Intake, Spec, Build, Gate, Review and Approve, and comes out as a ready pull request that a person merges. This version knows what a job is, draws it, and has the hands of the line: the code that writes to GitHub, makes worktrees and runs the gate. No agent runs yet, so nothing starts a job by itself.

The **FACTORY** section of the pane shows:

```
 Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You
   4        0        0        1       0        1          0        2
                              ^       │        │
                              ├─fail──┘        │
                              └─── changes ────┘
```

- the stations, with the number of jobs at each one, and the two loops back to Build (lit while a job is on them);
- one row per running job: a cell for each station (`done`, `now`, `fail`, `changes`), then its round, who sent it back, its time and its cost;
- **NEEDS YOU**: the jobs that wait for a person (a question, or a pull request to merge), and the items the tracker says are in progress that have no job on this machine (a lost state folder, or another machine runs them);
- the size of the queue (open GitHub issues that carry the mark) and the totals of the day.

The first row says who runs the line: `2 of 2 slots busy` (this session), `another session runs the line`, or `no session runs the line`; and `stopped` after `/factory stop`.

A job is a file, `job.json`, in a folder of its own. The plugin keeps these under your home folder, never in the repo: `~/.local/state/claude-factory/<repo>/jobs/` (or under `$XDG_STATE_HOME`). `/factory where` prints the folder for the repo you are in. The folder is named after the path of the repository, so a repo that you move to another place starts with no jobs. A `.factory/` folder that a repo brings along is never read, so a repo cannot show you jobs of its own.

Nothing creates a job yet. To see the section, copy the three sample jobs into the state folder and open the pane:

```sh
mkdir -p "<the folder /factory where printed>/jobs"
cp -R docs/examples/factory-jobs/* "<the folder /factory where printed>/jobs/"
```

### The gate

The gate is the set of commands a job's branch must pass. Code runs it, no agent. `gate.fast` runs on every round; `gate.full` runs once, before a job becomes ready.

- **The commands come from the base branch.** The gate fetches `<baseBranch>` from `origin`, reads its last commit once, and reads `.claude/factory.json` of that commit: never the job's branch, never a file of a folder. The protected paths come from the same file. From then on it uses commit ids only, so a branch or a tag with a look-alike name is not read in the base's place.
- **You approve them.** The pane lists them as `[gate] npm test`, and `/factory approve` allows them. An approval as a gate command does not make the command a check of the panel, and the other way round.
- **It runs in a clean copy.** The gate reads the last commit of the job's branch `factory/<job>`, and runs the commands in a fresh working tree at that commit (`gate/<job>` in the state folder), which it removes after. A file that is not committed, a file git ignores, or a file git was told to overlook is not there. The copy holds no installed packages, so **the first command of each list must install them** (`["npm", "install"]`). `/factory init` writes it so for an npm repo.
- **It runs the branch's code.** A gate command (a test run, a build) runs code that an agent wrote, with your rights on this machine, before any reviewer has read it. The gate checks which files changed, not what the code does.
- **Files that are not committed are named.** If the job's worktree holds changed or new files that are not committed, the report lists them: the gate did not check them, and they are not in the pull request.
- **Protected paths stop it.** A branch that changes, moves or deletes a protected path (`factory.protectedPaths`: a file, or a folder with everything under it; the settings file is always one) runs no command and waits for you.
- **A command has ten minutes.** One that runs longer is a failure. The first command that fails ends the run.
- **The report** is a file of the job, `round-<n>/checks.md` (or `merge-checks.md` for the full gate): a short summary, the end of each command's output (the engine keeps the first 4 MiB of what a command prints; the report says when the end is missing), and the test files and test or build settings the branch changed, for the reviewers and for you.

### What it writes on GitHub

Only for a repo whose settings say `"tracker": { "kind": "github" }` and whose remote `origin` is a GitHub repository. Every `gh` call that writes names that repository (`-R <owner>/<name>`), so in a fork nothing is written to the project the fork came from.

- **Labels.** It makes two labels, `<mark>:in-progress` and `<mark>:needs-human`, and sets or removes them on an item. The mark itself (`factory` by default) is yours: only you put it on an item.
- **Comments.** On the item and on the pull request. The text goes to `gh` on standard input, never as an argument. A comment that holds one of `factory.forbiddenCommentWords` is not sent.
- **Pull requests.** It opens a draft pull request from the job's branch `factory/<job>`, marks it ready, comments on it, or closes it. **It never merges one.** A rejected item is closed as not planned.
- **Branches.** It pushes one commit, by its id, to the job's own branch `factory/<job>`. It never forces a push, never pushes to the base branch, and never rewrites history.

A job's worktree is in the state folder (`worktrees/<job>`), not in the repo.

## Settings

One file per repo, `.claude/factory.json`. Every key is optional. With no file the panel shows the branch, its pull request, the agents and the worktrees.

```json
{
  "ticketPattern": "PROJ-\\d+",
  "tracker": { "kind": "github" },
  "baseBranch": "main",
  "gate": {
    "fast": [["npm", "install"], ["npm", "run", "lint"], ["npm", "test"]],
    "full": [["npm", "install"], ["npm", "test"], ["npm", "run", "build"]]
  },
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
| `gate` | `fast` and `full`: lists of commands, each a list of words. See "The gate". The factory will not run with an empty `fast`. |
| `progress` | `files`: a path with `*` in a segment. A file's percent is its done lines over its done and open lines. `done`, `open` and `blocked` are plain text marks (`- [x]`, `- [ ]`, `BLOCKED` by default). A later line with `UNBLOCKED` or `RESUMED` clears a block. |
| `checks` | `run` with `want`: ok when the output equals `want`. `run` alone: ok on exit 0. `minFreeGb`: ok when the disk has that much free. At most 20. |
| `ports` | a name and a port on this machine. At most 20. |
| `owed` | a markdown file; its open checkboxes are counted. |
| `factory` | how the line runs, used when it runs: `slots` (2), `maxRounds` (3), `maxRisk` (`low`), `costLimitUsd` and `timeLimitMin` (`{ job, day }`), `minFreeDiskGb` (15), `protectedPaths`, `forbiddenCommands`, `forbiddenCommentWords`, `models`, `reviewers`. One refused value refuses the whole `factory` key. |

## What it can reach

The panel reads. It changes nothing but its own state and, when you ask, `.claude/factory.json`.

- **It runs** `git` and `gh` (the full list is below), `df` for a disk check and `nc` for the ports a settings file names, `mkdir`, `mv` and `rm` on its own state folder, and, only after your approval, the commands a settings file names (the checks, and the gate's commands).
- **It stores no password and no token.** `gh` uses your own login.
- **It runs no command from a settings file until you approve it.** A settings file arrives with a clone, so the panel first shows `SETTINGS NOT APPROVED`, the number of commands and every command in full. `/factory approve` allows exactly the lines the pane showed while it was on screen, for that repo; a file the pane has not shown yet is shown first, and a second `/factory approve` allows it. Only your own Enter at the prompt can approve. The approved lines are kept outside the repo, for the repo and all its worktrees; a line that changes asks again.
- **What an approval covers.** It covers the command line you read, not the code that command runs. A check must name a program on your `PATH` (never a file of the repo), runs with a `PATH` that leaves the repo out, and is not run when one of its arguments names a file of the repo. These are guards against the plain cases, not a boundary: a command that runs repo code by its nature (an inline script, a build tool) runs what the repo holds at that time. Approve a check as you would approve the same command in a shell.
- **The factory's state is yours, not the repo's.** Jobs and the lock are files under your home folder. The folder is named after the repository's path, holds that path, and is not used when it names another repository or when it would be inside the repo.
- **It checks where the repo starts.** The top of the working tree is the nearest folder above the session's that holds a `.git`, and only when git names the same folder. A folder's own git config can make git name any path, and another user of the machine can put a `.git` in a shared folder; when the two do not agree, the plugin stays in the session's own folder.
- **It reads only files inside the repo.** A progress file, the owed file or the settings file that is a link to somewhere else is not read. `/factory init` does not write through a link.
- **What the model is told.** The session brief holds facts the plugin worked out (a ticket id, a branch, a percent, a count). It leaves out text other people wrote: an issue's title, a progress file's name, the reason in a blocked line. The answer of `/factory approve` holds a count, never the command lines.
- Text from files, the tracker and commands is shown with control characters removed.

### Every `git` and `gh` call

The panel only reads:

```
git rev-parse --show-toplevel
git rev-parse --abbrev-ref HEAD
git worktree list --porcelain
git branch --merged <base> --format=%(refname:short)
git symbolic-ref --short refs/remotes/origin/HEAD        (/factory init)
gh issue view <n> --json …
gh issue list --label <mark> --state open --limit 100 --json …
gh pr view --json …
```

The line can also make these calls, and no other. `<job>` is a job's id, `<state>` the state folder, `<commit>` a full commit id.

```
git fetch origin <base>
git worktree add <state>/worktrees/<job> -b factory/<job> refs/remotes/origin/<base>
git worktree add --detach <state>/gate/<job> <commit>
git worktree remove --force <state>/worktrees/<job>      (or <state>/gate/<job>)
git push origin <commit>:refs/heads/factory/<job>
git … merge --no-edit <commit>                           (the job's worktree, see below)
git … merge --abort
git rev-parse --verify refs/remotes/origin/<base>^{commit}
git rev-parse --verify refs/heads/factory/<job>^{commit}
git show <commit>:.claude/factory.json
git diff --name-only --no-renames -z <commit>...<commit>
git … status --porcelain --no-renames --untracked-files=all -z
git diff --no-renames --no-ext-diff --no-textconv <commit>...<commit>

gh label create <mark>:in-progress --force --description …
gh label create <mark>:needs-human --force --description …
gh issue comment <n> --body-file -
gh issue edit <n> --add-label … --remove-label …
gh issue close <n> --reason "not planned"
gh pr create --draft --head factory/<job> --base <base> --title … --body-file -
gh pr view <n> --json …
gh pr ready <n>
gh pr comment <n> --body-file -
gh pr close <n>
```

Each `gh` call of the second list ends with `-R <owner>/<name>`. The line's `git` calls run with `GIT_NO_REPLACE_OBJECTS=1`, and all of them run in your repository's folder. `git …` stands for `git --git-dir=<repo's git folder>/worktrees/<job> --work-tree=<state>/worktrees/<job> -c core.fsmonitor=false -c core.hooksPath=/dev/null`: a call that needs a job's worktree names it, so git reads no setting from a folder that an agent can write to.

In this version only `/factory answer` and `/factory reject` make calls of the second list (the label, comment and close calls, and the removal of a worktree). The others wait for the line.

`git` reads the repository's own git settings, as it does when you type the command.

`claude plugin validate factory` prints exactly what it hooks and calls.

## Troubleshooting

**The pane does not appear.** Check `claude --version` is 2.1.322 or later, then `/reload-plugins` and `/factory`. A dim line that starts with `factory:` in the transcript names the reason.

**`gh could not start` or `gh is not logged in`.** Install the GitHub CLI, then run `gh auth login`.

**`SETTINGS NOT APPROVED`.** Read the commands in the pane, then run `/factory approve`. If the pane had not shown them yet, or the file changed since, the pane shows them now; read them and run the command again.

**`Another session runs the line (…). Nothing was changed.`** Another Claude Code session in this repository holds the lock; the text names its folder. Run the command there, or close that session and wait five minutes.

**`No job for <id>.`** There is no job of that item on this machine, and the tracker does not say it is in progress.

**`<id> is still at a limit (…)`.** A limit of the day stopped the job. Raise `factory.costLimitUsd.day` or `factory.timeLimitMin.day`, or answer again the next day.

**The gate fails at once with `not found`.** The gate runs in a clean copy with no installed packages. Put the install command first in `gate.fast` and `gate.full`.

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

The agents of the line and the loop that moves a job from station to station (`/factory plan`, `/factory run`), on GitHub Issues first, then Azure DevOps, Jira and Asana.

## License

MIT
