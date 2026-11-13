# Factory

**A Claude Code plugin with a docked work panel and a software factory line.**

The panel answers four questions without a prompt: what is my task, how far is each build, what waits for me, and is my environment correct. It knows no project: a repo tells it what to show through one settings file, `.claude/factory.json`.

The line turns a marked GitHub issue into a pull request that is ready for you to merge. The issue goes through Intake, Spec, Build, Gate, Review and Approve. An agent does the work at each station; the plugin's own code moves the job, runs the checks, and writes to GitHub. You merge. The plugin never does.

This is an early version, for GitHub Issues and GitHub pull requests. Read **"Before you run the line"** first. The design is in [`docs/superpowers/specs`](docs/superpowers/specs).

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

For GitHub it needs the GitHub CLI (`gh auth login`). For Azure DevOps it needs the Azure CLI with its DevOps extension:

```sh
az extension add --name azure-devops
az login
```

For the factory line it needs Docker, and the image your settings name.

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
| `/factory tracker [id]` | reads the tracker and says what the plugin understood: the size of the queue and, for the first item of the queue (or the item you name), which fields were found. It writes nothing, and its answer holds no text of an item (a failed call's own first line, cut, is shown) |
| `/factory files [id]` | says where the files of a job are, one path on a line: the item, Intake's note, the spec, and each round's build note, checks, reviews, decision and change. It prints paths, never a file's text. With no id it names the jobs on this machine |
| `/factory approve` | opens the pane and allows the commands it shows (see below). Only your own Enter at the prompt counts |
| `/factory plan` | the dry run: Intake judges each item of the queue (ten at most). It builds nothing, opens no pull request and writes nothing to the tracker. The pane shows what Intake said |
| `/factory run [id]` | runs the line: one pass over the queue as it is now (or over one item that carries the mark), and the jobs that are already there. It ends when every job is ready, waits for you, or is refused, or when a limit of the day or a full disk holds it |
| `/factory stop` | the line starts no new station. Agents that run finish theirs. It works from any session |
| `/factory answer <id> [text]` | lets a job that waits for you go on. The text is given to the next agent; a question for the item's author needs text. For a job that one of its own limits stopped, it grants that limit once more (one round, or the job's cost or time limit again). A limit of the day is not lifted: raise it in the settings, or wait for the next day. For a ready job, text sends it back to Build |
| `/factory reject <id> <reason>` | drops a job: a comment with the reason on the item, the pull request closed, the item closed as not planned, the worktree removed. It also drops an item that the tracker says is in progress and that has no job on this machine |

`plan`, `run`, `stop`, `answer` and `reject` change things, so only your own Enter at the prompt counts for them too. Two sessions never change one job: one session holds the lock while the line runs, and a command says so when another session holds it.

While the pane is on screen it reads again once a minute.

Two options, in `/config`: `openOnStart` (open the pane when a session starts, off by default) and `sound` (the alert sound, on by default).

It works on macOS and Linux. It uses `df` and `nc`, which Windows does not have.

## The factory line

### Before you run the line

- **Where the builder's and the gate's commands run.** In a container (see "The container"). The builder agent has no shell on your machine: its shell is a tool of the plugin, and each command runs in a container that holds the job's code folder and nothing else of your machine. The gate's commands run in a container too. A container is a strong wall, not a perfect one: it shares your machine's kernel, and with the network on it can reach the internet and the services of your own machine and network (a database on `localhost`, for example). An issue is text that someone else wrote; the agents are told to read it as data, and that is a rule for a model, not a wall.
- **It costs money or quota.** Each station is an agent. Set the limits (`factory.costLimitUsd`, `factory.timeLimitMin`, `factory.slots`, `factory.maxRounds`) before the first run, and try `/factory plan` first.
- **The gate runs the branch's code** before a reviewer has read it: in its container, or, only if you chose `"container": false`, with your rights on your machine.
- **What does not depend on the container or the fence:** the gate runs in its own clean copy of one commit; what the plugin itself pushes is the commit the gate judged, to the job's own branch; the plugin never merges; your branch protection on GitHub still holds. **What a container holds:** the job's code and no login of yours. With the network on, that code can leave through the network, what the builder downloads can come in, and a command can talk to any service your machine can reach.
- **A pushed round starts your CI.** The plugin pushes a job's branch after the fast checks passed, before a reviewer has read it. A workflow that runs on a push runs the branch's code with the secrets that workflow has. A branch that changes a protected path (put `.github/` there) is never pushed.
- **What goes public.** The pull request is what an agent wrote, pushed to your repository: the plugin commits every file the builder leaves in the job's code folder. On the issue the plugin posts its own fixed texts, the name of a limit, the pull request's address, the names of changed test files, and Intake's question or refusal for the item's author. A builder's or a reviewer's own words are never posted there: you read them in the pane.
- **Who can speak to the agents.** Only an issue that carries the mark runs, and only you put the mark on. Of an issue's comments, only those of its author and yours reach an agent.

