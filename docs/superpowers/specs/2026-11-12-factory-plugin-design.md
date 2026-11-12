# Factory: a Claude Code plugin with a work panel and a software factory

Date: 2026-11-12. Status: design, waiting for the owner's approval. Nothing is built.

## 1. Intent

A developer who works with Claude Code runs many things at one time: a task from a
tracker, a long build by hand, subagents, several worktrees. Today the developer asks
"where are we?" again and again, and starts every step by hand.

This plugin does two things:

1. **A panel** docked beside the chat. It shows the state of the work, not the state of
   the session: the task, the progress, the agents, the worktrees, the environment checks.
2. **A software factory.** A tracker item with a mark goes in. Agents take it through a
   fixed line of stations. A ready pull request comes out. A person merges it.

The plugin knows no project and no company. A repo tells it what to show and what to
run through one settings file.

Prior art, and what we take from each:

- **Flightdeck** (`scasella/claude-flightdeck`): a Claude Code mod with a docked pane, a
  status line, pure reducers with tests. We take the form: a pane, panels that take no
  room when empty, all logic in pure functions. We do not copy its panels; it shows the
  session (context, cost, permission checks) and a person can install it next to this
  plugin.
- **The "software factory v2"** (`zazencodes/zazencodes-season-3`,
  `src/software-factory-claude-code-v2`): a queue of labelled issues, an intake agent, a
  spec writer, a builder, a script gate, reviewers routed by risk, an approver, state in
  files that only a script writes. We take the line, the loops, the file state, the gate
  before the reviewers, cost and time per job.

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. One look at the panel answers: what is my task, how far is each build, what waits
  for me, is my environment correct.
- G2. A marked tracker item becomes a ready pull request with no step started by hand,
  and every stop for a person is visible and has a reason.
- G3. The line and its loops are always visible in the panel (section 4.2).
- G4. Works in any git repo. With no settings file it shows the general parts.
- G5. Trackers are adapters: GitHub Issues, Azure DevOps Boards, Jira, Asana, and more
  later with one small file each.
- G6. A run can stop at any time (a closed session, a crash) and continue later from
  its files.

**Non-goals**

- It does not merge and it does not deploy. Version 1 has no setting for this.
- It does not replace the tracker's own board, and it is not a general dashboard for
  the session (Flightdeck does that).
- It does not run in the cloud or on a schedule. It runs in a person's Claude Code
  session, when the person starts it.
- It does not handle large work (a multi-week plan). Intake sends that back to a person.

**Anti-goals** (a failure even if it works)

- Any project or company name, ticket prefix, account or email in the plugin's code,
  tests, docs or sample data. The repo is public.
- A password or token stored by the plugin.
- A job that starts with no mark set by a person.
- An agent that changes the checks it is judged by, and passes.
- Cost with no limit.

## 3. Who decided what

**Decided by the owner**

- A Claude Code plugin with a docked panel, in the style of Flightdeck.
- General: any repo, any tracker; integrations with Azure DevOps, Jira, Asana and more.
- Independent of any one project. No project-specific tracker in the plugin.
- A software factory in the style of the video's factory, with its loops.
- The line is always visible in the panel, with the loops from Gate and from Review.
- The repo: `github.com/pskrekas/plugins-claude-factory` (public).
- Factory agents run with no question to the person, inside a fence (section 8.1).
- `/factory run` is one pass: it takes the items that carry the mark now, finishes
  them and stops. It does not watch for new marks.

**My calls** (the owner can change each one)

- C1. The factory is built inside the plugin; we do not install the video's scripts.
- C2. The plugin's own code moves the jobs (section 5.2), not the session's model.
- C3. The factory never merges. A person merges.
- C4. Order of work: the panel, then the factory on GitHub, then Azure DevOps, then
  Jira and Asana (section 11).
- C5. No tokens: adapters use tools where the person is logged in (`gh`, `az`, an MCP
  server).
- C6. Plugin name `factory`; settings file `.claude/factory.json`; the state is kept
  in a folder of the person's own, outside the repo (section 5.3).
- C7. Safety defaults: 2 slots, 3 rounds, low risk only, a cost limit per job and per
  day, a lock, protected paths, a disk guard (section 8).
