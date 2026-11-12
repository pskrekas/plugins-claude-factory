# Factory Plugin, Phase 2b, Part 1: The Hands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the factory line does that is not an agent: writing to the tracker and the pull request host, making and removing a job's worktree, running the gate, and the person's commands on a job (`stop`, `answer`, `reject`). After this plan every such action exists as a tested function; the next plan (the agents and the loop) calls them.

**Architecture:** Pure rules in `factory/core/` (the job's new moves, the gate's judgement, the argument lists of every `git` and `gh` call). Effects in `factory/hooks/` and `factory/adapters/`, all through the `Io` of phase 1, so each is tested with the in-memory `fakeIo` and no real command runs in a test. No agent is started in this plan and nothing here runs by itself: only a person's command, or (next plan) the loop, calls these functions.

**Tech Stack:** as before: TypeScript, the Claude Code mod API, `claude plugin validate`, `claude plugin test`, `tsc`. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-12-factory-plugin-design.md`, sections 4.4 (`stop`, `answer`, `reject`), 5.1 (Gate, You), 5.3, 5.5, 7.1, 7.4, 7.5, 8.1 ("Agents push only `factory/*` branches", "Protected paths", limits), 8.2. Also binding: `docs/notes/phase-2a-decisions.md` ("For phase 2b") and `docs/notes/r2-check.md`.

**Not in this plan** (part 2): registering and starting agents, the fence (`tool.check`), the loop and its timer, `/factory plan`, `/factory run`, cost from token counts, the keys in the pane.

## Global Constraints

- Everything in the earlier plans' Global Constraints still holds. In short: no project or company names; no stored tokens; rules in `factory/core/` as pure functions; code outside `register.tsx` takes an `Io`; every text drawn goes through `clean()`; no row wider than the pane.
- **Arguments, never a shell.** Every command is an argument list. A value that comes from a tracker item, a job file or a settings file is never the first word of a command and never starts an argument with `-` unless it follows an option that takes a value. Long or multi-line text (a comment, a pull request body) goes to the command on standard input, never as an argument.
- **The factory never merges, never force-pushes, never deploys, never pushes a branch that is not `factory/<job-id>`.** No function in this plan builds such a command; a test in Task 5 lists every `git` and `gh` argument list this plan can build and checks them against these rules.
- **Only a person's Enter** (`origin.kind === 'composer'`) runs `/factory stop`, `/factory answer`, `/factory reject`, as for `/factory approve`.
- **A job is changed only with the lock held** (`takeLock` answers `isHeld: true`). A command that cannot take the lock answers who holds it and changes nothing.
- **Gate commands** run only when each one is on the approved list, and they are read from the **base branch's** settings file, never from the job's branch.
- The state folder is the one from phase 2a (`/factory where`). Worktrees live in it, not in the repo.
- Comments to the tracker: at most 60,000 characters; text in `forbiddenCommentWords` (compared without case) is never sent, the comment is refused whole.

**Commands used by every task**

```bash
claude plugin validate factory
claude plugin test factory
npx -p typescript tsc -p factory
```

## Review Focus

1. **An item whose title or text starts with `-` or holds quotes, newlines or `$(…)`.** Every `gh` and `git` call still gets it as plain data; nothing is run or read as an option. (Tasks 3, 4, 5)
2. **`gh` missing, logged out, or the network down in the middle of `reject`.** The job is left in a state the person can retry from; the answer says which step failed; nothing is half-recorded as done. (Task 8)
3. **Two sessions run `/factory answer` on one job at one moment.** One changes the job; the other answers who holds the lock. (Tasks 2, 8)
4. **A job branch that edits the settings file or a protected path to make its own gate pass.** The gate fails with `protected path` and names the file; the commands it ran were the base branch's. (Tasks 6, 7)
5. **A gate command that prints 50 MB or never ends.** The report keeps the last 4,000 characters; the run ends at the time limit as a failure; the job is not left "in the gate" for good. (Task 7)

## File Structure

```
factory/core/job.ts                + moves and fields for the real line
factory/core/git-args.ts           the argument list of every git call; branch and path rules
factory/core/gate.ts               protected paths, changed test files, the report
factory/core/comment.ts            what may be sent to a tracker
factory/hooks/jobs.ts              + read one, find, retire, atomic write, feedback and job files, the stop flag, lock info
factory/hooks/worktrees.ts         add, remove, push, sync, changed files
factory/hooks/gate.ts              the gate's commands from the base branch; the run
factory/hooks/commands.ts          stop, answer, reject
factory/adapters/tracker.ts        + Run with standard input
factory/adapters/github-issues.ts  + comment, setState, linkPr, close, labels, claimed items
factory/adapters/github-pr.ts      + create a draft, mark ready, read by number, comment, close
factory/core/settings.ts           + the approval list holds the gate's commands, marked
factory/hooks/io.ts, register.tsx  + standard input for a command
factory/core/line.ts, types        + who runs the line; items claimed with no job
```

---

### Task 1: The job's moves for the real line

**Files:**
- Modify: `factory/core/job.ts`, `factory/types/index.d.ts` (the stage union does not change)
- Test: `factory/tests/job.test.ts` (extend)

**Interfaces:**
- Produces (additions to `Job`; a file without them reads with the default, so version 1 files stay readable):

```ts
branch: string | null      // 'factory/<job id>' once the worktree exists; default null
itemUrl: string | null     // the tracker item's address; default null
asker: 'intake' | 'gate' | 'review' | 'approve' | 'limit' | null   // who stopped the job; default null
refusals: number           // commands the fence refused; default 0
feedback: number           // how many feedback files the job has; default 0
```

```ts
export function grant(job: Job, more: { rounds?: number; usd?: number; minutes?: number }, now: number): Job
export function stop(job: Job, why: { question: string; asker: NonNullable<Job['asker']>; resumeAt?: Stage }, now: number): Job
export function resume(job: Job, reason: string, now: number): Job
export function reject(job: Job, reason: string, now: number): Job
```

Rules:
- `TRANSITIONS` gains `rejected` from `spec`, `build`, `gate`, `review`, `approve`, and `needs-human` from `spec` and `build` (a cost or day limit can stop a job anywhere). A job can go back to `build` from a waiting stage.
- `move`'s `set` gains `stoppedIn`, `asker`, `branch`, `itemUrl`. For a move to `needs-info` or `needs-human`, `stoppedIn` is `set.stoppedIn` when given, else the rule of phase 2a; it must be one of `intake`, `spec`, `build`, `gate`, `review`, `approve`. Leaving a waiting stage clears `asker` too.
- A move to `build` **from a waiting stage** is a new round (`round + 1`) when the job has a `sentBack`; else the round stays.
- `stop` is `move(job, question's stage, …)`: `needs-info` when `asker === 'intake'` and no `resumeAt` is given, else `needs-human`; it sets `question`, `asker` and `stoppedIn` (`resumeAt`).
- `resume` moves a `needs-info` or `needs-human` job to its `stoppedIn`; it throws `IllegalMove` for any other stage.
- `reject` moves any job that is not `done` or `rejected` to `rejected`; it throws `IllegalMove` for those two.
- `grant` adds to `granted` (never below zero), sets `updatedAt`, changes nothing else.

- [ ] **Step 1: Write the failing tests** (add to `job.test.ts`)

```ts
test('a file without the new fields still reads, with the defaults', async () => {
  const { branch, itemUrl, asker, refusals, feedback, ...old } = job()
  const read = parseJob(JSON.stringify(old), old.id)
  expect([read?.branch, read?.itemUrl, read?.asker, read?.refusals, read?.feedback]).toEqual([null, null, null, 0, 0])
  expect(parseJob(JSON.stringify({ ...job(), refusals: -1 }), job().id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), asker: 'nobody' }), job().id)).toBe(null)
  expect(parseJob(JSON.stringify({ ...job(), branch: 'main' }), job().id)).toBe(null)   // only factory/<its id>
})
test('a job can be rejected from any stage it is alive in', async () => {
  for (const stages of [[], ['spec'], ['spec', 'build'], ['spec', 'build', 'gate'], ['spec', 'build', 'gate', 'review', 'approve', 'ready']] as Stage[][]) {
    expect(reject(walk(stages), 'dropped', 5).stage).toBe('rejected')
  }
  expect(() => reject(reject(job(), 'x', 1), 'again', 2)).toThrow(IllegalMove)
})
test('a limit can stop a job in spec or build, and it goes back there', async () => {
  const stopped = stop(walk(['spec', 'build']), { question: 'Cost limit for the day.', asker: 'limit' }, 9)
  expect([stopped.stage, stopped.stoppedIn, stopped.asker, stopped.question]).toEqual(['needs-human', 'build', 'limit', 'Cost limit for the day.'])
  const back = resume(stopped, 'the person said go on', 10)
  expect([back.stage, back.round, back.asker, back.question]).toEqual(['build', 1, null, null])
})
test('a job with no rounds left stops at the gate and resumes in build, as a new round', async () => {
  const atGate = walk(['spec', 'build', 'gate'])
  const failed = { ...atGate, sentBack: { by: 'gate' as const, why: '2 tests failed' } }
  const stopped = stop(failed, { question: '3 rounds with no pass.', asker: 'limit', resumeAt: 'build' }, 9)
  expect(stopped.stoppedIn).toBe('build')
  const back = resume(grant(stopped, { rounds: 1 }, 10), 'one more round', 11)
  expect([back.stage, back.round, back.granted.rounds, back.sentBack?.by]).toEqual(['build', 2, 1, 'gate'])
})
test('intake asks the author; resume goes back to intake', async () => {
  const asked = stop(job(), { question: 'Which font?', asker: 'intake' }, 2)
  expect([asked.stage, asked.stoppedIn]).toEqual(['needs-info', 'intake'])
  expect(resume(asked, 'answered', 3).stage).toBe('intake')
  expect(() => resume(job(), 'x', 1)).toThrow(IllegalMove)
})
test('grant adds and never goes below zero', async () => {
  expect(grant(grant(job(), { rounds: 2, usd: 5 }, 1), { rounds: -5, minutes: 30 }, 2).granted).toEqual({ rounds: 0, usd: 5, minutes: 30 })
})
```

- [ ] **Step 2: Run** — `claude plugin test factory` — Expected: FAIL (`stop` is not exported).
- [ ] **Step 3: Implement.** `branch` is valid only as `factory/` followed by the job's own id.
- [ ] **Step 4: Run** — test, tsc — Expected: PASS; the 212 earlier tests still pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: the job's moves for the real line"`

---

### Task 2: The store, for a line that writes

**Files:**
- Modify: `factory/hooks/jobs.ts`, `factory/hooks/io.ts`, `factory/hooks/register.tsx` (`Io.run` takes `stdin`), `factory/core/lock.ts` (the holder's working tree), `factory/tests/kit.ts` (`fakeIo`: `cp`-free `mv` of one file, a `stdin` log)
- Test: `factory/tests/jobs.test.ts` (extend)

**Interfaces:**
- `Io.run(argv, init?: { cwd?: string; timeoutMs?: number; stdin?: string; env?: Record<string, string> })`. In `register.tsx` the given `env` is laid over `{ PATH: safePath(…) }`; `PATH` itself cannot be replaced by a caller.
- Produces:

```ts
export async function readJob(io: Io, root: string, id: string): Promise<Job | null>
export function findJob(jobs: Job[], itemId: string): Job | null            // the newest job of that item
export async function writeJob(io: Io, root: string, job: Job): Promise<void>   // now atomic
export async function retireJob(io: Io, root: string, id: string, now: number): Promise<void>
export async function writeJobFile(io: Io, root: string, id: string, name: string, text: string): Promise<void>
export async function addFeedback(io: Io, root: string, job: Job, text: string): Promise<Job>
export async function setStop(io: Io, root: string, isOn: boolean): Promise<void>
export async function isStopped(io: Io, root: string): Promise<boolean>
export async function lockInfo(io: Io, root: string, now: number): Promise<{ state: 'free' | 'mine' | 'theirs'; holder: string | null }>
export async function stateDirOf(io: Io, root: string): Promise<string | null>
```

Rules:
- `writeJob` writes `jobs/<id>/job.json.tmp`, reads it back and parses it, then renames it over `job.json` with `mv -f` (one rename: a reader sees the old file or the new one, never half of one). `readJobs` and `readJob` never read a `.tmp` file. If the rename fails, `writeJob` throws and `job.json` is as it was.
- `retireJob` moves `jobs/<id>` to `retired/<id>.<now>` with `mv`. A retired job is not listed by `readJobs`. (A hooks module cannot delete; retired folders stay.)
- `writeJobFile`: `name` must match `^(round-\d{1,3}/)?[a-z][a-z0-9-]{0,40}\.md$`; text is cut to 256 KiB. It writes `jobs/<id>/files/<name>`: agents' files live under `files/`, beside `job.json`, so a fence can let an agent write there and never to `job.json`.
- `addFeedback` writes `files/feedback-<n>.md` with `n = job.feedback + 1` and answers the job with `feedback: n`. It does not write `job.json`.
- `setStop(true)` writes the file `stop` in the state folder; `setStop(false)` empties it; `isStopped` is true when the file has text.
- `lockInfo` reads only: `mine` when the newest lock folder names this session, `theirs` with the holder's text when another session holds a fresh lock, else `free`. The holder file gains `tree` (the working tree's path, cut to 120): `lockText(session, now, tree)`; `holderOf` answers `<tree>` when it is there, else the session id.

- [ ] **Step 1: Write the failing tests**, with `fakeIo`:
  - `a job is written through a temporary file and a rename`: after `writeJob` the file `job.json` holds the job and no `job.json.tmp` is left; `io.ran` holds one `mv -f … job.json.tmp … job.json`.
  - `a rename that fails leaves the old job`: make the fake's `mv` answer exit 1 once; `writeJob` rejects; `readJob` still gives the old job.
  - `a temporary file is never read as a job`: a folder with only `job.json.tmp` counts as skipped, and `readJob` gives null.
  - `readJob and findJob`: `readJob` gives one job, null for an unknown id and for an id that is not a job id; `findJob` gives the newest of two jobs of one item, null for none.
  - `a retired job is gone from the list and its folder is kept`: after `retireJob` the list is empty and a path under `retired/` holds the old `job.json`.
  - `a job's files go under files/, by name`: `writeJobFile(…, 'round-2/checks.md', 'x')` writes `jobs/<id>/files/round-2/checks.md`; names `../x.md`, `job.json`, `a/b/c.md`, `X.md` reject.
  - `feedback files are numbered`: two calls write `feedback-1.md` and `feedback-2.md`; the answered job has `feedback: 2`.
  - `the stop flag`: off at first, on after `setStop(true)`, off after `setStop(false)`.
  - `lockInfo reads and never writes`: `free` with no lock and no file written; after another session's `takeLock`, `theirs` with its working tree as holder; after this session's, `mine`.
  - `kit.ts`: the `engine` records the standard input of every command (`world.stdins`), and `fakeIo` records it too (`io.stdins`). Task 8's reject test asserts on it.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — validate, test, tsc — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: an atomic job write, retired jobs, job files, the stop flag, lock info"`

---

### Task 3: Writing to the tracker (GitHub Issues)

**Files:**
- Create: `factory/core/comment.ts`
- Modify: `factory/adapters/tracker.ts`, `factory/adapters/github-issues.ts`
- Test: `factory/tests/tracker-write.test.ts`

**Interfaces:**
- `Run` becomes `(argv: string[], stdin?: string) => Promise<RunResult>`.
- Produces:

```ts
// core/comment.ts
export const MAX_COMMENT = 60_000
export function commentOf(text: string, forbidden: string[]): { ok: string } | { no: string }
// adapters/github-issues.ts
export const stateLabel = (mark: string, state: 'in-progress' | 'needs-human') => `${mark}:${state}`
export async function ensureLabels(run: Run, mark: string): Promise<RunResult>
export async function commentIssue(run: Run, id: string, markdown: string): Promise<RunResult>
export async function setIssueState(run: Run, id: string, mark: string, state: TrackerState): Promise<RunResult>
export async function closeIssue(run: Run, id: string): Promise<RunResult>
export function githubIssues(run: Run, mark: string, forbidden: string[]): Tracker    // all five actions
// listIssues additionally answers `claimed`: the open items that carry `<mark>:in-progress`
```

Rules:
- `commentOf`: `{ no: 'a forbidden word' }` when the text holds one of `forbidden` (compared without case, as a substring); `{ no: 'empty' }` for no text; else `{ ok }` with the text cleaned of control characters other than newline and tab, and cut to `MAX_COMMENT` with a last line `(cut)` when it was longer.
- An issue id is used as its digits only (as `readIssue` does); an id with no digit runs nothing and answers `{ failed: 'other' }`.
- Argument lists, exactly:
  - `ensureLabels`: `gh label create <mark>:in-progress --force --description "The factory works on this"` then the same for `<mark>:needs-human` with `"The factory waits for a person"`. The mark must pass `isMark`.
  - `commentIssue`: `gh issue comment <n> --body-file -` with the text on standard input.
  - `setIssueState`: `in-progress` → `gh issue edit <n> --add-label <mark>:in-progress --remove-label <mark>:needs-human`; `needs-human` → the two swapped; `done` → `gh issue edit <n> --remove-label <mark>:in-progress --remove-label <mark>:needs-human`; `rejected` → the same removal, then `closeIssue`.
  - `closeIssue`: `gh issue close <n> --reason "not planned"`.
  - `linkPr` (the adapter's method): a comment `Pull request: <url>`; the url must start with `https://`.
- The adapter's `comment` runs `commentOf` first and throws with its reason on `{ no }`; every method throws `Error('gh: <first 200 characters of stderr, cleaned>')` when the command fails.

- [ ] **Step 1: Write the failing tests.** Pure, `commentOf`:

```ts
expect(commentOf('Looks good', [])).toEqual({ ok: 'Looks good' })
expect(commentOf('Written by ACME bot', ['acme'])).toEqual({ no: 'a forbidden word' })
expect(commentOf('  \n ', [])).toEqual({ no: 'empty' })
expect(commentOf('a\u001b[2Jb\tc\nd', [])).toEqual({ ok: 'a[2Jb\tc\nd' })
const long = commentOf('x'.repeat(70_000), [])
expect('ok' in long && long.ok.length <= MAX_COMMENT && long.ok.endsWith('\n(cut)')).toBe(true)
```

  With a recording `run` (answers exit 0): the exact argument lists above for each function and state, with id `PROJ-12` giving `12`; the comment text is on standard input and in no argument; a body that starts with `--help` or holds `$(rm -rf x)` and newlines is on standard input unchanged; an id `abc` runs nothing; `ensureLabels(run, '--web')` runs nothing; `githubIssues(run, 'factory', ['acme']).comment('12', 'by ACME')` rejects and runs nothing; a failing `run` (`exitCode: 1, stderr: 'no such issue'`) makes `setState` reject with `gh: no such issue`; `listIssues` answers `claimed` with the item that carries `factory:in-progress`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: comments, states and links on GitHub issues"`

---

### Task 4: Writing to the pull request host (GitHub)

**Files:**
- Modify: `factory/adapters/github-pr.ts`
- Test: `factory/tests/pr-write.test.ts`

**Interfaces:**
- Produces:

```ts
export function parsePrUrl(stdout: string): { number: number; url: string } | null
export async function createDraftPr(run: Run, pr: { head: string; base: string; title: string; body: string }): Promise<{ pr: { number: number; url: string } | null; result: RunResult }>
export async function readyPr(run: Run, number: number): Promise<RunResult>
export async function readPrByNumber(run: Run, number: number): Promise<{ pr: PrState | null; result: RunResult }>
export async function commentPr(run: Run, number: number, markdown: string): Promise<RunResult>
export async function closePr(run: Run, number: number): Promise<RunResult>
```

Rules:
- `createDraftPr`: `gh pr create --draft --head <head> --base <base> --title <title> --body-file -`, the body on standard input. `head` must be `factory/<job id>` and `base` a branch name by the rule of `settings.ts`; else nothing runs and `pr` is null. The title is cut to 200 characters and cleaned; a title that would start with `-` gets a leading space removed and is passed as the value of `--title` (it is an option's value, so it is data).
- `parsePrUrl`: the last line of the output that matches `^https://github\.com/[^/\s]+/[^/\s]+/pull/(\d+)$`.
- `readyPr`: `gh pr ready <n>`. `readPrByNumber`: `gh pr view <n> --json number,state,isDraft,reviewDecision,statusCheckRollup,url`. `commentPr`: `gh pr comment <n> --body-file -`. `closePr`: `gh pr close <n>`.
- A number that is not a positive whole number runs nothing.
- **No function here merges.** The file holds the comment `The factory never merges: there is no merge call in this file, and a test says so.`

- [ ] **Step 1: Write the failing tests:** the exact argument lists; the body on standard input; `parsePrUrl('Creating…\nhttps://github.com/a/b/pull/21\n')` gives `{ number: 21, url: 'https://github.com/a/b/pull/21' }`, and `https://github.com.evil.example/a/b/pull/1`, `not a url` give null; `createDraftPr` with head `main`, head `factory/../x`, base `--force` runs nothing; a title `--help me` reaches `gh` as the argument after `--title`; `readyPr(run, 0)` and `closePr(run, 1.5)` run nothing; and a test that reads the lists a recording `run` saw across every function of this file and asserts none holds the word `merge`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: draft pull requests on GitHub"`

---

### Task 5: Worktrees and branches

**Files:**
- Create: `factory/core/git-args.ts`, `factory/hooks/worktrees.ts`
- Test: `factory/tests/worktrees.test.ts`

**Interfaces:**
- Consumes: `stateDirOf` (Task 2), `isJobId` (phase 2a), the branch name rule of `settings.ts` (export it as `isBranchName`).
- Produces:

```ts
// core/git-args.ts — every git call the factory makes, as a pure argument list
export const branchOf = (jobId: string) => `factory/${jobId}`
export function gitArgs(call:
  | { do: 'fetch'; base: string }
  | { do: 'add'; path: string; jobId: string; base: string }
  | { do: 'remove'; path: string }
  | { do: 'push'; jobId: string }
  | { do: 'merge-base'; base: string }                 // sync: merge origin/<base> into the job branch
  | { do: 'abort-merge' }
  | { do: 'changed'; base: string }                    // names of files the branch changed
  | { do: 'head' }
): string[] | null                                     // null when a value breaks a rule
// hooks/worktrees.ts
export async function worktreePath(io: Io, root: string, jobId: string): Promise<string | null>
export async function addWorktree(io: Io, root: string, jobId: string, base: string): Promise<{ ok: true; path: string; branch: string } | { ok: false; why: string }>
export async function removeWorktree(io: Io, root: string, jobId: string): Promise<{ ok: boolean; why?: string }>
export async function pushBranch(io: Io, root: string, jobId: string): Promise<{ ok: boolean; why?: string }>
export async function syncBase(io: Io, root: string, jobId: string, base: string): Promise<{ ok: boolean; why?: string }>
export async function changedFiles(io: Io, root: string, jobId: string, base: string): Promise<string[] | null>
```

Rules:
- Argument lists, exactly: `fetch` → `git fetch origin <base>`; `add` → `git worktree add <path> -b factory/<jobId> origin/<base>`; `remove` → `git worktree remove --force <path>`; `push` → `git push -u origin factory/<jobId>:factory/<jobId>` (the source and the target are both spelled, so it can only ever push that branch to itself); `merge-base` → `git merge --no-edit origin/<base>`; `abort-merge` → `git merge --abort`; `changed` → `git diff --name-only -z origin/<base>...HEAD`; `head` → `git rev-parse HEAD`.
- `gitArgs` answers null when `jobId` is not a job id, `base` is not a branch name, or `path` is not an absolute path with no `..` segment.
- The worktree's path is `<state folder>/worktrees/<jobId>`. `addWorktree` runs `fetch`, then `add`, in the repo's root; `removeWorktree` runs `remove` in the root (`--force` here removes the folder of a job that ended, with whatever it holds; it is the worktree's own flag, not a push); `pushBranch`, `syncBase`, `changedFiles` run in the worktree. `syncBase` runs `fetch`, then `merge-base`; on a failed merge it runs `abort-merge` and answers `{ ok: false, why: 'conflict with <base>' }`.
- `changedFiles` splits on the zero byte; null when git failed.
- Each `why` is the first 200 cleaned characters of what git wrote on its error stream.

- [ ] **Step 1: Write the failing tests.** Pure: every list above, exactly; null for `jobId: '../x'`, `base: '-D'`, `path: 'relative/x'`, `path: '/a/../b'`. **The rule test:** build every list `gitArgs` can answer for job id `12-add-dark-mode`, base `main`, path `/s/worktrees/12-add-dark-mode`, and assert: no list holds `--force` except `worktree remove`; no list holds `-f`, `--force-with-lease`, `+`, `--mirror`, `--all`, `--delete`, `reset`, `rebase`, `checkout`; the only `push` names `factory/12-add-dark-mode:factory/12-add-dark-mode`; the only `merge` merges **into** the job branch from `origin/main`. With `fakeIo` (its `run` answers each git call by a table in the test): `addWorktree` runs `fetch` then `add` and answers the path under the state folder; a failing `add` answers `{ ok: false, why }` with git's text; `syncBase` on a conflict runs `abort-merge` and answers `conflict with main`; `changedFiles` gives `['a b.ts', 'src/x.ts']` for `a b.ts\0src/x.ts\0`; `pushBranch` for an id that is not a job id runs nothing.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: a worktree and a branch per job"`

---

### Task 6: The gate's commands and their approval

**Files:**
- Modify: `factory/core/settings.ts` (`commandsOf`), `factory/core/layout.ts` (the approval rows), `factory/hooks/readers/checks.ts` (it runs only unmarked lines)
- Create: `factory/hooks/gate.ts` (first half)
- Test: `factory/tests/gate-approval.test.tsx`

**Interfaces:**
- `commandsOf(settings)` answers the checks' lines as before, then the gate's lines, each marked: `gate: <line>` (fast and full, once each, sorted). A person approves both kinds together; a line approved as `gate: npm test` never lets `npm test` run as a check, and the reverse.
- Produces:

```ts
// hooks/gate.ts
export async function gateCommands(io: Io, root: string, base: string, which: 'fast' | 'full'): Promise<{ ok: true; commands: string[][] } | { ok: false; why: string }>
```

Rules:
- `gateCommands` reads the settings of the **base branch**: `git show origin/<base>:.claude/factory.json` (in `root`, 10 s; output over 256 KiB is refused), parses it with `parseSettings`, and takes `gate.fast` or `gate.full`.
- It answers `{ ok: false, why }` for: a base that is not a branch name (`not a branch name`); git failing (`no settings file on <base>`); a settings error (`settings on <base>: <error>`); no command for that kind (`no gate`, spec 8.2 "No gate, no factory"); a command whose marked line is not on the approved list of this repository (`gate commands are not approved`).
- The approved list is read with the store key of phase 1 (`loadSettings`' `key`).
- The pane's approval rows show the marked lines as they are (`gate: npm test`).

- [ ] **Step 1: Write the failing tests:**
  - pure: `commandsOf` for checks `[x y]` and gate `{ fast: [[npm, test]], full: [[npm, test], [npm, run, build]] }` is `['x y', 'gate: npm run build', 'gate: npm test']`;
  - engine: with such a settings file the pane lists `gate: npm test` under `SETTINGS NOT APPROVED · 3 commands`, and after two `/factory approve` the check `x y` runs and `npm test` never runs as a check;
  - `fakeIo`: `gateCommands` answers the base branch's fast commands when they are approved; `gate commands are not approved` when the store holds only `npm test` (unmarked); `no gate` for an empty list; `no settings file on main` when `git show` fails; and when the working tree's own settings file names other gate commands, the answer is still the base branch's (the fake's `git show` answer differs from the file on disk).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: the gate's commands come from the base branch and need approval"`

---

### Task 7: Running the gate

**Files:**
- Create: `factory/core/gate.ts`
- Modify: `factory/hooks/gate.ts` (second half)
- Test: `factory/tests/gate.test.ts`

**Interfaces:**
- Consumes: `gateCommands` (Task 6), `changedFiles`, `worktreePath` (Task 5), `writeJobFile` (Task 2), `FactorySettings.protectedPaths`.
- Produces:

```ts
// core/gate.ts
export function protectedHits(changed: string[], protectedPaths: string[]): string[]
export function testFilesOf(changed: string[]): string[]
export type CheckRun = { line: string; exitCode: number | null; failed: 'timeout' | 'not-found' | 'other' | null; tail: string; ms: number }
export function gateReport(g: { which: 'fast' | 'full'; round: number; runs: CheckRun[]; protectedHits: string[]; testFiles: string[] }): { pass: boolean; why: string | null; markdown: string }
// hooks/gate.ts
export async function runGate(io: Io, root: string, job: Job, base: string, f: FactorySettings, which: 'fast' | 'full'): Promise<{ pass: boolean; why: string | null; needsPerson: boolean }>
```

Rules:
- `protectedHits`: a changed file hits when it equals a protected path, or the protected path ends with `/` and the file is under it. Answered sorted.
- `testFilesOf`: files whose path holds a segment `test`, `tests`, `__tests__` or `spec`, or whose name matches `\.(test|spec)\.[a-z]+$`, or is one of `package.json`, `pyproject.toml`, `pytest.ini`, `jest.config.*`, `vitest.config.*`, `tsconfig*.json`, `Makefile`. At most 50, sorted.
- `gateReport`: `pass` is false when there is a protected hit (`why: 'protected path: <first>'`) or the first run that did not exit 0 (`why: '<line> failed'`, or `'<line> timed out'`, `'<line> was not found'`). The markdown starts with `## Summary` and three to five lines (pass or fail and why, the commands that ran, the protected hits, the number of changed test files), then one section per run with its last 4,000 characters in a fenced block, then the changed test and config files.
- `runGate`: reads the commands (`gateCommands`); reads the changed files; **stops before any command** when a protected path was changed; runs each command in the worktree with `timeoutMs: 600_000` (a slot's environment is part 2); stops at the first failure; keeps each run's last 4,000 characters; writes the report with `writeJobFile(…, 'round-<job.round>/checks.md')` for `fast` and `…/merge-checks.md` for `full`; answers `needsPerson: true` when `gateCommands` refused or a protected path was hit (a person must look), else false.
- A command over ten minutes is a failure by timeout. (Longer suites need a streamed run; that is noted in the README as a limit of this version.)

- [ ] **Step 1: Write the failing tests.** Pure:

```ts
expect(protectedHits(['.claude/factory.json', 'src/a.ts', '.github/workflows/ci.yml'], ['.claude/factory.json', '.github/'])).toEqual(['.claude/factory.json', '.github/workflows/ci.yml'])
expect(protectedHits(['.github-notes.md', 'src/.claude/factory.json'], ['.claude/factory.json', '.github/'])).toEqual([])
expect(testFilesOf(['src/a.ts', 'src/a.test.ts', 'tests/x.py', 'package.json', 'docs/spec.md', 'spec/y.rb'])).toEqual(['package.json', 'spec/y.rb', 'src/a.test.ts', 'tests/x.py'])
```

  `gateReport`: all runs exit 0 → pass, summary says `pass`; a second run with exit 1 → `why: 'npm test failed'`; a timeout → `'npm test timed out'`; a protected hit → `why: 'protected path: .claude/factory.json'` and pass false even when every run passed; a run whose tail holds control characters and 50,000 characters gives a block of at most 4,000 with none; the markdown starts with `## Summary\n`. With `fakeIo`: a passing gate runs the two approved commands in the worktree and writes `files/round-1/checks.md`; a failing first command stops the second; a job whose branch changed `.claude/factory.json` runs **no** command and answers `{ pass: false, why: 'protected path: .claude/factory.json', needsPerson: true }`; unapproved gate commands run nothing and need a person; `full` writes `merge-checks.md`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: the gate"`

---

### Task 8: `stop`, `answer`, `reject`

**Files:**
- Create: `factory/hooks/commands.ts`
- Modify: `factory/hooks/register.tsx` (the three commands, composer only; the help line), `factory/tests/kit.ts`
- Test: `factory/tests/commands.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:

```ts
export async function stopLine(io: Io): Promise<string>
export async function answerJob(io: Io, itemId: string, text: string): Promise<string>
export async function rejectJob(io: Io, itemId: string, reason: string): Promise<string>
```

Rules (spec 4.4, 5.5):
- Every command first takes the lock; when it is another session's, the answer is `Another session runs the line (<holder>). Nothing was changed.`
- `stopLine` sets the stop flag and answers `The line starts no new station. Running agents finish theirs.` (`/factory run`, in part 2, clears the flag.)
- `answerJob(itemId, text)`:
  - no job of that item: `No job for <itemId>.`; a job that does not wait: `<itemId> does not wait for you (it is in <stage>).`
  - a `needs-info` or `needs-human` job: the text (when not empty) is written as a feedback file; when its `asker` is `limit`, the person's answer grants what the limit was about, read from the first words of the question (part 2 writes these questions with the words of `limitOf`): `round limit` grants one round, `cost limit` grants `costLimitUsd.job` dollars, `time limit` grants `timeLimitMin.job` minutes; then the job is resumed; the tracker item is set `in-progress`; the answer is `<itemId> goes on in <stage>.`
  - a `ready` job with text: feedback file, `move` to `build` with `sentBack: { by: 'you', why: <first 300 characters> }`, tracker `in-progress`; answer `<itemId> goes back to Build, round <n>.` A `ready` job with no text: `<itemId> is ready. Merge its pull request, or give it text to change something.`
  - the text is at most 20,000 characters; it is data for the next agent (part 2 passes it on as quoted text).
- `rejectJob(itemId, reason)`: needs a reason (`A reason is needed: /factory reject <id> <reason>`). In this order, stopping at the first step that fails and saying which: comment on the item (`The factory dropped this: <reason>`, through `commentOf`); close the pull request when the job has one; set the tracker item `rejected`; remove the worktree when the job has a branch; `reject` the job and write it; retire it. A failure answers `<itemId> was not rejected: <step> failed (<why>). Run the command again.` and writes nothing; steps that already ran are safe to run again.
- The tracker and the pull request host are GitHub when the settings say `tracker.kind: github` and the remote is GitHub; else the tracker steps are skipped and the answer ends with ` No tracker is set: nothing was written to one.`
- In `register.tsx`: `/factory stop`, `/factory answer <id> [text…]`, `/factory reject <id> <reason…>`; any origin but `composer` answers `Only a person can do this. Type the command at the prompt.`; the help line lists them.

- [ ] **Step 1: Write the failing tests** (engine-level, with jobs put in the kit's state folder and a `run` table for `gh` and `git`):
  - `stop sets the flag`; `/factory stop` from origin `sdk` changes nothing.
  - `answer resumes a job that asked a question`: the job file says `intake`, `feedback-1.md` holds the text, `gh issue edit 14 --add-label factory:in-progress --remove-label factory:needs-human` ran.
  - `answer on a job stopped for rounds grants one and goes to Build, round 2`.
  - `answer with text sends a ready job back to Build`; with no text it changes nothing and says so.
  - `answer on a job that runs, or on no job, says so and changes nothing`.
  - `reject comments, closes the pull request, sets the state, removes the worktree, retires the job`, in that order (assert the order of `world.ran`), and the comment's text is on standard input.
  - `a reject that fails at the pull request leaves the job as it was`: `gh pr close` answers exit 1; the job file is unchanged, the answer names `close the pull request`, and a second run (with `gh` answering 0) finishes.
  - `a reason with a forbidden word is refused before anything runs`.
  - `two sessions`: with a fresh lock of another session in the state folder, `answer` says who holds it and writes nothing.
  - `an item id that is not plain` (`../x`, `--help`) finds no job and runs nothing.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — validate, test, tsc — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: /factory stop, answer and reject"`

---

### Task 9: Who runs the line, and items with no job

**Files:**
- Modify: `factory/types/index.d.ts`, `factory/hooks/readers/factory.ts`, `factory/core/line.ts`
- Test: `factory/tests/line.test.ts`, `factory/tests/factory.test.tsx` (extend)

**Interfaces:**
- `FactoryView` gains `lock: 'free' | 'mine' | 'theirs'`, `holder: string | null`, `isStopped: boolean`, `claimed: string[]` (ids of items the tracker says are in progress and that have no job here; at most 10).
- Rules: the head row's right side is `<n> of <slots> slots busy` when `lock` is `mine`; `another session runs the line` when `theirs`; `no session runs the line` when `free` and a job is active; ` · stopped` is added when `isStopped`. Under NEEDS YOU, each claimed id gives a row `<id>  claimed in the tracker, no job here. /factory reject <id> <reason>, or run it again.` and counts in `waiting`. The reader fills `lock` from `lockInfo`, `isStopped`, and `claimed` from `listIssues`' claimed items less the items that have a job.

- [ ] **Step 1: Write the failing tests:** the three right-side texts and the ` · stopped` mark; a claimed item's row and its count in `NEEDS YOU (n)` and in the `You` count; engine-level: an issue with `factory:in-progress` and no job file shows as claimed, and the same issue with a job file does not.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (bump the atom's shape tag).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: the pane says who runs the line and shows items with no job"`

---

### Task 10: README, notes, final check

**Files:**
- Modify: `README.md`, `docs/notes/r1-check.md`

- [ ] **Step 1: README.** The three commands in the table; under "The factory line": the gate (fast and full, read from the base branch, approved as `gate: …` lines, the ten-minute limit of a command), that the factory writes labels `<mark>:in-progress` and `<mark>:needs-human` and comments, opens draft pull requests and never merges, and that worktrees live in the state folder. Under "What it can reach": the full list of `git` and `gh` calls the plugin can make (from `core/git-args.ts` and the two adapters).
- [ ] **Step 2: `docs/notes/r1-check.md`:** a checklist for the owner in a scratch GitHub repo with one issue: copy a sample job that waits, `/factory answer`, `/factory reject`, and look at the issue's labels and comments.
- [ ] **Step 3: Run** — validate, test, tsc — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "docs: the hands of the line"`

---

## Not in this plan (part 2)

Agents and their prompts, the fence, the loop and its timer, `/factory plan` and `/factory run`, cost from token counts, a slot's environment for the gate, a streamed run for commands over ten minutes, the keys in the pane.