### Start

1. `/factory init` writes a first `.claude/factory.json`. Edit it: the gate lists must start with the install command, and `factory.container.image` must be an image that holds the tools of your repo. Get the image (`docker pull node:22`): the plugin fetches none. Commit the file to the base branch and push: the gate and the container settings are read from there.
2. `/factory`, read the commands in the pane, then `/factory approve`.
3. Put the label `factory` on an issue (on Azure DevOps: the tag `factory` on a work item). Only you put it there: it is what lets an item into the line.
4. `/factory plan` to see what Intake says. `/factory run` to run the line.
5. A ready job is a pull request for you to merge. A job under **NEEDS YOU** has a question: `/factory answer <id> <text>`, or `/factory reject <id> <reason>`.

### The stations

| Station | Done by | Result |
| --- | --- | --- |
| Intake | one agent, the strongest model, no shell | accepts the item (with a risk: low, medium, high), asks its author one question, or refuses it |
| Spec | one agent, no shell | `spec.md`: what to build and how it is checked |
| Build | one agent, in the job's own worktree and branch `factory/<job>`. Its commands run in a container | the code of the change. The plugin commits it (`Factory: item <id>, round <n>`) |
| Gate | the plugin's code | runs the fast checks. A fail goes back to Build with the report. On a pass the plugin pushes the judged commit and opens a draft pull request |
| Review | one agent for each routed reviewer (`code`; `ux` and `ui` for a screen change; `security`), no shell | each says OK or CHANGES. One CHANGES sends the job back to Build |
| Approve | one agent, no shell | READY, or one question for you. On READY the plugin brings the base into the branch, runs the full checks on that commit, pushes it, and marks the pull request ready. A commit that landed after the review is not marked ready: the job asks you |
| You | you | merge, answer, or reject |

Each way back to Build is a round. After `maxRounds` (3) with no pass the job stops and asks you. A risk above `maxRisk` (`low`) stops after Intake and asks you.

Each agent reads the job's files and writes exactly one file. Its answer is one line that starts with a fixed word (`DONE`, `OK`, `CHANGES`, `READY`, …); the plugin decides by that word. A question or a reason on that line is shown to you in the pane (only Intake's goes on the item); nothing else an agent says is read. An answer the line cannot read starts the station once more, then asks you. An agent that does not answer within `factory.stationTimeoutMin` (30) makes its job ask; `/factory answer <id>` starts the station again. The plugin cannot stop an agent: one it gave up on may still work for a while, and its station does not start again until it has ended.

A step that cannot be done (a push that is refused, a label that cannot be set) is tried once more at the next call. After two tries the job waits for you, with the reason.

Agents start only from the plugin's own running code, in the job's folder. The session's model is not told about them and does not see their reports: you can keep using the chat while the line runs. One gate runs at a time, and the other jobs wait while it runs. `/factory run` in a new session goes on with every job from where it was (what happens to a running agent when you close the session is not checked yet). If the line has something to do and nothing of its own is running to do it, the pane's timer says `the line waits`: `/factory run` goes on.

### The container

No code that an agent wrote, and no command that an agent chose, runs on your machine.

