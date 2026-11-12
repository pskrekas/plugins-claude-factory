# R1 check (design section 12)

## Checked without a terminal session (2026-11-12)

- Claude Code 2.1.322 on macOS. No managed settings file on the machine.
- `claude plugin validate factory`: passed. It lists the hooks `session.start`,
  `command.run{command=factory}` and `ui.render{component=Pane}`.
- `claude plugin test factory`: the pane mounts on `terminal`, `desktop`,
  `vscode` and `mobile`.
- Type check with the build's own declarations: no errors.

Two rules of the mod API found here, which the plan did not know:

- The state contract (`types/index.d.ts`) must be self-contained: no import.
  The model's types are declared there; `core/model.ts` re-exports them.
- A `$.state` atom must be a const of the file that calls `read` or `update`
  on it. It cannot be imported from another file.

## Checked by the owner, in a terminal (2026-11-12)

`claude --plugin-dir ./factory` in this repo, on the branch `phase-1-panel`, then `/factory`.

- [x] The pane opens, docked beside the transcript, in a terminal of 241 by 71.
      It shows `No settings file. Run /factory init.`, `TASK`, the branch
      `phase-1-panel` and `read 4 s ago`. The command answers
      `factory: Factory pane opened.`
- [x] No dim line that starts with `factory:` in the transcript.
- [x] `factory/.claude-plugin/types/` exists after the load, and
      `npx -p typescript tsc -p factory` has no errors.
- [x] Claude Code 2.1.322. The session header shows the plan `Claude Ultra`
      (a personal login, no managed settings).

Not seen yet: a narrow terminal (the pane inline), the sections that need a
settings file, the status line with a value, an alert.

## Whole-plugin check by hand (plan Task 10, Step 6)

To do by the owner, in a scratch git repo with a GitHub remote:

- [ ] `claude --plugin-dir <this repo>/factory`, then `/factory init`. A file
      `.claude/factory.json` appears.
- [ ] `/factory` shows `SETTINGS NOT APPROVED` and the commands. `/factory approve`
      answers `Approved …`.
- [ ] TASK shows the branch (and the pull request, if the branch has one).
- [ ] Add `docs/plans/a/progress.md` with two checkboxes, one ticked. PROGRESS
      shows 50%.
- [ ] CHECKS shows `disk ok`. The status line shows a text.
- [ ] Add a line `BLOCKED: test` to the progress file and wait one minute. A
      toast appears, with a short sound.

## The FACTORY section, by hand (phase 2a)

To do by the owner, in any git repo, with `claude --plugin-dir <this repo>/factory`:

- [ ] `/factory where` prints a folder under your home.
- [ ] Copy the sample jobs: `mkdir -p "<that folder>/jobs" && cp -R <this repo>/docs/examples/factory-jobs/* "<that folder>/jobs/"`.
- [ ] `/factory` in a wide terminal: the FACTORY section shows the line with its
      loops, the job `12` with `fail` under Gate and `now` under Build, and
      NEEDS YOU (2) with a question and `PR 19 is ready. You merge.`
- [ ] The gate's loop (`fail`) is in the warning colour; the `You` count is red.
- [ ] In a narrow terminal the line is the short form (`Q0 I0 S0 B1 …`).
- [ ] The status line shows `factory 1 run, 2 need you`.
- [ ] Remove the sample jobs when done: `rm -r "<that folder>/jobs"`.

## The hands of the line, by hand (phase 2b, part 1)

To do by the owner, in a scratch GitHub repo that has one open issue (say it is
number 1) and a settings file with `"tracker": { "kind": "github" }`, with
`claude --plugin-dir <this repo>/factory`. `gh` must be logged in.

- [ ] `/factory where` prints the state folder. Copy the sample job that waits:
      `mkdir -p "<that folder>/jobs" && cp -R <this repo>/docs/examples/factory-jobs/14-different-fonts "<that folder>/jobs/"`.
      Edit `"itemId": "14"` in its `job.json` to `"1"` (the number of your issue).
