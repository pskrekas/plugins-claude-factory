# Phase 2a: decisions made during the build

Each line is a decision that was made to continue, with its cost if it is wrong. The owner can change any of them.

## Decisions

- Ruling: work on a branch in the dedicated clone, no separate worktree — cost if wrong: none.
- Task 1: Ruling: isInside, CONTROL_CHAR, isObject, isText moved to core/rules.ts so settings.ts and factory-settings.ts share them without a circular import — cost if wrong: none.
- Task 2: Ruling: sentBack is cleared when a job reaches approve or ready (a round the reviewers passed has no sender) — the plan did not say when it ends — cost if wrong: the row shows the sender one station less long.
- Task 2: Ruling: a loop to build with no sentBack throws IllegalMove (the plan said 'requires').
- Task 3: Ruling: todayOf gives costUsd null also when no job was updated today (nothing to price) — cost if wrong: none.
- Task 4: Ruling: a .factory (or .factory/jobs) that is a symbolic link is not used either, for reads, writes and the lock ('.factory/ is a link. It is not used.') — same reason as the tracked rule — cost if wrong: a person who links the folder elsewhere loses the line.
- Task 4: Ruling: a folder with no job.json, or with a name that is not a job id, counts as skipped; a plain file under jobs/ is ignored.
- Task 4: Ruling: the fake Io of the unit tests lives in tests/kit.ts (fakeIo) and refresh-unit.test.ts uses it.
- Task 5: Ruling: Row, Tone, clean, wrap, fit moved to core/rows.ts (layout.ts re-exports them) so line.ts and layout.ts do not import each other's helpers in a circle.
- Task 5: Ruling: three widths for a job row: cells of 7 from 60 columns, cells of 4 from 40, and below 40 one plain row (id and stage) — seven cells do not fit under 40 — cost if wrong: none.
- Task 5: Ruling: the short line drops to 'Y' for You, then drops the stations with no job, when it would pass the pane's edge.
- Task 5: Ruling: a count of zero is dim; the section shows its head and the line whenever it shows at all.
- Security review (after Task 4, fail-open trust check): the state moved out of the repo. Ruling: jobs and the lock are kept under the person's home ($XDG_STATE_HOME/claude-factory/<repo>/ or ~/.local/state/claude-factory/<repo>/; core/state-path.ts; Io.stateDir; one folder per repository via consentKeyOf, shared by worktrees). A repo's own .factory/ is never read; the tracked-by-git rule, the link rule and init's .gitignore line are gone. Spec 5.3 and 8.1 updated — tests 'job files inside the repo are never read…', 'the state folder of a repo', 'two working trees of one repository share the jobs' RED→GREEN, suite 168/168 — cost if wrong: the state is less easy to find than a folder in the repo; the README must say where it is.
- Task 6: Ruling: the engine tests keep job files under the kit's state folder (STATE), not under the repo; 'a tracked .factory folder shows a line' became 'job files that a repo brings are not shown'.
- Task 6: Ruling: the mark rule lives in settings.ts (isMark) and the adapter checks it again; listIssues answers { items, result }.
- Security review (state-folder name): the folder name ends with 16 hex digits of the SHA-256 of the repository's path (a pure sha256Hex in core/state-path.ts, checked against the standard vectors), and the folder holds a file `repo` with that path; a folder whose file names another repository is not read, written or locked — tests 'SHA-256', 'a state folder records its repository…' RED→GREEN, suite 180/180.
- Task 7: Ruling: the status part reads 'factory N run, M need you' with 'needs' for one, and shows also with no job running ('factory 0 run, 1 needs you').
- Task 8: Ruling: a new command /factory where prints the state folder of the repo — with the state under the home folder, named by a hash, a person cannot find it otherwise, and the hand check needs it — cost if wrong: one more command.
- Task 8: Ruling: the example jobs are generated once and the test holds the same objects; the README tells how to copy them into the state folder.

## Final review: fixes (one pass, each with a test that failed first; suite 209/209)