- **The builder's shell.** The builder has no `Bash`. It has one tool of the plugin, and the plugin runs each command of it as `docker run --rm … sh -c <command>`: a container of its own, which is gone when the command ends, with every program the command started. The command is one argument of the shell inside the container; your machine's shell never reads it.
- **What a container sees.** One folder: the job's worktree (for the gate: the gate's clean copy), at its own path. Not your home folder, not the repository's git folder, not the factory's state, not the Docker socket. Nothing inside that folder is ever the source of a mount. It runs as your user id (so the files stay yours), with no added right (`--cap-drop ALL`, `no-new-privileges`), at most 512 processes, and the memory and CPUs of the settings. Docker is told to fetch no image (`--pull never`).
- **What stays between two commands.** The files of the code folder, and nothing else: no running program, no variable, no file outside the folder (a package cache under `/tmp` is gone; `node_modules` in the folder stays).
- **One side at a time.** While a command of a job runs in its container, the builder's file tools on that job are refused, and the other way round. Each file call is judged by the fence again at the moment it runs. If Docker does not confirm that a container is gone, the job's folder stays closed until it does: no file call, no commit, and no removal of the folder (a reject or the end of a job then leaves the folder and tells you). This is how the plugin keeps a program in a container from changing a path while your machine uses it.
- **No git in the container.** The builder does not commit. When it ends, the plugin commits every file it left in the code folder, under a fixed message. Before any `git` call on the folder, the plugin looks for a git repository inside it (an entry named `.git` below the top, by any case, or a changed `.git` file at the top). With one there it makes no `git` call on the folder, and the job asks you: a repository can name a program in its own settings, and git would run that program on your machine. So a repository with submodules that a builder fills in cannot use the line. After each command the plugin puts the folder's own `.git` file back as git made it, whatever the command left in its place. Do not run `git` yourself inside a job's folder under `<state>/worktrees/` while a job is in Build: a folder inside it can still be a repository that the builder made.
- **The gate.** Its commands run with `docker exec` in a container over the gate's clean copy; the container is made new for each gate run and removed after.
- **The settings** are `factory.container` on the base branch: `{ "image": "node:22", "network": "on", "memory": "4g", "cpus": 2 }`. Only `image` is needed. You approve the line the pane shows (`[container] node:22 · network on · memory 4g · cpus 2`); a changed image or network needs a new approval. The plugin fetches no image: run `docker pull <image>` yourself. The image needs `sh` and the tools your gate and your builder use.
- **The network** is `on` by default, so that an install works. With `"network": "none"` nothing in the container reaches the network: then the image must already hold what the install needs.
- **No container, no factory.** `/factory run` does not start when `factory.container` is not set, not approved, or when Docker or the image is not there.
- **On this machine, if you say so.** `"container": false` runs the builder's commands (`Bash`) and the gate's commands on your machine, with your rights, behind the fence below. The pane shows `[container] none: the builder and the gate run on this machine`, and you approve exactly that. Use it only on a repository and on issues that you trust.
- **Its limits.** A container shares your machine's kernel. With the network on, a command can send the job's code anywhere, download anything, and reach the services of your machine and your network (Docker Desktop gives a container the name `host.docker.internal` for your machine); use `"network": "none"` when that matters. `git` does not work inside (the git folder is not there), so a gate command that needs git fails. The commands in `factory.forbiddenCommands` are refused by a check of text, which is best effort (a command built from pieces can get past it); a container holds no login of yours, so such a command has nothing to act with. The one-side-at-a-time rule depends on Claude Code handing every file call of an agent to the plugin; that is checked for a shell call, not yet for each file tool (see the hand check).

### The fence

Every tool call of an agent of the line goes through the plugin first.

- **Files (the file tools).** With its read and write tools an agent reads only inside its job (the job's worktree and the job's folder) and writes one file, its report. Only the builder also writes code, in its worktree. A path is judged by where it really is, so a link that leads out of the job is refused.
- **Shell on this machine (only with `"container": false`).** Refused: `git push`, `gh` and `az` (the plugin talks to the host), changes to git settings and refs, leaving the job's branch or moving another one (`git checkout <branch>`, `git switch`, `git branch -f`), any naming of the git folder, a write to a full path outside the job (scratch space under `/tmp` is allowed), the commands in `factory.forbiddenCommands` (put your deploy and release commands there), and a few forms the fence cannot read (a variable or a pattern in a program name, a write to a place only the shell knows, a shell inside a shell inside a shell). The shell can read anywhere you can.
- **Twice is enough.** The same command refused twice stops the job and asks you.
- **Its limit.** For shell commands this is best effort. A script that the builder writes and runs is not read by the fence. That is why the builder's commands run in a container unless you say otherwise.
- **Shell in a container.** Only the commands in `factory.forbiddenCommands` are refused, as text.

