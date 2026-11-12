# Phase 2b, part 1 ("the hands"): decisions

Plan: `docs/superpowers/plans/2026-11-12-phase-2b-hands.md`. Built on branch
`phase-2b-hands`, 2026-11-12. 303 tests. A fresh reviewer read the whole branch
at the end; an automated security review read every commit.

## Decisions made while building

Each line: what was decided, why, and what it costs if it is wrong.

1. **The gate runs in a clean copy of one commit**, not in the builder's folder
   (`git worktree add --detach <state>/gate/<job> <commit>`). It is the only
   complete answer to "the gate judges what the branch holds". Cost: the copy
   has no installed packages, so a gate list must start with the install
   command, and every gate run pays for that install. A setting can be added
   later if this is too slow.
2. **The gate uses commit ids only.** It fetches the base, reads
   `refs/remotes/origin/<base>` and `refs/heads/factory/<job>` once each, and
   asks git for the settings file, the changed files and the copy by those
   ids, in the repo, with `GIT_NO_REPLACE_OBJECTS=1`. Cost: a gate needs the
   network (the fetch).
3. **The protected paths are the base branch's**, read with the gate
   commands. `runGate` takes no settings from its caller.
4. **Files that are not committed are a note in the report**, not a failure
   (first built as a failure; the reviewer was right that it costs a round and
   that the clean copy is the guard).
5. **`runGate` answers `sha`**, the commit it judged.
6. **The gate mark is `[gate] `** (first `gate: `): no command line can start
   with `[`.
7. **A folder in `protectedPaths` is protected with or without its last `/`.**
8. **The report keeps the end of both output streams** (half the room each),
   and says when the engine kept only the first 4 MiB.
9. **A file name in the report is one line of code**: control and direction
   characters become `?`, a backtick becomes `'`, 200 characters at most.
10. **The plugin never writes into a folder that an agent may write to.** State
    files are written fresh in `<state>/tmp` and moved into place.
11. **`/factory reject` also drops an item the tracker says is claimed, with no
    job here** (comment and state on the tracker only). The design says "the
    person rejects it or runs it again by id". Cost: a person can drop an item
    that another machine runs.
12. **A reject is done when the tracker and the job say so.** A worktree that
    cannot be removed, or a job folder that cannot be moved to `retired/`, is
    named in the answer and does not undo the reject.
13. **A rejected item is closed first, then its labels go**, so a failed second
    step leaves it visible as claimed and the reject can be run again.
14. **The two state labels are made before the first state is written** (gh
    refuses a label the repository does not have, also one it must remove).
15. **Every `gh` call that writes, and the queue's list, names the repository
    of `origin`** (`-R owner/name`). A remote that names no GitHub repository
    gives no tracker. The panel's own reads of the current branch's issue and
    pull request (phase 1) are as they were.
16. **`/factory stop` takes no lock**: it is the brake, and it changes no job.
17. **An answer to a job that a limit stopped grants only that job's own
    limit**, and then checks the limits again. A limit of the day is not
    lifted by an answer.
18. **A question for the item's author needs text.**
19. **A limit stop in the middle of a Build round does not start a new round**
    when the job goes on (the plan's rule counted it twice).
20. **`/factory init` writes `npm install` first** in an npm repo's gate lists
    (not `npm ci`, which fails with no lock file).
21. **With nobody running the line and no job at a station, the head row's
    right side is empty.** `holder` is in the view; no row shows it.

## For part 2 (the agents and the loop)

- **After a gate that passed, before a push or `readyPr`:** check that
  `headOf(job)` is still the gate's `sha`, or push `<sha>:refs/heads/factory/<job>`.
- **A round that made no commit must fail in Build.** A branch with no commit
  of its own passes the gate on the base's content.
- **The fence must deny writes into `.git`** (the shared config, refs,
  `git replace`). The engine runs git with repo hooks off; the repo's git
  config still applies to the plugin's git calls.
- **`writeJob` does not check the lock itself.** The commands take the lock
  before they write. The loop must do the same; a check inside `writeJob` is
  the stronger form (22 test call sites change).
- **A protected-path stop has no "allow it".** An answer sends the job back to
  the gate, which stops again. Part 2 gives the person a way to allow one path
  for one job, or says to change the branch by hand.
- **A `needs-info` job that resumes** should give Intake the author's new
  comments (design 5.5), not only the person's text.
- **The limit questions** are written by part 2 with the words of `limitOf`
  (`cost limit for the job`, `time limit for the day`, …) and `round limit`.
  A structured limit kind on the job would be better than the words.
- **Feedback files are read by the job's count** (`feedback-1.md` … `feedback-<n>.md`).
- **The gate's copy is one per job** (`gate/<job>`): two gates of one job must
  not overlap. A long gate run needs the lock kept alive.
- **A streamed run** gives the real end of a long output, and a run over ten minutes.
- **Use `npm ci` when a lock file exists** (`/factory init`).

## Small findings, not fixed

- `/factory answer an use blue`: an id that is also part of the command word is cut wrong (`arg.indexOf(id)`). Numbers are safe.
- Text over 20,000 characters is cut with no notice.
- The lock message says `(unknown)` when the holder file is not written yet, and for a missing state folder. A lock left by an interrupted command reads as this session's and is not released by later commands.
- A leftover `gate/<job>` folder that is not a registered worktree fails later gates with no hint; `reject` does not remove it.
- Over 10 claimed items: the count is of the 10 shown, with no "more" line.
- The claimed row names "run it again", which does not exist yet, and does not warn that another machine may run the item. The reject comment does not say that no local job existed.
- `removeWorktree` leaves the local branch `factory/<job>`: a second run of the item fails at `worktree add`.
- `syncBase` says "conflict with <base>" for any failed merge.
- `digitsOf('12-3')` gives issue 123: an id should be a prefix and one number.
- `commentOf` removes joiner characters (some emoji and scripts change).
- Rejecting a job whose pull request is merged closes the item as "not planned".
- `SHAPE` in `hooks/state.ts` is not used. Failed writes leave files in `<state>/tmp`.
- A repeated `/factory reject` after a failure posts the comment again.
- No test holds the lock by this session before a command runs.
- Two sessions in one working tree show the same holder path.

## Known limits

- A gate command runs the branch's code with the person's rights before a reviewer reads it.
- Submodules, LFS and sparse checkouts in the clean copy are not handled.
- POSIX only. GitHub only (Azure DevOps, Jira, Asana come in later phases).