- The lock could give `mine` to two sessions (read, then write, then read back). It is now the newest `lock.<n>` folder: of the sessions that try at one moment, one `mkdir` succeeds. Tests: a slow session that saw the lock free, three sessions at one moment, three take-overs of a stale lock.
- `readJobs` dropped every folder after the first 200 in silence. It now says `<n> job folders not read`. Retiring finished jobs is for phase 2b.
- A folder's `.git/config` (`core.worktree`) could point the plugin at another repository, or at a folder above. The top of the working tree is the nearest folder above the session's that holds a `.git`, and only when git, asked from the session's folder, names the same one: git alone can be misled by the folder's config, and the walk alone by a `.git` that another user put in a shared folder (git refuses a repository another user owns). When they do not agree, the session's folder is the top.
- The round limit fired one round late, and nothing let a person grant more. `roundsLeft(job, settings)` says whether a job may loop again; `Job.granted` holds the rounds, dollars and minutes a person added.
- Cost and day limits: a price of zero for real work now counts as no price (the time limit applies); a job keeps its spend per day (`Job.spend`), so the day limit and the day's totals count what was spent that day; `Job.stageMs` keeps the time per station; `addSpend` adds a run.
- With more jobs than the view holds, the counts were of the view. `FactoryView` now carries `counts`, `running` and `waiting` of all jobs, the waiting jobs always get places, and each "more" line sits under the list it cuts.
- A move could write a job that was never read again, and a job file could open a move the table forbids. `move` applies only what is set, cuts its text and needs a question to ask; `parseJob` needs `stoppedIn` exactly while a job asks, in a stage it can go back to; `writeJob` refuses a job that does not read back. A job file has `version: 1`.
- Wide characters (CJK, emoji) pushed rows past the pane and could be cut in half. Rows are now measured and cut by what they take on screen (`displayWidth`, `cutTo`).
- The state folder could end up inside the repo through the environment (`XDG_STATE_HOME`). Such a folder is refused.
- The limits came from an unapproved file with no floor: a risk always has a reviewer, the limits have a ceiling, and the settings file is always a protected path.
- Also done, from the reviewer's small findings and disagreements: a header row over the job cells (the design shows one); a long item id keeps its end; the short line keeps the count of jobs that wait and drops stations from the start; the section takes no room for a queue of nothing.

## Small findings, not fixed

- Alerts are keyed by the item id only: a second question on one job between two reads gives no alert, and a job that vanishes for one read alerts again.
- `clean` joins words across a line break or a tab.
- A lock whose time is in the future is never stale.
- A folder with no `job.json` counts as skipped and the note does not name it.
- One fresh job with no price turns the day's cost to "cost unknown".
- The score lacks the average rounds and the average cost per done job (design 5.4).
- The queue stops at 100 items with no sign; any label that starts with `<mark>:` hides an issue.
- A worktree made with relative paths (`worktree.useRelativePaths`) gets its own state and lock.
- `jobIdOf('12', '3 things')` equals `jobIdOf('12-3', 'things')`; a second run of one item uses the same folder.
- `JobView.title` is carried and not drawn; the mark rule exists twice.
- The read at session start parses every job file before the first prompt.
- A repo that is the home folder gets no state (the state folder would be inside it).

## For phase 2b (from the final review)

- **Lock:** a read-only "who holds it" and a `lock` field in the view (the second session's read-only line); a holder a person can recognise (working tree, start time); `writeJob` should require the lock.
- **Store:** a crash-safe write (write, verify, keep the last good copy; the reader falls back); read one job; find a job by item id; retire finished jobs (a hooks module cannot delete or rename: use a command); keep `job.json` out of the folder agents may write to.
- **Job:** branch, worktree, slot and item address; refused commands ("refused twice stops the job"); who asks the question.
- **State machine:** `/factory reject` on a job in spec, build, gate or review is not a legal move today; a re-run of a done or rejected item has no move; a stop for the day limit has no state for a job in spec or build; after a stop for the round limit the job goes back to gate or review with the same code.
- **View:** items claimed in the tracker with no local job (design 5.5); a sign that no session runs the line; the job id and a checked pull request address per row, for the digit key.
- **Settings:** show the limits for approval, or keep the ceilings; a job's worktree reads its own branch's settings file, and the gate must read the base branch's.
- **Alerts:** the refresh runs only while the pane is on screen, so a job that starts to wait with the pane closed tells nobody.
- **To check on the real engine:** whether `$.fs.write` makes missing folders and whether it is atomic; whether two terminals that resume one session have one session id; whether a real path keeps the typed case on a case-insensitive disk; whether `env.PATH` in `$.process.run` governs the lookup of the program.