### Limits and cost

`factory.slots` (2) jobs at one time. A cost limit and a time limit for each job and for each day; at a limit the job stops and asks, and `/factory answer` grants a job's own limit once more. No new job starts when the disk has less than `factory.minFreeDiskGb` (15) free.

Cost is an estimate from the token counts of each agent and the prices you give in `factory.prices` (US dollars per million tokens, by model id). With no price for a model the pane says `cost unknown` and the time limits apply. On a subscription the figure shows relative use, not a bill.

```json
"factory": {
  "prices": { "<model id>": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 } },
  "forbiddenCommands": [["npm", "publish"], ["terraform", "apply"]]
}
```

### What the pane shows

The **FACTORY** section of the pane shows:

```
 Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You
          opus      sonnet  sonnet   code    sonnet    sonnet
   4        0        0        1       0        1          0        2
                              ^       │        │
                              ├─fail──┘        │
                              └─── changes ────┘
```

- the stations, with the number of jobs at each one, and the two loops back to Build (lit while a job is on them);
- under each station's name, the model of its agent (see "The models"). The gate has no model: it is the plugin's own code. In a narrow pane this is one row, `opus I · sonnet S B R A`;
- the job rows follow a job as it moves: they are read again from the job files after every end of a turn and every 15 seconds, without a call to the tracker. The rest of the pane is read once a minute;
- one row per running job: a cell for each station (`done`, `now`, `fail`, `changes`), then what runs now (`builder runs · 4 m`), its round, who sent it back, its time and its cost;
- **NEEDS YOU**: the jobs that wait for a person (a question, or a pull request to merge), and the items the tracker says are in progress that have no job on this machine (a lost state folder, or another machine runs them);
- **PLAN**: after `/factory plan`, what Intake said of each item, and how many would run;
- the size of the queue (open GitHub issues that carry the mark) and the totals of the day.

The first row says who runs the line: `2 of 2 slots busy` (this session), `another session runs the line`, or `no session runs the line`; and `stopped` after `/factory stop`.

**To read what an agent wrote**, run `/factory files <id>` and open a path it prints. `files/item.md` is the item as the agents see it, `files/intake.md` is Intake's decision, `files/spec.md` is the spec, and each `files/round-<n>/` folder holds that round's `build.md`, `checks.md`, `review-<kind>.md`, `decision.md`, `merge-checks.md` and `diff.patch`. The command prints paths only, because a command's answer goes to the model of your session, and these files are text that an agent wrote from the item.

A job is a file, `job.json`, in a folder of its own. The plugin keeps these under your home folder, never in the repo: `~/.local/state/claude-factory/<repo>/jobs/` (or under `$XDG_STATE_HOME`). `/factory where` prints the folder for the repo you are in. The folder is named after the path of the repository, so a repo that you move to another place starts with no jobs. A `.factory/` folder that a repo brings along is never read, so a repo cannot show you jobs of its own.

A job that ended stays in that folder for the day's totals, without its worktree and its branch. It is moved to `retired/` when its item runs again.

To see the section with no run, copy the three sample jobs into the state folder and open the pane:

```sh
mkdir -p "<the folder /factory where printed>/jobs"
cp -R docs/examples/factory-jobs/* "<the folder /factory where printed>/jobs/"
```

### The models

Each station's agent has a model. The defaults: Intake has the strongest one, because it decides whether an item is safe to take; Spec, Build, Review and Approve have the strong one.

| Role | Default | Model |
| --- | --- | --- |
| `intake` | `strongest` | `opus` |
| `spec`, `builder`, `reviewer`, `approver` | `strong` | `sonnet` |

`factory.models` in the settings file changes a role. Give a tier (`strongest` is `opus`, `strong` is `sonnet`, `fast` is `haiku`), or name the model: `opus`, `sonnet`, `haiku`, a full model id that starts with `claude-`, or `inherit` (the model of your session). A role you leave out keeps its default.

```json
"factory": { "models": { "builder": "opus", "reviewer": "fast" } }
```

- The agents get their models when a session starts. After a change, start a new session. The pane shows the models that this session's agents use.
- A model that Claude Code does not know cannot be registered: `/factory run` then says that the agent types are not registered.
- A stronger model costs more. Put its price in `factory.prices` under its model id, or the pane says `cost unknown`.