- C8. Reviewers use a model as strong as the builder. Only "must fix" findings cause a
  loop.
- C9. `/factory plan` is a dry run that builds nothing.
- C10. License MIT.
- C11. Item text is frozen at intake. Answers reach a job only through a command of
  the person who runs the factory (section 5.5).
- C12. The tracker state is the claim on an item (section 5.5).
- C13. The plugin runs no command from a repo's settings file until the person has
  seen and approved the commands (section 8.1).
- C14. With no fast gate checks in the settings, the factory refuses to run. The PR
  host's remote build is shown, and is not part of the state machine.
- C15. If the session reports no token counts per agent, a time limit per job stands
  in for the cost limit and the panel says "cost unknown".
- C16. Against an agent that changes the tests it is judged by, version 1 relies on
  the repo's `protectedPaths`, the code reviewer, and a list of changed test and
  config files shown to the reviewers and to the person. The gate has no diff rules
  of its own.
- C17. The tracker settings carry the scope of `list` (project, and an optional
  query); several repos that share one tracker project use different marks.

## 4. What the person sees

### 4.1 The panel

A pane opened with `/factory`, docked beside the transcript. Sections, top to bottom.
A section with nothing to show takes no room.

| Section | Shows | Source |
|---|---|---|
| TASK | The item of the current branch: id, title, state; its pull request, build state, approvals | Branch name matched by `ticketPattern`; the tracker adapter's read; the PR host |
| FACTORY | The line with a count per station and the loops; one row per running job; NEEDS YOU; the queue size; today's totals; the score | The job files (section 5.3) |
| PROGRESS | Each long build by hand: name, branch, percent, blocked or not | Progress files named in the settings (section 6) |
| AGENTS | Running subagents: the job or task, the role, the model, the time | Session events (`agent.spawn`, `turn.step`, `turn.complete`) |
| CHECKS | Each environment check: ok or the wrong value | Commands in the settings |
| PORTS | Each local service: up or down | Ports in the settings |
| MORE | One line each: WORKTREES (count, merged ones to remove), TESTS (last gate result), OWED (count) | git; the last gate run; the owed file |

Keys, when the pane has focus: a digit opens a NEEDS YOU item; `n` starts the next
queued job; `w`, `t`, `o` open a MORE line.

### 4.2 The line (always visible at the top of FACTORY)

```
 FACTORY ──────────────────────────────────── 2 of 2 slots busy
 Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You
   4        1        0        1       0        0          0        2
                              ^       │        │
                              ├─fail──┘        │
                              └─── changes ────┘
          INTAKE SPEC  BUILD GATE  REVIEW APPROVE
 PROJ-12  done   done  now   -     changes -
          ↺ round 2 of 3 · review sent it back: code changes · ui ok · 14 m · $3.40
 PROJ-15  now    -     -     -     -      -
          round 1 · 1 m · $0.20

 NEEDS YOU (2)
          PROJ-14  Intake asks: which default font?
          PROJ-10  PR 51 is ready. You merge.

 QUEUE    4 items with the mark "factory"
 TODAY    3 done · 41 m · $9.80 · 2 of 3 passed in round 1
```

- The number under a station is the number of jobs there.
- A loop arrow is amber while a job goes back on it. `You` is red when a job waits.
- A job row shows one cell per station: `done`, `ok`, `now`, `fail` (the gate sent it
  back), `changes` (a reviewer sent it back), `-` (not started). The line under it
  shows the round, which station sent it back and why, the time and the cost.
- On the desktop surface the same line can be drawn as a picture with the same arrows.
  The terminal form above is the first one to build.

### 4.3 Status line, alerts, session brief

- **Status line:** one short line, for example
  `PROJ-3 · factory 2 run, 2 need you · build 41% · checks ok`.
- **Alerts** (a toast and a short sound): a job needs the person; a job is ready; a
  progress file says blocked; a check turns wrong.
- **Session brief:** at session start the plugin adds one short section to the system
  prompt, built once and not changed during the session: the ticket id, the branch,
  the progress percents, the owed count (later: the number of jobs that need the
  person). It holds no text other people wrote (an issue's title, a file's heading).