- [ ] `/factory`: NEEDS YOU (1) shows `1  Which font is the default?`. The first
      row says `FACTORY`, with nothing about a session at its right (no job runs).
- [ ] `/factory answer 1 Use the first font.` answers `1 goes on in intake.` The
      issue now has the label `factory:in-progress`. The file
      `<that folder>/jobs/14-different-fonts/files/feedback-1.md` holds the text.
- [ ] `/factory`: the job is under INTAKE with `now`, and the first row says
      `no session runs the line`.
- [ ] `/factory stop` answers `The line starts no new station. Running agents
      finish theirs.` The first row of the pane ends with `stopped`.
- [ ] `/factory answer 1` answers `1 does not wait for you (it is in intake).`
- [ ] `/factory reject 1 Only a test.` answers `1 is rejected. The reason is on
      the item.` The issue has a comment `The factory dropped this: Only a test.`,
      no factory label, and is closed as not planned. The job folder is gone from
      `jobs/` and is under `retired/`.
- [ ] `/factory reject 1` (no reason) answers `A reason is needed: …`.
- [ ] Reopen the issue and add the labels `factory` and `factory:in-progress` by
      hand. `/factory` shows `1  claimed in the tracker, no job here. …` under
      NEEDS YOU. `/factory reject 1 Lost.` closes it again.
- [ ] Remove the stop flag when done: `rm "<that folder>/stop"`.

The gate, the worktrees and the pull request calls have tests only: nothing
calls them until the line runs (part 2).

## The line, by hand (phase 2b, part 2)

To do by the owner. It needs a scratch GitHub repository with a small npm project
(`npm test` passes), cloned, with `gh` logged in. The agents cost quota: the two
issues below are small on purpose.

Before:

- [ ] `claude --plugin-dir <this repo>/factory` in the scratch repo. `/factory init`.
      In `.claude/factory.json` keep `gate.fast` as `[["npm","install"],["npm","test"]]`.
      Commit the file to `main` and push.
- [ ] `/factory`, read the commands, `/factory approve` (twice if it says so).
- [ ] Make two issues and put the label `factory` on each. One is clear and small
      ("Add a function `double(n)` to `index.js`, with a test"). One is vague
      ("Make it better").

The dry run:

- [ ] `/factory plan` answers `The plan runs Intake on 2 items. …`. No permission
      question appears. The chat stays free: type a prompt, it is answered.
- [ ] After a minute or two the pane shows `PLAN` with one `accept · risk low` and one
      `asks: …` or `reject: …`, and `1 item would run now.`
- [ ] The two issues have no new label and no new comment.

The run:

- [ ] `/factory run`. The clear issue gets the label `factory:in-progress` and a comment.
      The pane shows its row move: INTAKE, SPEC, BUILD (`builder runs · 1 m`).
- [ ] No permission question appears while the builder works.
- [ ] A draft pull request appears, from the branch `factory/<n>-…`.
- [ ] The row moves to GATE, REVIEW, APPROVE. Then NEEDS YOU shows
      `PR <n> is ready. You merge.`, with a toast and a sound.
- [ ] The pull request is not a draft any more. The issue has a comment with the pull
      request's address and the label `factory:needs-human`.
- [ ] The vague issue is under NEEDS YOU with a question (or is closed with the
      reason). `/factory answer <id> <text>` lets it go on.
- [ ] The session's model said nothing about the agents during the run.

Stops and restarts:

- [ ] Start a run on a third issue, and in the middle `/factory stop`. The agent that
      runs finishes; no new station starts; the first row ends with `stopped`.
- [ ] A second terminal in the same repo: `/factory` shows `another session runs the line`.
- [ ] Close the session in the middle of a station. Open a new one: the pane shows
      `no session runs the line`. `/factory run` goes on with the job.
- [ ] Merge the ready pull request on GitHub. Within about five minutes of an open
      session the job leaves NEEDS YOU and TODAY counts it.

What to write down: any permission question that did appear, any dim line that starts
with `factory:`, and how long and how much each station took.