### The gate

The gate is the set of commands a job's branch must pass. Code runs it, no agent. `gate.fast` runs on every round; `gate.full` runs once, before a job becomes ready.

- **The commands come from the base branch.** The gate fetches `<baseBranch>` from `origin`, reads its last commit once, and reads `.claude/factory.json` of that commit: never the job's branch, never a file of a folder. The protected paths come from the same file. From then on it uses commit ids only, so a branch or a tag with a look-alike name is not read in the base's place.
- **You approve them.** The pane lists them as `[gate] npm test`, and `/factory approve` allows them. An approval as a gate command does not make the command a check of the panel, and the other way round.
- **It runs in a clean copy.** The gate reads the last commit of the job's branch `factory/<job>`, and runs the commands in a fresh working tree at that commit (`gate/<job>` in the state folder), which it removes after. A file that is not committed, a file git ignores, or a file git was told to overlook is not there. The copy holds no installed packages, so **the first command of each list must install them** (`["npm", "install"]`). `/factory init` writes it so for an npm repo.
- **It runs the branch's code.** A gate command (a test run, a build) runs code that an agent wrote, before any reviewer has read it: in the gate's container, or with your rights on this machine when the base branch says `"container": false`. The gate checks which files changed, not what the code does.
- **Files that are not committed are named.** The plugin commits what the builder left before the gate runs. If the job's worktree still holds changed or new files that are not committed, the report lists them: the gate did not check them, and they are not in the pull request.
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

### What it writes on Azure DevOps