### 4.4 Commands

| Command | Does |
|---|---|
| `/factory` | Opens the pane. `/factory close` closes it. |
| `/factory init` | Looks at the repo (remote, test commands, tracker) and writes a first `.claude/factory.json` for the person to edit. |
| `/factory plan` | Dry run: runs Intake on the queue and shows accept or reject and the risk of each item. Builds nothing, writes nothing to the tracker. |
| `/factory run` | One pass: reads the queue once, runs those items to their end (ready, a stop for the person, or rejected), continues the jobs already in the state folder, then stops. An item marked later waits for the next `/factory run`. `/factory run <id>` runs one. The `n` key in the pane is the same as `/factory run <next id>`. |
| `/factory stop` | Starts no new station. Running agents finish their station. |
| `/factory answer <id> <text>` | Gives a waiting job the person's answer; the job continues. |
| `/factory reject <id> <reason>` | Ends a job; the reason goes to the tracker item. |

## 5. The factory

### 5.1 Stations

| Station | Done by | Result |
|---|---|---|
| Queue | The tracker adapter | Items that carry the mark (default `factory`) |
| Intake | One agent, the strongest model, no shell | `ACCEPT` (scope may be narrowed), `NEEDS-INFO` (a question to the item's author), or `REJECT`; a risk (`low`, `medium`, `high`) and surfaces (`ui`, `security`) |
| Route | Plugin code | The reviewers and models for this job, from the risk and surfaces and the settings |
| Spec | One agent | `spec.md` |
| Build | One agent, in the job's own worktree and branch `factory/<job-id>` | Commits; the first round opens a draft pull request that names the item |
| Gate | Plugin code, no agent | Runs the fast checks. A fail goes back to Build with the log. No reviewer starts. |
| Review | The routed reviewers, in parallel | Each answers `OK` or `CHANGES` with findings marked `must fix` or `note`. The plugin waits for all of them. Any `must fix` sends the job back to Build with all the notes; then Gate again, then all reviewers again. |
| Approve | One agent | `READY`, or `ASK` with one specific question |
| You | The person | Merges the pull request, or answers, or rejects |

Before a job becomes ready, the plugin syncs its branch with the base branch and runs
the **full** checks (section 8.2). A fail goes back to Build.

Each loop back to Build is one round. After `maxRounds` (default 3) with no pass, the
job stops and asks the person.

### 5.2 Who moves the jobs

The plugin's own code is the orchestrator. It is a state machine in the hooks module:

- It registers one agent type per role (`$.agent.register`), hidden from the model.
- It starts each agent itself (`$.agent.spawn`) and reads the answer from the agent's
  `turn.complete`.
- It runs the checks and all git, tracker and PR commands itself (`$.process.run`,
  `$.process.spawn` for a run over ten minutes, `$.mcp.call`).
- It is the only writer of the job files.

The session's model is not the orchestrator. The person can keep using the chat while
the line runs. This is the video's rule ("only the script writes `job.json`") taken
one step further: an agent judges, code decides where the job goes.

Each agent reads files, writes exactly one file in the job folder, and answers with
one line. The detail is in the files; the next agent reads them.

### 5.3 State

```
<state>/                       the person's own folder, never in the repo:
                               $XDG_STATE_HOME/claude-factory/<repo>/ or
                               ~/.local/state/claude-factory/<repo>/, one per
                               repository, shared by its worktrees
  lock                         one session moves the jobs (section 8.1)
  jobs/<job-id>/
    job.json                   stage, round, risk, routing, times, cost, PR, history
    item.md                    the tracker item's text, as quoted data
    intake.md  spec.md  build.md  decision.md
    round-<n>/checks.md  review-<role>.md
    feedback-<k>.md            the person's answers
  worktrees/<job-id>/          the job's worktree, removed when the job ends
```

`job-id` is the tracker id plus a short slug. `stage` is one of: `intake`,
`needs-info`, `spec`, `build`, `gate`, `review`, `approve`, `needs-human`, `ready`,
`done`, `rejected`. Legal moves:

| From | To |
|---|---|
| `intake` | `spec`, `needs-info`, `needs-human` (risk above the limit, or too large), `rejected` |
| `needs-info`, `needs-human` | The stage the job stopped in, or `rejected` |
| `spec` | `build` |
| `build` | `gate` |
| `gate` | `review`, `build` (fail), `needs-human` (rounds or cost limit, protected path) |
| `review` | `approve`, `build` (changes), `needs-human` (rounds or cost limit) |
| `approve` | `ready` (after the sync and the full checks pass), `build` (full checks fail), `needs-human` (`ASK`) |
| `ready` | `done` (the PR host says merged), `build` (the person asks for changes), `rejected` |

Every file an agent writes starts with a `## Summary` of three to five lines. Every
move is added to `job.json`'s history with its time and reason. A new session that
runs `/factory run` reads the folder and continues every job from its stage (G6).

### 5.4 Cost and time

For every agent the plugin starts, it sums the token counts the session reports for
that agent and prices them with a price table in the settings. `job.json` keeps the
sum and the time per station. The figure is an estimate at list prices; on a
subscription it shows relative spend, not a bill. The panel says "est." where there is
room.

**Score** (in TODAY, and in `/factory plan`'s summary): jobs that passed in round 1,
average rounds, average cost per done job.

If the session reports no token counts per agent, the plugin cannot price a job. Then
`factory.timeLimitMin.job` (default 60) and `.day` (default 240), counted as agent
minutes, stand in for the cost limits, and the panel shows "cost unknown" (C15).

### 5.5 The queue, claims and answers

- **Queue.** `list` returns items that carry the mark and are in no factory state. An
  item leaves the queue when the plugin sets `in-progress` at the start of Intake. That
  state is the claim: another machine's `list` no longer returns the item, and the
  start comment names who runs it. An item that is `needs-human`, `done` or `rejected`
  is never picked up by `/factory run`; `/factory run <id>` runs it again on purpose.
- **A lost state folder.** An item that is `in-progress` in the tracker with no
  local job folder is shown in NEEDS YOU as "claimed, no local state"; the person
  rejects it or runs it again by id.
- **Frozen text.** `item.md` is written once, at intake. Later edits and comments on
  the item do not reach an agent by themselves.
- **Answers.** A `NEEDS-INFO` question is posted as a comment on the item. The person
  who runs the factory continues the job with `/factory answer <id> <text>`, or with
  `/factory answer <id>` and no text, which reads the item again and adds only the
  item author's new comments, as quoted data, to `feedback-<k>.md`.
- **Changes on a ready PR.** `ready → build` happens only through
  `/factory answer <id> <text>`. Review comments on the PR are not read by the plugin
  in version 1.

## 6. Settings

One file per repo, `.claude/factory.json`, committed by the repo's owner. Every key is
optional. Example with neutral values:

```json
{
  "ticketPattern": "PROJ-\\d+",
  "tracker": { "kind": "github", "mark": "factory" },
  "prHost": "auto",
  "baseBranch": "main",
  "factory": {
    "slots": 2,
    "maxRounds": 3,
    "maxRisk": "low",
    "costLimitUsd": { "job": 10, "day": 50 },
    "minFreeDiskGb": 15,
    "protectedPaths": [".claude/factory.json", ".github/", "tests/known_failures.txt"],
    "forbiddenCommentWords": [],
    "forbiddenCommands": [["npm", "publish"], ["terraform", "apply"]],
    "timeLimitMin": { "job": 60, "day": 240 },
    "models": { "intake": "strongest", "spec": "strong", "builder": "strong",
                "reviewer": "strong", "approver": "strong" },
    "reviewers": {
      "low": ["code"], "medium": ["code"], "high": ["code"],
      "ui": ["ux", "ui"], "security": ["security"]
    },
    "stations": { "spec": null, "builder": null }
  },
  "gate": {
    "fast": [["npm", "run", "lint"], ["npm", "test", "--", "--changed"]],
    "full": [["npm", "run", "lint"], ["npm", "test"], ["npm", "run", "build"]]
  },
  "progress": { "files": "docs/plans/*/progress.md",
                "done": "- [x]", "open": "- [ ]", "blocked": "BLOCKED" },
  "checks": [
    { "name": "cloud account", "run": ["cloud", "config", "get", "account"], "want": "me@example.com" },
    { "name": "disk", "minFreeGb": 10 }
  ],
  "ports": { "database": 5432, "queue": 7233 },
  "owed": ".claude/owed.md"
}
```

- `tracker` also carries the scope of `list` where the tracker needs one:
  `"project"` (an Azure DevOps project, a Jira project key, an Asana project id) and
  an optional `"query"` to narrow it. GitHub Issues needs none; the repo is the scope.
  Two repos that share one tracker project use different marks (`factory:web`,
  `factory:api`).
- `tracker.kind`: `github`, `azure-boards`, `jira`, `asana`, or `mcp` (section 7.3).
  `prHost`: `auto` reads the git remote (`github.com` → GitHub, `dev.azure.com` →
  Azure DevOps Repos).
- `models` use three tiers (`strongest`, `strong`, `fast`); the plugin maps a tier to
  a model id in one place.
- `stations.<role>` can name a prompt file in the repo that replaces the plugin's own
  agent prompt for that role. `null` uses the plugin's.
- `progress`: a percent is done lines over done plus open lines. `done`, `open` and
  `blocked` are plain text marks, never patterns: a line is done or open when it starts
  with the mark, and blocked when it holds the blocked mark. The defaults are markdown
  checkboxes. `progress.files` and `owed` must be paths inside the repo, and a file
  that is a link to somewhere outside the repo is not read.
- `ticketPattern` is a small subset of regular expressions: plain characters, `.`,
  `\d` `\w` `\s`, simple character classes, `^` and `$`, the repeats `+ * ? {n,m}` on
  one piece, and one capture group. No alternation, no look-around, no back-reference,
  at most 100 characters. It runs before anyone approved the file, so it must not be
  able to run for a long time.
- A check's command must name a program on `PATH` (no `/` in its first word): a check
  runs by itself each minute, and a file of the repo can change after the approval.
  In this phase every command of the plugin (its own `git` and `gh` reads, the
  checks) runs with a `PATH` that has no relative entry and no entry inside the repo;
  the gate's `PATH`, which may need a repo's own tools, is decided in phase 2. A check
  is not run when one of its arguments names a file of the repo. A settings file gets
  at most 20 checks and 20 ports. An approved command that runs code from the repo (a script
  through an interpreter, a test runner) runs what the repo holds at that time; the
  approval covers the command line, not that code.
- `owed`: a markdown file of checkboxes; open boxes are the count.
- With no settings file: no tracker, no factory; the panel shows AGENTS, WORKTREES and
  the branch's pull request when the remote is a known PR host.

`/factory init` writes a first file from what it finds; the person reviews it.

## 7. Trackers and PR hosts

### 7.1 The tracker contract

Every adapter offers the same five actions. The core uses only these.

| Action | Input | Output |
|---|---|---|
| `list` | The mark | Items: id, title, state |
| `read` | The id | Text, author, comments (author and text), state, address |
| `comment` | The id, markdown text | - |
| `setState` | The id, one of `in-progress`, `needs-human`, `done`, `rejected` | - |
| `linkPr` | The id, the PR address | - |

The adapter maps the four states to what its tracker has (a label, a tag, a workflow
state, a section). A new tracker is one new file plus its tests.

### 7.2 Adapters to ship

| Tracker | Reached through | Mark |
|---|---|---|
| GitHub Issues | The `gh` command | Label |
| Azure DevOps Boards | The `az boards` command | Tag |
| Jira | The Atlassian MCP server (`$.mcp.call`) | Label |
| Asana | The Asana MCP server (`$.mcp.call`) | Tag |

The plugin stores no credential. If the tool is missing or not logged in, the panel
says which one and how to log in; nothing else fails.

### 7.3 Other trackers

`tracker.kind: "mcp"` names an MCP server and, for each of the five actions, the tool
to call, an argument template and where the result's fields are. A tracker whose MCP
server has the five actions needs no code in the plugin. (The owner plans one such
tracker; the plugin must not name it.)

### 7.4 PR hosts

Two, both by command line: GitHub (`gh pr`) and Azure DevOps Repos (`az repos pr`).
Actions: open a draft PR, mark it ready, read its state (open, merged, closed), its
build state and approvals, add a comment.

### 7.5 What the factory writes to the tracker

One comment per station result (intake decision, ready, a question, a rejection), each
with the summary lines of that station's file. `setState` at start, at every stop for
a person, at ready, at done. Text in `forbiddenCommentWords` never appears in a
comment; the plugin checks before it sends.

## 8. Safety

### 8.1 Rules that hold always

- **The mark is the trust boundary.** Only an item that carries the mark runs. The
  plugin has no action that sets the mark.
- **Item text is data.** It reaches agents as quoted text in `item.md`, with comments
  only from the item's author and the person who runs the factory. It is never part of
  a prompt. Intake, which reads it first, has no shell and no write tool beyond its one
  file.
- **Consent for commands.** A settings file arrives with a clone, and it names
  commands. The plugin runs none of them until the person has seen the list and
  approved it. "Seen" is exact: `/factory approve` allows only the lines the pane
  showed while it was on screen (placed, and the tab the surface shows), for the repo
  it showed them for; lines the pane has not shown are shown first and approved by a
  second run. Only the person's own Enter at the prompt can approve. The approval is
  stored outside the repo (`$.store`), keyed by the working tree's own `.git` folder; a linked
  worktree uses the main checkout's, but only when the link holds in both directions
  (a folder that merely claims to be a worktree of a repository gets its own key), as the full list of approved command lines (never a digest); a
  command that is not in the list asks again. A command is shown in full, in printable
  ASCII; one with a control character is refused. The list holds the checks' commands;
  the gate's commands get their own approval in phase 2, so a line approved for one
  purpose never runs for another. Until approval the panel shows "settings not
  approved", the number of commands, and the parts that run no settings command. This
  is part of phase 1.
- **The state is not in the repo.** A repo can be handed over with any files in it,
  also with job files. So the jobs and the lock are kept under the person's home
  folder, and a `.factory/` folder that a repo brings is never read.
- **One orchestrator per repo.** The `lock` file of the state folder holds the session id and a heartbeat
  time. A second session shows the line read-only and says who holds the lock. A lock
  with no heartbeat for five minutes can be taken.
- **The fence.** Factory agents run with no permission question to the person. In
  exchange each one is fenced:
  - Each role has a fixed tool list in its agent definition. Intake, Spec, the
    reviewers and Approve read files and write their one file; they have no shell.
    Only the builder has a shell and can edit code.
  - The builder works only in its job's worktree and the job folder. A hook refuses a
    file write outside them.
  - A hook refuses, from any factory agent: a push to a branch that is not
    `factory/<job-id>`, a force push, a merge into the base branch, a PR merge command
    of either PR host, and every command that matches `factory.forbiddenCommands` in
    the settings (the repo lists its deploy and release commands there; the plugin
    knows none).
  - A refusal is written to the job's history. The same command refused twice stops
    the job and asks the person.
  - The fence around shell commands is best effort: a command line can hide what it
    does. The protections that do not depend on it are the separate worktree, the
    branch rule, the plugin never merging, and the remote's own branch protection. The
    builder of the factory checks whether Claude Code's shell sandbox can be required
    for factory agents and, if it can, requires it (R2).
- **Protected paths.** A job whose branch changes or deletes a protected path stops and
  asks the person. The gate runs the checks named in the base branch's settings file,
  not the job branch's copy.
- **Limits.** `slots` jobs at one time. `maxRounds` rounds per job. A cost limit per
  job and per day; at a limit the job, or the whole line, stops and asks. No new job
  starts under `minFreeDiskGb`; a finished job's worktree is removed.
- **`maxRisk`.** Intake's risk above the limit sends the job to the person with
  intake's notes instead of to Spec. The default is `low`.

### 8.2 The gate

- **Fast checks** run on every round, before any reviewer starts.
- **Full checks** run once, after Approve says ready and after the branch is synced
  with the base branch, because another job may have merged since.
- Jobs can share one local database or emulator. The settings can give the gate an
  environment per slot (`gate.env` with `{slot}`), and the builder of the factory must
  make sure two full runs do not run at one time unless the settings allow it.
- Reviewers do not run the test suite. They read the diff. The code reviewer fails any
  test that was weakened, skipped or special-cased to pass.
- The gate writes, in `checks.md`, the list of test files and test or build config
  files the branch changed. The reviewers get this list, and the ready comment shows
  it to the person (C16).
- **No gate, no factory.** If `gate.fast` is empty, `/factory run` refuses and says
  so. `/factory plan` still works. The PR host's remote build state is shown on a
  ready job and in TASK; it does not move a job (C14).

## 9. Architecture

```
 PLUGIN  (knows no project)
   core/       pure functions: settings, job state machine, routing, limits,
               progress and owed parsers, formatters, layout
   adapters/   trackers (github, azure-boards, jira, asana, mcp) · PR hosts (github, azure-repos)
   agents/     one prompt per role
   hooks/      the hooks module: events, commands, the pane, the orchestrator loop
   types/      the state contract
   tests/
 REPO    .claude/factory.json
 HOME    ~/.local/state/claude-factory/<repo>/  (jobs, lock, worktrees)
```

- All behaviour lives in `core/` as pure functions with direct tests. The hooks module
  is thin: it reads events and files, calls `core/`, draws, and runs commands.
- The plugin is a Claude Code mod: `.claude-plugin/plugin.json`,
  `hooks/hooks.json` with one module, a `types/index.d.ts` contract. It is checked with
  `claude plugin validate`, `claude plugin test` and `tsc`.
- Slow reads (tracker, PR host, checks, ports) run on a timer (`$.clock.every`), at
  most once a minute each, never while the pane is closed and the factory is idle, and
  the last value is shown with its age.
- The repo is also the marketplace: `.claude-plugin/marketplace.json` at the root, the
  plugin in a folder. Install: `/plugin marketplace add pskrekas/plugins-claude-factory`.

## 10. Constraints

- Mods are an early-access Claude Code feature; the API can change. The plugin states
  the minimum version it was tested on and fails with one clear line on an older one.
- Under an organization's managed settings or a Team or Enterprise login, Claude Code
  may not run some hooks of a user-installed plugin. The plugin must work with what
  runs and say what is missing.
- Terminal surface first. Desktop, VS Code and mobile must not break; they can be plain.
- Colours come from the Claude Code theme.
- Public repo: neutral sample data everywhere.

## 11. Order of work

Each phase gets its own plan and ends in something a person can use.

1. **Panel.** The pane, the status line, the settings loader, `/factory` and
   `/factory init`, TASK (GitHub Issues read and GitHub PRs), PROGRESS, AGENTS, CHECKS,
   PORTS, MORE, alerts for blocked progress and wrong checks, the session brief.
2. **Factory on GitHub.** The job files and state machine, the lock, the agents, the
   gate, the loops, the limits, the FACTORY section with the line, `/factory plan`,
   `run`, `stop`, `answer`, `reject`, the score.
3. **Azure DevOps.** Boards as a tracker, Repos as a PR host.
4. **Jira, Asana, the `mcp` tracker kind.**

## 12. To check first (before the plan of each phase is final)

- R1. Phase 1: which hooks run under the owner's login type; whether the pane seats in
  the owner's terminal width. Known on 2026-11-12: Claude Code 2.1.322 on macOS, no
  managed settings file on the machine; the login type is not known and is checked
  first, on the owner's machine.
- R2. Phase 2: that an agent started with `$.agent.spawn` can work inside a job's
  worktree (its own working directory, or absolute paths only), run for many minutes in
  the background, and report token counts per agent. If one of these is not possible,
  the fallback is that the session's model starts the agents from a skill while the
  plugin's code still owns every state move and every check. A short throwaway spike
  answers this.
- R3. Phase 4: that the Jira and Asana MCP servers offer the five actions with the
  person's own login. Asana cannot be tested on the machine where this was designed.

## 13. Left to the builder

- File and function names, the exact layout rules of the pane at each width, and the
  key bindings beyond those named here.
- The wording of every agent prompt, within the roles in section 5.1.
- How each adapter maps the four states to its tracker.
- The price table's format and the tier-to-model map.
- How TESTS in MORE gets its value in phase 1, before the gate exists (the simplest
  honest source; it can show nothing).
