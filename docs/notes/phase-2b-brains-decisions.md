# Phase 2b, part 2 ("the brains"): decisions

Plan: `docs/superpowers/plans/2026-11-12-phase-2b-brains.md`. Built on branch
`phase-2b-brains`, 2026-11-12. 413 tests. An automated security review read every
commit; a fresh reviewer read the whole branch at the end, with 19 probe tests.

## The decision that changed the plan

**Jobs are advanced from the plugin's own running hooks, not from a timer.** The
second engine check (`docs/notes/r2b-check.md`) showed that an agent started from a
timer callback is not seen by the plugin's `agent.spawn` and `tool.check` hooks: it
ran in the session's folder with no check. So `advance` runs in `/factory run`,
`/factory answer` and at the end of every turn; the timer (`watch`) starts no agent,
runs no gate, reads no turn and makes no move.

What follows from it:

- One gate runs at a time, inside a hook, and the other jobs wait while it runs.
- An agent that is gone or too slow makes its job ask at once. Only a hook can start
  an agent, and the timer that sees the silence is not one.
- A call that finds another at work asks it to go round once more. If something is
  still left for a hook and no agent of the line is running, the timer says
  `the line waits` once; `/factory run` goes on.
- The plugin checks that its fence saw each agent it started. One it did not see
  stops the line (`checkedSpawn`).
- The report prompt of the line's own agents is dropped, so the session's model is
  not woken at every station and reads no text an agent wrote.

## Decisions made while building

1. **No git call runs in a folder an agent can write to.** A call that needs a
   job's worktree runs in the repo with `--git-dir` and `--work-tree`, hooks and
   fsmonitor off; the worktree's `.git` file is only a claim, checked both ways, and
   git is given the real folder.
2. **Nothing is pushed before the fast gate passed.** The push and the draft pull
   request come after the gate (the design's table said "Build opens a draft pull
   request"). A branch that changed a protected path is never pushed, so the repo's
   CI never runs it. Cost: a round that fails its gate shows nothing on GitHub.
3. **What is marked ready is the commit the full gate judged.** The base is merged
   in, the full gate runs on that commit, then that commit is pushed and the pull
   request marked ready. The job keeps the commit the reviewers read (`Job.sha`);
   a commit that landed after the review makes the job ask.
4. **A branch with no change fails the gate.**
5. **A station's answers are kept on the job** (`Job.results`), so a new session
   knows what the reviewers that already ended said.
6. **A step that fails is tried once more at the next call; after two tries the job
   waits for the person, with the reason,** also when the tracker cannot be told.
   The label is set before the comment, so a retry never repeats a comment.
7. **A question that holds a forbidden word is still asked,** with a fixed text.
8. **Only the comments of the item's author and of the person who runs the line
   reach an agent** (design 8.1). `/factory run <id>` runs only an item that
   carries the mark.
9a. **Text that an agent wrote is not posted on the item,** except Intake's question or refusal for the item's author (Intake has no shell). A job that waits posts a fixed text; the question is on the job, for the pane. The ready comment holds the pull request's address and the names of changed test files, no report text. The pull request itself is agent-written and public: that cannot be closed.
9. **A job is written only when what is on disk is still the job the step was
   worked out for.** A person's command during a gate wins.
10. **A job that the line ends stays in the state folder for the rest of its day**
    (without its worktree, the gate's copy and its branch), so its spend is in the
    day's total and under the day's limit. It is retired the next day, or when its
    item runs again. `/factory reject` by a person still retires at once.
11. **The day's limit and a full disk end the run** with a line that says so.
12. **A plan job is an ordinary job file with a `plan` row**; its folder is a
    detached copy of the base. A person's commands do not find it. A dry run has
    its own slots.
13. **Prices are empty by default**; with no price the time limits apply.
    `strongest`, `strong`, `fast` are `opus`, `sonnet`, `haiku`.
14. **The engine test of the turn hook asserts the fail-safe.** `claude plugin test`
    does not run the plugin's own `agent.spawn` hook for a spawn the plugin makes;
    the real engine does (r2b). The real path is in the owner's hand check.
15. **No shell sandbox** can be required from an agent spec.

## The fence: what it is, and where it ends

A deny list over the text of a shell command, plus path rules for the file tools
(judged by real path). It was hardened through five rounds of review. The last
ruling: **further "one more spelling" findings are not fixed.** A builder that sets
out to get around a text check can (a script it writes and runs is not read at
all). The README's "Before you run the line" says so.

The fix that would end this class is not more rules: it is to run the builder where
it cannot reach the person's files and logins (a container, a virtual machine, or a
shell sandbox when an agent type can require one). **The owner decided this on
2026-11-12: it is the next plan (2c in the design's order of work), before phase 3.**

Known gaps that were reported and not fixed:

- A command substitution inside a word (`a$(b)c`); the git folder joined to a short
  flag (`-C.git`); `HOME` or `PWD` set without `=` (`read HOME`).
- The fence follows `cd` from one simple command to the next, and holds a path with
  `..` to the worktree too. It starts each shell call at the worktree: if the engine
  keeps the shell's folder between calls, a relative path is judged from the wrong
  place (toward refusing, not toward allowing).
- Reported after the pull request was opened, and not fixed (the same class):
  options of archive and download tools that place files elsewhere (`tar -P`,
  `tar --transform`, `curl -K`, `wget -e`); a link inside the worktree that leads
  out, used in a shell path (the file tools are judged by real path, a shell command
  is judged as text); a long git option cut short (`--upl` for `--upload-pack`) and
  one-letter flags joined together.
- The shell can read any file the person can.
- A script, a `Makefile` target or an `npm` script that the builder writes runs
  unread.

## Small findings, not fixed

- `onSpawn` accepts a spawn with a matching description for a live job from anyone
  who can spawn the type (the type is hidden from the model).
- While a spawn of the line is not settled, tool calls of the person's other
  subagents are refused for that moment.
- The timer runs in every session for its whole life and reads the settings and the
  job files every 15 seconds.
- The lock is not checked again after a gate; a machine that slept for more than
  five minutes in a gate can write under another session's lock.
- Facts are removed from the inbox before they are processed: a throw loses them.
- The old job of an item is found by job id, not item id: a changed title makes a
  second job.
- A queue that cannot be read is reported as "0 items".
- `/factory run` and `/factory answer` answer only when a gate that is due has ended.
- A plan retires a finished real job with the same id.
- The merge of the base goes into the worktree's HEAD, which the builder could have
  left detached.
- `ready -> build` (the person asks for a change) leaves the pull request marked ready.
- A protected-path stop has no "allow it".
- The job id (a slug of the item's title) is in the agent's prompt and paths.
- Agent-written text in comments keeps `@` mentions.
- No decisions about `permissionMode`; the model aliases are not checked against
  every plan.
- From part 1, still open: the id parse in `/factory answer an …`; text over 20,000
  characters is cut with no notice.

## Not checked on a real engine

- A person-facing session: whether anything asks the person despite the fence.
- A hook that awaits a gate for many minutes (40 seconds were measured).
- What happens to running agents when the session ends or the plugin reloads.
- `gh pr ready` on a pull request that is already ready.

The owner's hand check for all of this is the last section of `docs/notes/r1-check.md`.