Only for a repo whose settings say `"tracker": { "kind": "azure-boards" }`, or whose remote `origin` is an Azure DevOps repository (for pull requests). Every `az` call that reads or writes names its organization (`--org https://dev.azure.com/<organization>`: the remote's, or the one you approved, see Mixes) and tells `az` to detect nothing, so `az`'s own defaults are not used. `az` is also told not to install a missing extension by itself.

- **Tags.** The mark is a tag on a work item (`factory` by default): only you put it there. The line adds one state tag beside it, `<mark>:in-progress`, `<mark>:needs-human`, `<mark>:done` or `<mark>:rejected`, and takes the old one away. It reads the tags just before it writes them, so your other tags stay; a tag of yours that starts with `<mark>:` is taken as the line's and removed. The read and the write are two calls: a tag that you change in the moment between them (well under a second) is written over. A work item with a state tag is not in the queue. **It never changes a work item's own state** (New, Active, Closed, …): take the `<mark>:` tag away to put an item back in the queue.
- **Comments.** On the work item's discussion, as text (nothing in it is read as markup), and as a new thread on the pull request. `az` reads a value that starts with `@` from a file, so no title and no comment is ever an argument: the plugin writes each one to a file of its own state folder, passes `--<name>=@<file>`, and removes the file. A comment that holds one of `factory.forbiddenCommentWords` is not sent.
- **Pull requests.** It opens a draft pull request from the job's branch `factory/<job>`, links it to the work item (Azure DevOps may then offer to close the work item when you complete the pull request), marks it ready (`--draft false`), comments on it, or abandons it for a rejected item. **It never completes one**: no `az` call of the plugin holds `--status completed`, `--auto-complete` or `--bypass-policy`. A pull request that you complete reads as merged, and the job is done.
- **What an agent reads.** A work item's description and comments are HTML; an agent gets them as plain text (no markup, no script), with a bug's steps to reproduce and a story's acceptance criteria, and only the comments of the item's author and yours (the newest fifty are read). An item whose comments cannot be read is not started.
- **Mixes.** GitHub Issues with the code on Azure Repos: `"tracker": { "kind": "github", "project": "<owner>/<name>" }`. Azure Boards with the code on GitHub: `"tracker": { "kind": "azure-boards", "project": "<organization>/<project>" }`; the pull request is then a comment on the work item, not a link. Such a place comes from the settings file, not from the remote, and a settings file arrives with a clone: the pane shows it as a line `[tracker] azure-boards <organization>/<project>`, and it is used only after `/factory approve`. With an Azure DevOps remote the organization is always the remote's.
- **Not checked on a real organization yet.** The `az` calls are built from the tool's help and its code (`docs/notes/az-check.md`). The hand check is in `docs/notes/r1-check.md`.

### Other trackers (through an MCP server)

With `"tracker": { "kind": "mcp" }` the line works with any tracker whose MCP server you connected with `/mcp`. The settings file names the server and, for each action, the tool to call, its arguments and the fields of the answer. Every call is a line in the pane that you approve, and the plugin stores no login. Try a mapping with `/factory tracker` before you run the line.

- [The reference](docs/trackers/mcp.md): every key, the placeholders, how an answer is read, and what it cannot do.
- [Jira](docs/trackers/jira.md), through Atlassian's MCP server: an example, not tested.
- [Asana](docs/trackers/asana.md), through Asana's MCP server: what it can and cannot do, and a mapping with names to fill. Not tested.

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
  "owed": ".claude/owed.md",
  "factory": { "container": { "image": "node:22" } }
}
```

| Key | Meaning |
| --- | --- |
| `ticketPattern` | finds the ticket id in the branch name. A small subset of regular expressions: plain characters, `.`, `\d` `\w` `\s`, simple character classes, `^` `$`, up to three repeats, one capture group (its text is the id). |
| `tracker` | `{ "kind": "github" }` reads the items with `gh`; `{ "kind": "azure-boards" }` reads Azure DevOps work items with `az`. `mark` (`factory` by default) is the label or the tag that lets an item into the line. `project` says where the items are when the remote does not: for `azure-boards` a project of the remote's organization, or `<organization>/<project>`; for `github` with the code on another host, `owner/name`. `{ "kind": "mcp" }` reaches a tracker through its MCP server: see [`docs/trackers/mcp.md`](docs/trackers/mcp.md). |
| `prHost` | `auto` (the default) reads the git remote: `github.com` is GitHub, `dev.azure.com` (or `<name>.visualstudio.com`) is Azure DevOps Repos. `github` or `azure-repos` forces one. |
| `baseBranch` | the branch worktrees are compared with, `main` by default. |
| `gate` | `fast` and `full`: lists of commands, each a list of words. See "The gate". The factory will not run with an empty `fast`. |
| `progress` | `files`: a path with `*` in a segment. A file's percent is its done lines over its done and open lines. `done`, `open` and `blocked` are plain text marks (`- [x]`, `- [ ]`, `BLOCKED` by default). A later line with `UNBLOCKED` or `RESUMED` clears a block. |
| `checks` | `run` with `want`: ok when the output equals `want`. `run` alone: ok on exit 0. `minFreeGb`: ok when the disk has that much free. At most 20. |
| `ports` | a name and a port on this machine. At most 20. |
| `owed` | a markdown file; its open checkboxes are counted. |
| `factory` | how the line runs: `slots` (2), `maxRounds` (3), `maxRisk` (`low`), `costLimitUsd` and `timeLimitMin` (`{ job, day }`), `minFreeDiskGb` (15), `stationTimeoutMin` (30), `prices`, `protectedPaths`, `forbiddenCommands`, `forbiddenCommentWords`, `models` (for each role `intake`, `spec`, `builder`, `reviewer`, `approver`: a tier, `strongest`, `strong` or `fast`, or the model itself, `opus`, `sonnet`, `haiku`, a full model id that starts with `claude-`, or `inherit` for the session's own model; see "The models"), `reviewers`. One refused value refuses the whole `factory` key. |
| `factory.container` | where the builder's and the gate's commands run: `{ "image", "network": "on" or "none", "memory": "4g", "cpus": 2 }`, or `false` for this machine. Read from the base branch. See "The container". The factory will not run without it. |

## What it can reach

The panel reads. It changes nothing but its own state and, when you ask, `.claude/factory.json`.

- **It runs** `git`, `gh` or `az`, and `docker` (the full lists are below), `id` for your user id, `find` to look for a git repository inside a job's folder, `df` for a disk check and `nc` for the ports a settings file names, `mkdir`, `mv` and `rm` on its own state folder, and, only after your approval, the commands a settings file names (the checks; and the gate's commands, in a container).
- **It stores no password and no token.** `gh` and `az` use your own login.
- **It runs no command from a settings file until you approve it.** A settings file arrives with a clone, so the panel first shows `SETTINGS NOT APPROVED`, the number of commands and every command in full. `/factory approve` allows exactly the lines the pane showed while it was on screen, for that repo; a file the pane has not shown yet is shown first, and a second `/factory approve` allows it. Only your own Enter at the prompt can approve. The approved lines are kept outside the repo, for the repo and all its worktrees; a line that changes asks again. An MCP tracker's settings show one line for each call, whole (`[tracker] mcp <server> · …`), and the plugin calls none of them, not even to read, until every line is approved: such a call asks you nothing and acts with your own sign-in.
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
gh issue view <n> --json labels                          (/factory run <id>)
gh api user --jq .login                                 (whose comments an agent may read)
gh pr view --json …
```

The line can also make these calls, and no other. `<job>` is a job's id, `<state>` the state folder, `<commit>` a full commit id.

```
git fetch origin <base>
git worktree add <state>/worktrees/<job> -b factory/<job> refs/remotes/origin/<base>
git worktree add --detach <state>/gate/<job> <commit>
git worktree add --detach <state>/worktrees/<job> <commit>   (/factory plan: a copy of the base, on no branch)
git worktree remove --force <state>/worktrees/<job>      (or <state>/gate/<job>)
git push origin <commit>:refs/heads/factory/<job>
git … merge --no-edit <commit>                           (the job's worktree, see below)
git … merge --abort
git rev-parse --verify refs/remotes/origin/<base>^{commit}
git rev-parse --verify refs/heads/factory/<job>^{commit}
git show <commit>:.claude/factory.json
git diff --name-only --no-renames -z <commit>...<commit>
git … status --porcelain --no-renames --untracked-files=all --ignore-submodules=all -z
git … add -A                                             (what the builder left)
git … diff --cached --raw --no-renames --no-abbrev -z
git … commit --no-verify --no-gpg-sign -m "Factory: item <id>, round <n>"
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

git branch -D factory/<job>                              (a job that ended)
```

Each `gh` call of the second list ends with `-R <owner>/<name>`. The line's `git` calls run with `GIT_NO_REPLACE_OBJECTS=1`, and all of them run in your repository's folder. `git …` stands for `git --git-dir=<repo's git folder>/worktrees/<job> --work-tree=<state>/worktrees/<job> -c core.fsmonitor=false -c core.hooksPath=/dev/null`: a call that needs a job's worktree names it, so git reads no setting from a folder that an agent can write to.

`git` reads the repository's own git settings, as it does when you type the command.

### Every `az` call

`…` stands for `--org https://dev.azure.com/<organization> --detect false --output json`. `<file>` is a file the plugin wrote in its state folder (`tmp/`) and removes after the call.

```
az boards query --wiql "SELECT … WHERE [System.TeamProject] = '<project>' AND [System.Tags] CONTAINS '<mark>' AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') …" --project <project> …
az boards work-item show --id <n> --expand fields …
az devops invoke --area wit --resource comments --route-parameters project=<project> workItemId=<n> --query-parameters $top=50 order=desc --api-version 7.1-preview …
az boards work-item update --id <n> --fields=System.Tags=<the tags> …
az boards work-item update --id <n> --discussion=@<file> …
az repos pr work-item add --id <pr> --work-items <n> …
az repos pr create --draft true --source-branch factory/<job> --target-branch <base> --title=@<file> --description=@<file> --project <project> --repository <repository> …
az repos pr show --id <pr> …
az repos pr list --source-branch <branch> --status all --top 1 --project <project> --repository <repository> …
az repos pr policy list --id <pr> …
az repos pr update --id <pr> --draft false …
az repos pr update --id <pr> --status abandoned …
az devops invoke --area git --resource pullRequestThreads --route-parameters project=<project> repositoryId=<repository> pullRequestId=<pr> --http-method POST --in-file <file> --api-version 7.1 …
az account show --query user.name --output tsv           (whose comments an agent may read)
```

### Every `docker` call

`<name>` is `factory-job-<job>.<label>` or `factory-gate-<job>.<label>`; `<label>` is the name of the repository's state folder. `<folder>` is the job's worktree, or the gate's clean copy. `…` in the two `run` lines stands for the same words: `--name <name> --label factory.state=<label> --init --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory <m> --cpus <n> --network bridge|none --user <your uid>:<your gid> -e HOME=/tmp -v <folder>:<folder> -w <folder>`.

```
docker image inspect --format {{.Id}} <image>            (/factory run: is the image there)
docker run --pull never --rm … --entrypoint sh <image> -c <command>   (one command of the builder)
docker run --pull never -d … --entrypoint sleep <image> infinity      (the gate's container)
docker exec -w <folder> <name> <a gate command>
docker rm -f <name>
docker ps -a --filter label=factory.state=<label> --format {{.Names}}
```

The plugin fetches no image and tells Docker to fetch none, mounts no other folder and nothing from inside that folder, and never names the Docker socket.

Before a `git` call on a job's folder it runs `find <folder> -mindepth 1 -iname .git -print`.

`claude plugin validate factory` prints exactly what it hooks and calls.

## Troubleshooting

**The pane does not appear.** Check `claude --version` is 2.1.322 or later, then `/reload-plugins` and `/factory`. A dim line that starts with `factory:` in the transcript names the reason.

**`gh could not start` or `gh is not logged in`.** Install the GitHub CLI, then run `gh auth login`.

**`az could not start`, `az is not logged in`, or `az has no azure-devops extension`.** Install the Azure CLI; run `az login`; run `az extension add --name azure-devops`. The plugin tells `az` not to install a missing extension by itself, and stops each call after 30 seconds.

**`The tracker's place is named by the settings file, not by the remote. …`** Read its `[tracker]` line in the pane, then `/factory approve`. The sentence names no place: the answer goes to the chat, and the settings file is not approved yet.

**`The remote origin names no Azure DevOps project. …`** The settings say `azure-boards`, and the remote is not on `dev.azure.com`. Set `tracker.project` to `<organization>/<project>`.

**`/factory run needs a pull request host: …`** The remote `origin` is neither on `github.com` nor on `dev.azure.com`. The line ends a job as a pull request, so it needs one of the two.

**`The line did not start (the tracker could not be read: …)`.** The tracker's tool is missing or not logged in; the text says which. Fix it and run the command again.

**`SETTINGS NOT APPROVED`.** Read the commands in the pane, then run `/factory approve`. If the pane had not shown them yet, or the file changed since, the pane shows them now; read them and run the command again.

**`Another session runs the line (…). Nothing was changed.`** Another Claude Code session in this repository holds the lock; the text names its folder. Run the command there, or close that session and wait five minutes.

**`No gate, no factory: …`.** `/factory run` needs fast checks in `gate.fast`, in the settings file as it is on the base branch on the remote, and approved with `/factory approve`.

**`No container, no factory: …`.** `set factory.container …`: add `"factory": { "container": { "image": "node:22" } }` (your image) to the settings file, commit it to the base branch and push. `the container settings are not approved`: read the `[container]` line in the pane, then `/factory approve`. `docker is not on this machine` or `docker does not answer`: install Docker, or start it. `the image … is not on this machine`: run the `docker pull` the message names.

**The builder is told `A container of this job may still run …`.** Docker did not confirm that a command's container stopped. Start Docker; the builder's next command removes the container and goes on. A job that ends this way asks you: `/factory answer <id>` after Docker runs again.

**The builder says a command `was not run`.** The message names the reason (Docker stopped, the image is gone, the container settings changed). Fix it; `/factory answer <id>` starts the station again.

**`the code folder holds a git repository of its own (…)`.** The builder made a git repository inside the job's folder, or changed the folder's `.git` file. The plugin runs no `git` on such a folder. Remove the entry the message names with `rm -rf <state>/worktrees/<job>/<entry>` (do not run `git` in that folder), then `/factory answer <id>`; or `/factory reject <id> <reason>`.

**`Factory: a container of <id> could not be stopped. …`.** Docker did not confirm that the job's containers are gone, so the plugin left the job's folders. Start Docker; a later `/factory run` removes them.

**The gate fails on a command that needs `git`.** The git folder is not in the container. Use a gate command that does not need it.

**`Factory: an agent started outside the fence. The line is stopped.`** The plugin starts each agent and checks that its fence saw the start. This says it did not: the line stops itself. Tell the plugin's author; it means Claude Code changed how a plugin starts an agent.

**A job says `The <role> did not answer.`** Its agent ended with no answer, or the session was closed. `/factory answer <id>` starts the station again.

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

The keys in the pane. A run of one command that is longer than ten minutes.

## License

MIT
