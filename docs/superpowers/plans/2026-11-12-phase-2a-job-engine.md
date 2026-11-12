# Factory Plugin, Phase 2a: The Job Engine and the FACTORY Section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The plugin knows what a factory job is: its file on disk, its stations, its loops and its limits. The pane draws the line and every job from those files. No agent runs in this plan.

**Architecture:** Jobs are files under `.factory/jobs/<job-id>/job.json` in the working tree. Pure functions in `factory/core/` hold the state machine (`job.ts`), the routing and the limits (`route.ts`, `limits.ts`), the lock rule (`lock.ts`) and the drawing of the line (`line.ts`). A store in `factory/hooks/jobs.ts` is the only code that reads or writes those files, through the `Io` of phase 1. A reader puts a small view of the jobs into the `PanelModel`; the pane draws from that.

**Tech Stack:** as phase 1: TypeScript, the Claude Code mod API, `claude plugin validate`, `claude plugin test`, `tsc`. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-12-factory-plugin-design.md`, sections 4.1 (FACTORY row), 4.2, 4.3, 5.1 (station names only), 5.3, 5.4 (the sums and the score, not how cost is measured), 5.5 (the queue rule), 6 (`factory` keys), 8.1 (lock, limits, `maxRisk`). **Not in this plan** (they are phase 2b): starting agents, the fence, the gate's run, worktrees, any write to the tracker or the PR host, `/factory plan|run|stop|answer|reject`, the approval of gate commands, custom station prompts.

## Changed during the build

The state is **not** kept in `<working tree>/.factory/`, as the tasks below still say. A security review of Task 4 showed that a folder handed to someone (an archive with its own `.git`) can bring untracked job files, so no check of the repo can make such a folder trustworthy. The state is kept under the person's home instead: `$XDG_STATE_HOME/claude-factory/<repo>/` or `~/.local/state/claude-factory/<repo>/` (`factory/core/state-path.ts`, `Io.stateDir`), one folder per repository, shared by its worktrees. The "tracked by git" rule, the `.gitignore` line of `/factory init` and Review Focus 1 are replaced by: a `.factory/` folder in a repo is never read.

## Global Constraints

- Everything in phase 1's plan (`docs/superpowers/plans/2026-11-12-phase-1-panel.md`, "Global Constraints") still holds: no project or company names, no stored tokens, all rules in `factory/core/` as pure functions, no row wider than the pane, a section with nothing to show takes no room.
- Rules of the mod API found in phase 1 (`docs/notes/phase-1-decisions.md`): the engine handle `$` is never passed to a function; code outside `register.tsx` takes an `Io` (`factory/hooks/io.ts`). A `$.state` atom is a const of the file that reads or writes it. `factory/types/index.d.ts` has no import; `core/model.ts` re-exports its types.
- The state folder is `<working tree top>/.factory/`. It must be git-ignored. If git tracks any file under it, the plugin does not use it at all (a repo could ship job files of its own).
- A job file is data from disk: it is parsed and checked field by field, a file over 256 KiB or with a wrong shape is skipped, and every text from it is drawn through `clean()`.
- A job id is `[a-z0-9][a-z0-9-]{0,59}`, and it must equal the name of its folder.
- Only `factory/hooks/jobs.ts` writes under `.factory/`.
- The panel model holds at most 20 jobs.
- This plan adds no command that a settings file can make run, and no write outside `.factory/` except one line in `.gitignore` by `/factory init`.
- Station names, in order: `Queue`, `Intake`, `Spec`, `Build`, `Gate`, `Review`, `Approve`, `You`.

**Commands used by every task**

```bash
claude plugin validate factory
claude plugin test factory
npx -p typescript tsc -p factory
```

## Review Focus

1. **A `.factory/` folder that came with the repo** (tracked by git) with a job that says "ready". The panel does not show it; one dim line says the folder is tracked and not used. (Task 4)
2. **A job file that is half written, empty, huge, or has `"stage": "nonsense"`.** It is skipped; the other jobs still show; one dim line counts the skipped files. (Tasks 2, 4)
3. **Two sessions open in one repo.** Each draws the same jobs; neither writes a job file in this plan; the lock functions give `theirs` to the second and never `mine` to both. (Task 4)
4. **Thirty jobs and a 40-column pane.** The line is its short form, at most 20 jobs are in the model, and `+ N more` says the rest. (Tasks 5, 6)
5. **A question or a title in a job file with control characters, 5,000 characters long.** It is cut and cleaned; no row spills. (Task 5)

## File Structure

```
factory/core/factory-settings.ts   the `factory` key of the settings file
factory/core/job.ts                Job, Stage, TRANSITIONS, newJob, move, jobIdOf, parseJob
factory/core/route.ts              reviewers from risk and surfaces
factory/core/limits.ts             slots, rounds, cost, time, disk; today's totals and the score
factory/core/lock.ts               the lock rule
factory/core/line.ts               the line, the job rows, NEEDS YOU, QUEUE, TODAY as rows
factory/hooks/jobs.ts              the store: read jobs, write a job, the lock
factory/hooks/readers/factory.ts   jobs + queue size -> PanelModel.factory
factory/adapters/github-issues.ts  + list(mark)
factory/types/index.d.ts           + JobView, FactoryView, PanelModel.factory
factory/core/layout.ts             + cells on a row; FACTORY section; status text
factory/core/alerts.ts, brief.ts   + job alerts, the count in the brief
factory/hooks/init.ts              + `.factory/` in .gitignore
docs/examples/factory-jobs/        three sample job folders, to see the section by hand
factory/tests/*.test.ts(x)
```

---

### Task 1: The `factory` settings

**Files:**
- Create: `factory/core/factory-settings.ts`
- Modify: `factory/core/settings.ts` (`Settings.factory`, `DEFAULTS`, `take('factory', …)`)
- Test: `factory/tests/factory-settings.test.ts`

**Interfaces:**
- Produces:

```ts
export type Risk = 'low' | 'medium' | 'high'
export type Role = 'intake' | 'spec' | 'builder' | 'reviewer' | 'approver'
export type Tier = 'strongest' | 'strong' | 'fast'
export type FactorySettings = {
  slots: number                                   // 1..8, default 2
  maxRounds: number                               // 1..10, default 3
  maxRisk: Risk                                   // default 'low'
  costLimitUsd: { job: number; day: number }      // default 10, 50; each > 0
  timeLimitMin: { job: number; day: number }      // default 60, 240; each > 0
  minFreeDiskGb: number                           // default 15; >= 0
  protectedPaths: string[]                        // repo-relative; default ['.claude/factory.json']
  forbiddenCommands: string[][]                   // argv prefixes; default []
  forbiddenCommentWords: string[]                 // default []
  models: Record<Role, Tier>                      // default intake 'strongest', the rest 'strong'
  reviewers: { low: string[]; medium: string[]; high: string[]; ui: string[]; security: string[] }
                                                  // default code / code / code / ux,ui / security
}
export const FACTORY_DEFAULTS: FactorySettings
export function parseFactory(v: unknown): { ok: FactorySettings } | { no: string }
```

- `Settings.factory: FactorySettings` is always present (the defaults when the key is absent). A refused key gives the error `factory: <reason>` and the defaults for the whole `factory` object.
- Reasons: `wrong type` (anything not an object, a number out of its range, a list that is not strings), `path must be inside the repo` (a protected path that fails phase 1's `isInside` rule; export that function from `settings.ts`), `control character in a command` (in `forbiddenCommands`), `unknown reviewer` (a reviewer name not in `code`, `ux`, `ui`, `security`), `at most 50` (more than 50 entries in any list).
- Unknown keys inside `factory` are ignored (`stations` belongs to phase 2b).

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { FACTORY_DEFAULTS } from '../core/factory-settings'
import { DEFAULTS, parseSettings } from '../core/settings'

test('no factory key gives the defaults', async () => {
  expect(parseSettings('{}').settings.factory).toEqual(FACTORY_DEFAULTS)
  expect(FACTORY_DEFAULTS.slots).toBe(2)
  expect(FACTORY_DEFAULTS.maxRounds).toBe(3)
  expect(FACTORY_DEFAULTS.maxRisk).toBe('low')
  expect(FACTORY_DEFAULTS.reviewers).toEqual({ low: ['code'], medium: ['code'], high: ['code'], ui: ['ux', 'ui'], security: ['security'] })
  expect(FACTORY_DEFAULTS.models).toEqual({ intake: 'strongest', spec: 'strong', builder: 'strong', reviewer: 'strong', approver: 'strong' })
})
test('given keys replace their defaults, the rest stay', async () => {
  const { settings, error } = parseSettings('{"factory": {"slots": 4, "maxRisk": "high", "costLimitUsd": {"job": 5}, "stations": {"spec": "x.md"}}}')
  expect(error).toBe(null)
  expect(settings.factory.slots).toBe(4)
  expect(settings.factory.maxRisk).toBe('high')
  expect(settings.factory.costLimitUsd).toEqual({ job: 5, day: 50 })
  expect(settings.factory.maxRounds).toBe(3)
})
test('a value out of range refuses the whole factory key', async () => {
  for (const factory of [{ slots: 0 }, { slots: 9 }, { maxRounds: 11 }, { maxRisk: 'huge' }, { costLimitUsd: { job: 0 } }, { minFreeDiskGb: -1 }, 5, []]) {
    expect(parseSettings(JSON.stringify({ factory }))).toEqual({ settings: DEFAULTS, error: 'factory: wrong type' })
  }
})
test('lists are checked', async () => {
  const err = (factory: object) => parseSettings(JSON.stringify({ factory })).error
  expect(err({ protectedPaths: ['../x'] })).toBe('factory: path must be inside the repo')
  expect(err({ forbiddenCommands: [['rm', 'a\nb']] })).toBe('factory: control character in a command')
  expect(err({ reviewers: { low: ['nobody'] } })).toBe('factory: unknown reviewer')
  expect(err({ forbiddenCommentWords: Array.from({ length: 51 }, () => 'x') })).toBe('factory: at most 50')
  expect(err({ forbiddenCommands: [['terraform', 'apply']], reviewers: { ui: ['ux'] } })).toBe(null)
})
```

- [ ] **Step 2: Run** — `claude plugin test factory` — Expected: FAIL (cannot import `../core/factory-settings`).
- [ ] **Step 3: Implement** `parseFactory`, and wire it into `parseSettings`.
- [ ] **Step 4: Run** — test, tsc — Expected: PASS, and the 126 tests of phase 1 still pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: the factory settings"`

---

### Task 2: The job and its state machine

**Files:**
- Create: `factory/core/job.ts`
- Test: `factory/tests/job.test.ts`

**Interfaces:**
- Consumes: `Risk` (Task 1).
- Produces:

```ts
export type Stage = 'intake' | 'needs-info' | 'spec' | 'build' | 'gate' | 'review' | 'approve' | 'needs-human' | 'ready' | 'done' | 'rejected'
export type Job = {
  id: string                 // folder name
  itemId: string             // the tracker's id, as the person knows it
  title: string
  stage: Stage
  round: number              // starts at 1; +1 at every move back to `build`
  risk: Risk | null
  surfaces: string[]
  reviewers: string[]
  stoppedIn: Stage | null    // set while the job waits: the stage it goes back to
  question: string | null    // what the person or the author is asked
  sentBack: { by: 'gate' | 'review' | 'approve' | 'you'; why: string } | null
  pr: { number: number; url: string } | null
  createdAt: number
  updatedAt: number
  agentMs: number            // sum of agent time
  costUsd: number | null     // sum of the estimate; null when it cannot be priced
  history: { at: number; from: Stage | null; to: Stage; reason: string }[]
}
export const STAGES: readonly Stage[]
export const TRANSITIONS: Record<Stage, readonly Stage[]>
export class IllegalMove extends Error {}
export function jobIdOf(itemId: string, title: string): string
export function newJob(item: { id: string; title: string }, now: number): Job
export function move(job: Job, to: Stage, reason: string, now: number, set?: Partial<Pick<Job, 'question' | 'sentBack' | 'risk' | 'surfaces' | 'reviewers' | 'pr'>>): Job
export function isWaiting(job: Job): boolean     // needs-info, needs-human, ready
export function isActive(job: Job): boolean      // intake, spec, build, gate, review, approve
export function isFinished(job: Job): boolean    // done, rejected
export function parseJob(text: string, folder: string): Job | null
```

Rules (spec 5.3):
- `TRANSITIONS`: `intake` → `spec`, `needs-info`, `needs-human`, `rejected`. `spec` → `build`. `build` → `gate`. `gate` → `review`, `build`, `needs-human`. `review` → `approve`, `build`, `needs-human`. `approve` → `ready`, `build`, `needs-human`. `ready` → `done`, `build`, `rejected`. `needs-info` and `needs-human` → `rejected`, or the one stage in `stoppedIn`. `done`, `rejected` → nothing.
- `move` never changes its argument. It throws `IllegalMove` for a move not in the table. It adds one history entry, sets `updatedAt`, and applies `set`.
- Moving **to** `needs-info` or `needs-human` records the stage it came from in `stoppedIn`; a job that stops at `intake` because the risk is too high goes back to `spec`, so `move(job, 'needs-human', …)` from `intake` sets `stoppedIn` to `spec`, and `needs-info` from `intake` sets it to `intake`. Leaving a waiting stage clears `stoppedIn` and `question`.
- Moving to `build` from `gate`, `review`, `approve` or `ready` adds 1 to `round` and requires `set.sentBack`; moving to `build` from `spec` or from a waiting stage does not change `round`.
- `jobIdOf`: the runs of ASCII letters and digits of the item id, then those of the title, lower-cased and joined by `-`; cut to 60 characters; no `-` at the end. An empty result is `job`.
- `parseJob`: `null` unless the text is JSON of the exact shape above with a known `stage`, `id === folder`, an id that matches `[a-z0-9][a-z0-9-]{0,59}`, numbers that are finite and not negative, `round >= 1`. Text fields are cut: `title` 200, `question` 500, `sentBack.why` 300, `itemId` 40, each history `reason` 200; history keeps its last 100 entries.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { IllegalMove, STAGES, TRANSITIONS, isActive, isFinished, isWaiting, jobIdOf, move, newJob, parseJob } from '../core/job'

const job = () => newJob({ id: 'PROJ-12', title: 'Add dark mode!' }, 1000)

test('a new job', async () => {
  const j = job()
  expect(j.id).toBe('proj-12-add-dark-mode')
  expect([j.stage, j.round, j.itemId, j.createdAt, j.costUsd, j.agentMs]).toEqual(['intake', 1, 'PROJ-12', 1000, null, 0])
  expect(j.history).toEqual([{ at: 1000, from: null, to: 'intake', reason: 'started' }])
})
test('job ids are short, plain and never empty', async () => {
  expect(jobIdOf('12', 'Add dark mode')).toBe('12-add-dark-mode')
  expect(jobIdOf('#7', '  Ünïcode & symbols!!  ')).toBe('7-n-code-symbols')
  expect(jobIdOf('!!', '??')).toBe('job')
  expect(jobIdOf('PROJ-1', 'x'.repeat(200)).length).toBeLessThanOrEqual(60)
  expect(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(jobIdOf('PROJ-1', 'a b - c -'))).toBe(true)
})
test('the happy path, one round', async () => {
  let j = job()
  for (const to of ['spec', 'build', 'gate', 'review', 'approve', 'ready', 'done'] as const) j = move(j, to, 'ok', 2000)
  expect([j.stage, j.round, j.history.length]).toEqual(['done', 1, 8])
  expect(isFinished(j)).toBe(true)
})
test('a loop back to build is a new round and says who sent it back', async () => {
  let j = move(move(move(job(), 'spec', 'ok', 1), 'build', 'ok', 2), 'gate', 'ok', 3)
  j = move(j, 'build', 'gate failed', 4, { sentBack: { by: 'gate', why: '2 tests failed' } })
  expect([j.stage, j.round, j.sentBack]).toEqual(['build', 2, { by: 'gate', why: '2 tests failed' }])
  expect(() => move(move(j, 'gate', 'ok', 5), 'build', 'again', 6)).toThrow(IllegalMove)
})
test('illegal moves throw and change nothing', async () => {
  const j = job()
  expect(() => move(j, 'review', 'skip', 1)).toThrow(IllegalMove)
  expect(() => move(move(j, 'rejected', 'no', 1), 'spec', 'back', 2)).toThrow(IllegalMove)
  expect(j.stage).toBe('intake')
})
test('a job that waits goes back only where it stopped', async () => {
  const info = move(job(), 'needs-info', 'a question', 1, { question: 'Which font?' })
  expect([info.stoppedIn, info.question, isWaiting(info)]).toEqual(['intake', 'Which font?', true])
  expect(() => move(info, 'spec', 'x', 2)).toThrow(IllegalMove)
  const back = move(info, 'intake', 'answered', 2)
  expect([back.stage, back.stoppedIn, back.question]).toEqual(['intake', null, null])

  const risky = move(job(), 'needs-human', 'risk medium', 1, { question: 'Risk is medium. Build it?' })
  expect(risky.stoppedIn).toBe('spec')
  expect(move(risky, 'spec', 'approved', 2).stage).toBe('spec')

  const review = ['spec', 'build', 'gate', 'review'].reduce((j, to) => move(j, to as never, 'ok', 1), job())
  const stuck = move(review, 'needs-human', 'round limit', 2, { question: '3 rounds with no pass.' })
  expect(stuck.stoppedIn).toBe('review')
  expect(move(stuck, 'rejected', 'dropped', 3).stage).toBe('rejected')
})
test('every stage is in the table and the table names only stages', async () => {
  for (const stage of STAGES) for (const to of TRANSITIONS[stage]) expect(STAGES).toContain(to)
  expect(isActive(job())).toBe(true)
})
test('a job file is checked field by field', async () => {
  const good = JSON.stringify(job())
  expect(parseJob(good, 'proj-12-add-dark-mode')?.itemId).toBe('PROJ-12')
  expect(parseJob(good, 'other-folder')).toBe(null)
  expect(parseJob('', 'x')).toBe(null)
  expect(parseJob('{ half', 'x')).toBe(null)
  for (const bad of [{ stage: 'nonsense' }, { round: 0 }, { agentMs: -1 }, { history: 'x' }, { id: '../etc' }, { costUsd: 'free' }]) {
    expect(parseJob(JSON.stringify({ ...job(), ...bad }), 'proj-12-add-dark-mode')).toBe(null)
  }
  const long = parseJob(JSON.stringify({ ...job(), title: 't'.repeat(5000), question: 'q'.repeat(5000) }), 'proj-12-add-dark-mode')
  expect([long?.title.length, long?.question?.length]).toEqual([200, 500])
})
```

- [ ] **Step 2: Run** — Expected: FAIL (cannot import `../core/job`).
- [ ] **Step 3: Implement `core/job.ts`.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: the job and its state machine"`

---

### Task 3: Routing, limits, today's totals

**Files:**
- Create: `factory/core/route.ts`, `factory/core/limits.ts`
- Test: `factory/tests/limits.test.ts`

**Interfaces:**
- Consumes: `Job`, `isActive` (Task 2); `FactorySettings`, `Risk` (Task 1).
- Produces:

```ts
// route.ts
export function routeOf(risk: Risk, surfaces: string[], f: FactorySettings): { reviewers: string[]; isOverRisk: boolean }
// limits.ts
export function freeSlots(jobs: Job[], f: FactorySettings): number
export function isSameDay(a: number, b: number): boolean          // the same local calendar day
export function limitOf(job: Job, jobs: Job[], f: FactorySettings, now: number): string | null
export function canStart(freeDiskGb: number | null, f: FactorySettings): boolean
export type Today = { done: number; minutes: number; costUsd: number | null; firstRound: number; finished: number }
export function todayOf(jobs: Job[], now: number): Today
```

Rules:
- `routeOf`: the reviewers of the risk, then of each surface that is `ui` or `security`, each name once, in that order. `isOverRisk` when the risk is above `f.maxRisk` (`low < medium < high`).
- `freeSlots`: `f.slots` less the active jobs, never below 0.
- `limitOf` answers the first limit a job has reached, or `null`: `round limit` when `job.round > f.maxRounds`; `cost limit for the job` when `job.costUsd` is a number above `f.costLimitUsd.job`; `cost limit for the day` when the sum of `costUsd` of the jobs updated today is above `f.costLimitUsd.day`; and, only for a job whose `costUsd` is `null`, `time limit for the job` when `job.agentMs` is over `f.timeLimitMin.job` minutes and `time limit for the day` when today's `agentMs` sum is over `f.timeLimitMin.day` minutes (spec 5.4).
- `canStart`: false when the free disk is known and below `f.minFreeDiskGb`; true when it is not known.
- `todayOf` looks at jobs whose `updatedAt` is today: `done` counts stages `done` and `ready`; `finished` counts `done`, `ready` and `rejected`; `minutes` is the rounded sum of `agentMs`; `costUsd` is the sum, or `null` when any of those jobs has `null`; `firstRound` counts the `done` and `ready` jobs with `round === 1`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { FACTORY_DEFAULTS as F } from '../core/factory-settings'
import { move, newJob } from '../core/job'
import type { Job } from '../core/job'
import { canStart, freeSlots, limitOf, todayOf } from '../core/limits'
import { routeOf } from '../core/route'

const NOON = new Date(2026, 0, 15, 12).getTime()
const job = (id: string, over: Partial<Job> = {}): Job => ({ ...newJob({ id, title: 't' }, NOON), ...over })

test('reviewers come from the risk and the surfaces, once each', async () => {
  expect(routeOf('low', [], F)).toEqual({ reviewers: ['code'], isOverRisk: false })
  expect(routeOf('medium', ['ui', 'security', 'ui', 'other'], F)).toEqual({ reviewers: ['code', 'ux', 'ui', 'security'], isOverRisk: true })
  expect(routeOf('high', [], { ...F, maxRisk: 'high' }).isOverRisk).toBe(false)
})
test('free slots', async () => {
  const jobs = [job('1'), job('2', { stage: 'ready' }), job('3', { stage: 'build' })]
  expect(freeSlots(jobs, F)).toBe(0)
  expect(freeSlots(jobs, { ...F, slots: 5 })).toBe(3)
})
test('the first limit a job has reached', async () => {
  expect(limitOf(job('1'), [], F, NOON)).toBe(null)
  expect(limitOf(job('1', { round: 4 }), [], F, NOON)).toBe('round limit')
  expect(limitOf(job('1', { costUsd: 10.5 }), [], F, NOON)).toBe('cost limit for the job')
  const others = [job('2', { costUsd: 30 }), job('3', { costUsd: 25 })]
  expect(limitOf(job('1', { costUsd: 1 }), others, F, NOON)).toBe('cost limit for the day')
  expect(limitOf(job('1', { costUsd: 1 }), others.map(j => ({ ...j, updatedAt: NOON - 86_400_000 })), F, NOON)).toBe(null)
  expect(limitOf(job('1', { agentMs: 61 * 60_000 }), [], F, NOON)).toBe('time limit for the job')
  expect(limitOf(job('1', { agentMs: 61 * 60_000, costUsd: 2 }), [], F, NOON)).toBe(null)
})
test('the disk guard', async () => {
  expect([canStart(14.9, F), canStart(15, F), canStart(null, F)]).toEqual([false, true, true])
})
test("today's totals and the score", async () => {
  const jobs = [
    job('1', { stage: 'done', agentMs: 8 * 60_000, costUsd: 3.4 }),
    job('2', { stage: 'ready', round: 2, agentMs: 14 * 60_000, costUsd: 2.1 }),
    job('3', { stage: 'rejected', agentMs: 60_000, costUsd: 0.2 }),
    job('4', { stage: 'done', updatedAt: NOON - 86_400_000, costUsd: 9 }),
    job('5', { stage: 'build', costUsd: 1 }),
  ]
  expect(todayOf(jobs, NOON)).toEqual({ done: 2, minutes: 23, costUsd: 6.7, firstRound: 1, finished: 3 })
  expect(todayOf([job('1', { stage: 'done' })], NOON).costUsd).toBe(null)
})
```

(`minutes` and `costUsd` sum **every** job updated today, also one that still runs: 8 + 14 + 1 + 0 minutes, and 3.4 + 2.1 + 0.2 + 1.0 dollars. `done`, `finished` and `firstRound` count only the jobs that ended.)

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Round cost sums to 2 decimals.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: routing, limits and today's totals"`

---

### Task 4: The store: job files and the lock

**Files:**
- Create: `factory/core/lock.ts`, `factory/hooks/jobs.ts`
- Modify: `factory/hooks/io.ts` and `factory/hooks/register.tsx` (`Io.sessionId`), `factory/hooks/init.ts` (the `.gitignore` line), `factory/tests/kit.ts` (a `session.id` answer; `git ls-files` answered from a `tracked` list)
- Test: `factory/tests/jobs.test.tsx`

**Interfaces:**
- Consumes: `Job`, `parseJob` (Task 2); `Io`, `readInside` (phase 1).
- Produces:

```ts
// core/lock.ts
export type LockFile = { session: string; at: number }
export const STALE_MS = 5 * 60_000
export function lockOf(text: string | null, session: string, now: number): 'free' | 'mine' | 'theirs' | 'stale'
export function lockText(session: string, now: number): string

// hooks/jobs.ts
export type Jobs = { jobs: Job[]; skipped: number; note: string | null }
export async function readJobs(io: Io, root: string): Promise<Jobs>
export async function writeJob(io: Io, root: string, job: Job): Promise<void>
export async function takeLock(io: Io, root: string, now: number): Promise<{ isHeld: boolean; holder: string | null }>
export async function releaseLock(io: Io, root: string): Promise<void>
```

Rules:
- `Io.sessionId(): Promise<string>` wraps `$.session.id()`.
- `lockOf`: `free` for no file, an empty file or text that is not `{session, at}`; `mine` when the session is this one; `stale` when `now - at > STALE_MS`; else `theirs`.
- `readJobs`:
  1. Runs `git ls-files --error-unmatch .factory` in `root` (5 s). Exit 0 means git tracks something there: answer `{ jobs: [], skipped: 0, note: '.factory/ is tracked by git. It is not used.' }` and read nothing.
  2. Lists `<root>/.factory/jobs/`. For each folder (at most 200, by name), reads `job.json` through `readInside` with a 256 KiB cap and `parseJob(text, folder)`. A file that fails counts in `skipped`.
  3. Sorts by `updatedAt`, newest first. `note` is `<n> job file(s) skipped` when `skipped > 0`.
- `writeJob` writes `<root>/.factory/jobs/<job.id>/job.json` (2-space JSON, a newline at the end). It refuses (throws) a job whose id does not match the id rule, and it refuses when `<root>/.factory` or `<root>/.factory/jobs` is a symbolic link.
- `takeLock`: reads `<root>/.factory/lock`; when `free`, `stale` or `mine` it writes `lockText(session, now)` and reads it back; `isHeld` is true only when the text read back names this session. `holder` is the other session's id when it is `theirs`.
- `releaseLock` writes an empty file, only when the lock is `mine`.
- `/factory init` also makes sure `.gitignore` has the line `.factory/`: it appends it (with a newline before it when the file does not end with one) unless a line equal to `.factory/` or `.factory` is already there. It does not write through a link. The answer gains ` .factory/ is in .gitignore.` when it added the line.

- [ ] **Step 1: Write the failing tests** `factory/tests/jobs.test.tsx`

Pure:

```ts
test('the lock rule', async () => {
  expect(lockOf(null, 's1', 1000)).toBe('free')
  expect(lockOf('', 's1', 1000)).toBe('free')
  expect(lockOf('garbage', 's1', 1000)).toBe('free')
  expect(lockOf(lockText('s1', 900), 's1', 1000)).toBe('mine')
  expect(lockOf(lockText('s2', 900), 's1', 1000)).toBe('theirs')
  expect(lockOf(lockText('s2', 900), 's1', 900 + STALE_MS + 1)).toBe('stale')
})
```

With a fake `Io` held in memory (a `files` map; `run` answers `git ls-files` with exit 1 unless the test lists a tracked path; `sessionId` answers a given id), in the style of `factory/tests/refresh-unit.test.ts`:
- `a job written is read back`: `writeJob` then `readJobs` gives that job, `skipped` 0, `note` null; the file is at `/r/.factory/jobs/<id>/job.json`.
- `bad job files are skipped and counted`: three folders, one good, one with `{ half`, one whose `id` differs from its folder → one job, `skipped` 2, note `2 job files skipped`.
- `jobs come newest first`.
- `a tracked .factory folder is not used`: git answers exit 0 → `jobs` empty, the note above, and no file under `.factory` was read.
- `a job with a bad id is not written`: `writeJob` with `id: '../x'` rejects and writes nothing.
- `two sessions cannot both hold the lock`: session `s1` takes it (`isHeld` true); session `s2` at the same time gets `{ isHeld: false, holder: 's1' }`; after `STALE_MS` with no new write `s2` takes it; `s1`'s `releaseLock` then changes nothing.

Engine-level (the kit's `engine`): `/factory init` in a repo whose `.gitignore` is `node_modules/` writes `node_modules/\n.factory/\n`; run again on a fresh repo whose `.gitignore` already has `.factory/` leaves it as it is; the answer of the first ends with `.factory/ is in .gitignore.`

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — validate, test, tsc — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: job files and the lock"`

---

### Task 5: The line and the job rows

**Files:**
- Create: `factory/core/line.ts`
- Modify: `factory/types/index.d.ts` and `factory/core/model.ts` (`JobView`, `FactoryView`, `PanelModel.factory`), `factory/core/layout.ts` (`Row.cells`, the FACTORY section), `factory/hooks/register.tsx` (draw `cells`)
- Test: `factory/tests/line.test.ts`

**Interfaces:**
- Consumes: `Stage` names as strings (the contract cannot import; repeat the union there).
- Produces, in `types/index.d.ts`:

```ts
export type JobView = {
  itemId: string; title: string
  stage: 'intake' | 'needs-info' | 'spec' | 'build' | 'gate' | 'review' | 'approve' | 'needs-human' | 'ready' | 'done' | 'rejected'
  stoppedIn: JobView['stage'] | null
  round: number; maxRounds: number
  sentBack: { by: 'gate' | 'review' | 'approve' | 'you'; why: string } | null
  question: string | null
  prNumber: number | null
  minutes: number; costUsd: number | null
}
export type FactoryView = {
  jobs: JobView[]            // active and waiting jobs, at most 20
  more: number               // active and waiting jobs that are not in `jobs`
  queue: number | null       // items with the mark, null when not known
  slots: number
  today: { done: number; minutes: number; costUsd: number | null; firstRound: number; finished: number }
  note: string | null
}
// PanelModel gains:  factory: FactoryView | null
```

- Produces, in `core/layout.ts`: `Row` gains `cells?: { text: string; tone: Tone }[]`; when present the row is drawn as its cells, each in its tone, joined with one space, and `left`/`right` are empty.
- Produces, in `core/line.ts`:

```ts
export const STATIONS: readonly string[]         // Queue, Intake, Spec, Build, Gate, Review, Approve, You
export function countsOf(view: FactoryView): number[]          // one per station
export function lineRows(view: FactoryView, columns: number): Row[]
export function jobRows(job: JobView, columns: number): Row[]
export function factoryRows(view: FactoryView, columns: number): Row[]
```

Rules (spec 4.2):
- `countsOf`: `Queue` is `view.queue ?? 0`; a job counts at the station of its stage (`intake`…`approve`); `needs-info`, `needs-human` and `ready` count at `You`. `done` and `rejected` are not in the view.
- `lineRows`, wide form (`columns >= 69`), five rows, exactly:

```
 Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You
   4        1        0        1       0        0          0        2
                              ^       │        │
                              ├─fail──┘        │
                              └─── changes ────┘
```

  Row 1 is `head`. Row 2 puts each count under its station (columns 3, 12, 21, 30, 38, 47, 58, 67 of the row, counting from 0) and is drawn as cells so that the `You` count is `bad` when it is above 0. Rows 3–5 are `warn` when a job in the view has `stage === 'build'` and a `sentBack` by `gate` (rows 3 and 4) or by `review` (rows 3, 4 and 5); otherwise `dim`.
- `lineRows`, short form (`columns < 69`): one row of cells `Q4 I1 S0 B1 G0 R0 A0 You2` (the first letter and the count; `You` in full, `bad` when above 0), cut to the width; a second row `↺ gate` / `↺ review` / `↺ gate, review` in `warn` only when a job is on that loop.
- `jobRows`: a first row of seven cells: the item id cut to 9 characters and padded to 9, then one cell of width 7 per station `Intake`…`Approve`: `done` (good) for a station before the job's, `now` (head) for the job's station, `-` (dim) after it; for a job in `build` that was sent back, the `Gate` cell is `fail` (warn) when `sentBack.by === 'gate'` and the `Review` cell is `changes` (warn) when it is `review`; a waiting job shows `you` (bad) at the station in `stoppedIn`. Below `columns < 60` the cells are 4 wide and their words are `ok`, `now`, `-`, `fail`, `chg`, `you`. A second, dim row: `round <r> of <max>` (with `↺ ` before it when `round > 1`), then ` · <by> sent it back: <why>` when `sentBack` is set, then ` · <minutes> m`, then ` · $<cost with 2 decimals>` or ` · cost unknown`; it goes through `fit`.
- `factoryRows`: the head `FACTORY` with, at the right, `<busy> of <slots> slots busy` (busy = jobs at `Intake`…`Approve`); the line; the job rows of the jobs that do not wait; `+ <more> more` (dim) when `more > 0`; then, when any job waits, a `bad` head `NEEDS YOU (<n>)` and per waiting job one row: `<itemId>  <question>` for `needs-info` and `needs-human`, `<itemId>  PR <n> is ready. You merge.` for `ready`; then a dim row `QUEUE  <n> items with the mark` (`1 item with the mark` for one) when `queue` is a number; then, when `today.finished > 0`, a dim row `TODAY  <done> done · <minutes> m · $<cost>` plus ` · <firstRound> of <done> passed in round 1` when `done > 0` (`cost unknown` in place of `$…` when null); then the `note`, dim. With no job, no queue number and nothing today, it is an empty list: the section takes no room.
- `rowsOf` (layout) places `factoryRows` after TASK. The section is drawn only when `model.factory` is not null.

- [ ] **Step 1: Write the failing tests** `factory/tests/line.test.ts`. Build a `view()` helper with two running jobs (one in `review` round 1; one in `build`, round 2, `sentBack` by `gate` `2 tests failed`), two waiting (`needs-info` with a question, `ready` with PR 51), `queue: 4`, `slots: 2`, `today: { done: 3, minutes: 41, costUsd: 9.8, firstRound: 2, finished: 3 }`. Assert:
  - `countsOf(view)` equals `[4, 0, 0, 1, 0, 1, 0, 2]`.
  - at 80 columns the first line row's text is exactly ` Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You`; the counts row, read as text, has `4` at column 3 and `2` at column 67, and its last cell's tone is `bad`; loop rows 3 and 4 are `warn` and row 5 is `dim` (only the gate loop is in use).
  - at 40 columns the line is `Q4 I0 S0 B1 G0 R1 A0 You2` and a second row `↺ gate`.
  - `jobRows` of the `build` job at 80 columns: cells' texts trimmed are `[id, 'done', 'done', 'now', 'fail', '-', '-']`; the second row is `↺ round 2 of 3 · gate sent it back: 2 tests failed · 14 m · $3.40`.
  - `factoryRows(view, 80)` contains, in order, a row starting `FACTORY`, the head `NEEDS YOU (2)`, a row `PROJ-14  Which default font?`, a row `PROJ-10  PR 51 is ready. You merge.`, `QUEUE  4 items with the mark`, `TODAY  3 done · 41 m · $9.80 · 2 of 3 passed in round 1`.
  - an empty view (`jobs: []`, `queue: null`, `today.finished: 0`) gives `[]`.
  - for every width from 24 to 120, no row of `factoryRows(view, width)` is wider than `width` (a row of cells is as wide as its cells joined by spaces).
  - a job whose `title`, `question` and `sentBack.why` hold `\u001b[2J` and 5,000 characters gives rows with no control character and none wider than the pane.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `core/line.ts`, the model types, `Row.cells` and the section in `rowsOf`; draw cells in `register.tsx`.
- [ ] **Step 4: Run** — validate, test, tsc — Expected: PASS (bump the atom's shape tag to `panel-2` in the files that declare it and in the kit's `stored()`).
- [ ] **Step 5: Commit** — `git commit -m "feat: the line and the job rows"`

---

### Task 6: The factory reader

**Files:**
- Create: `factory/hooks/readers/factory.ts`
- Modify: `factory/adapters/github-issues.ts` (`listIssues`, and `list` on the adapter), `factory/hooks/refresh.ts` (add the reader)
- Test: `factory/tests/factory.test.tsx`

**Interfaces:**
- Consumes: `readJobs` (Task 4); `todayOf` (Task 3); `isActive`, `isWaiting` (Task 2); `FactoryView` (Task 5); `Reader`, `Ctx` (phase 1).
- Produces:

```ts
// adapters/github-issues.ts
export function parseGhIssueList(json: string): { id: string; title: string; state: string; labels: string[] }[]
export async function listIssues(run: Run, mark: string): Promise<{ items: { id: string; title: string; state: string }[] | null; result: RunResult }>
// hooks/readers/factory.ts
export function viewOf(jobs: Job[], f: FactorySettings, queue: number | null, note: string | null, now: number): FactoryView | null
export const factoryReader: Reader
```

Rules:
- `listIssues` runs `gh issue list --label <mark> --state open --limit 100 --json number,title,state,labels`. The mark must match `[A-Za-z0-9][A-Za-z0-9:_ -]{0,49}` (it is an argument of `gh`); a mark that does not gives `items: null` with no command run. It leaves out an issue that carries a label starting with `<mark>:` (the factory's own state labels, spec 5.5). `items` is `null` when `gh` failed.
- `viewOf`: `null` when there is no job at all, `queue` is `null` and `note` is `null`. Else the active jobs then the waiting ones, each newest first, at most 20, `more` the rest; `today` from `todayOf` over **all** jobs; `slots` from the settings; `maxRounds` on each job from the settings; `minutes` is `round(agentMs / 60000)`.
- The reader: reads the jobs; in a light read, or when `ctx.settings.tracker?.kind !== 'github'`, `queue` is `null` and no `gh` runs; else `queue` is the number of items, `null` when `gh` failed. It returns `{ factory: viewOf(...) }`. It needs no approval: it runs `git` and `gh` only.

- [ ] **Step 1: Write the failing tests.** Pure: `parseGhIssueList` on a three-issue JSON (one with the label `factory:in-progress`) and on `not json` (`[]`); `viewOf` with 25 active jobs gives 20 and `more: 5`; with no jobs, `queue` null and no note gives `null`; a finished job of today shows only in `today`. Engine-level, with job files put in the kit's `files` under `/r/.factory/jobs/`:
  - `the pane draws the jobs on disk`: one job in `review`, one `ready` with a PR → the pane has `FACTORY`, a row starting with the job's item id, `NEEDS YOU (1)`.
  - `the queue is counted from the tracker`: settings `{"tracker": {"kind": "github"}}`, `gh issue list` answers two issues, one with the label `factory:needs-human` → the pane has `QUEUE  1 item with the mark`.
  - `a tracked .factory folder shows a line and no job`.
  - `a bad job file is counted, the good one shows`.
  - `no tracker and no jobs: no FACTORY section`.
  - `a mark that could be read as an option runs nothing`: settings `{"tracker": {"kind": "github", "mark": "--web"}}` → no `gh issue list` in `world.ran`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Also refuse such a mark in `parseSettings` (`tracker: wrong type`) and keep the adapter's own check.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: the factory reader"`

---

### Task 7: Status line, alerts and the brief

**Files:**
- Modify: `factory/core/layout.ts` (`statusText`), `factory/core/alerts.ts`, `factory/core/brief.ts`
- Test: `factory/tests/factory-signals.test.ts`

**Interfaces:**
- Consumes: `FactoryView`, `JobView` (Task 5).
- Rules:
  - `statusText` adds, after the task id, `factory <run> run, <need> need you` (`run` = jobs at `Intake`…`Approve`, `need` = waiting jobs); the part is left out when both are 0, and `, <need> need you` is left out when `need` is 0.
  - `alertsFor` adds, for a job (matched by `itemId`) that was not waiting before and waits now: `<itemId> needs you: <question>` for `needs-info` and `needs-human`; `<itemId>: PR <n> is ready. You merge.` for `ready`. A job that is new in the view and already waits also alerts, except on the first read.
  - `briefOf` adds the line `Factory: <n> job(s) wait for the user.` when `n > 0`. It adds no job text.

- [ ] **Step 1: Write the failing tests.** Move Task 5's `view()` helper into `factory/tests/kit.ts` as `VIEW` (the two running jobs `PROJ-12` in `review` and `PROJ-13` in `build`, the waiting `PROJ-14` with the question `Which default font?` and the ready `PROJ-10` with PR 51). `FULL` is the kit's full model (task `PROJ-12`, progress 50% and blocked, one wrong check).

```ts
test('status text with jobs', async () => {
  expect(statusText({ ...FULL, factory: VIEW })).toBe('PROJ-12 · factory 2 run, 2 need you · 50% · 1 check wrong · blocked')
  const running = { ...VIEW, jobs: VIEW.jobs.filter(job => job.stage === 'review') }
  expect(statusText({ ...FULL, factory: running })).toBe('PROJ-12 · factory 1 run · 50% · 1 check wrong · blocked')
  expect(statusText({ ...FULL, factory: { ...VIEW, jobs: [] } })).toBe('PROJ-12 · 50% · 1 check wrong · blocked')
})
test('a job that starts to wait alerts once', async () => {
  const before = { ...FULL, factory: { ...VIEW, jobs: VIEW.jobs.map(job => ({ ...job, stage: 'review' as const, question: null })) } }
  const after = { ...FULL, factory: VIEW }
  expect(alertsFor(before, after)).toEqual(['PROJ-14 needs you: Which default font?', 'PROJ-10: PR 51 is ready. You merge.'])
  expect(alertsFor(after, after)).toEqual([])
  expect(alertsFor({ ...before, readAt: null }, after)).toEqual([])
  // A job that is new in the view and already waits alerts too.
  expect(alertsFor({ ...FULL, factory: { ...VIEW, jobs: [] } }, after)).toEqual(['PROJ-14 needs you: Which default font?', 'PROJ-10: PR 51 is ready. You merge.'])
})
test('the brief counts the waiting jobs and holds no job text', async () => {
  const brief = briefOf({ ...FULL, factory: VIEW }) ?? ''
  expect(brief).toContain('Factory: 2 jobs wait for the user.')
  expect(brief).not.toContain('Which default font')
  expect(briefOf({ ...FULL, factory: { ...VIEW, jobs: [] } })).not.toContain('Factory:')
})
```
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: factory jobs in the status line, the alerts and the brief"`

---

### Task 8: Sample jobs, README, final check

**Files:**
- Create: `docs/examples/factory-jobs/` with three folders (`12-add-dark-mode`, `14-different-fonts`, `10-multiple-walls`), each a `job.json` that `parseJob` accepts: one in `build` round 2 sent back by the gate, one in `needs-info` with a question, one `ready` with a PR
- Modify: `README.md`, `docs/notes/r1-check.md`
- Test: `factory/tests/examples.test.ts`

- [ ] **Step 1: Write the failing test.** A test has no file system, so the test file holds the three examples as objects (`EXAMPLES`, keyed by folder name) and asserts that `parseJob(JSON.stringify(example), folder)` accepts each, that the three stages are `build`, `needs-info` and `ready`, and that `factoryRows` of their view has `NEEDS YOU (2)`.
- [ ] **Step 2: Run** — Expected: FAIL (no examples yet).
- [ ] **Step 3: Write the examples** as the same objects, one `job.json` per folder (2-space JSON). Check them: `for f in docs/examples/factory-jobs/*/job.json; do python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" && echo ok; done` — Expected: `ok` three times.
- [ ] **Step 4: README:** a section "The factory line (not running yet)": what the FACTORY section shows, that jobs are files under `.factory/jobs/`, that `.factory/` must be git-ignored and is not used when git tracks it, and how to see the section by hand: `mkdir -p .factory/jobs && cp -R <plugin repo>/docs/examples/factory-jobs/* .factory/jobs/`, then `/factory`. Add the settings keys of Task 1 to the settings table, marked "used when the line runs".
- [ ] **Step 5: `docs/notes/r1-check.md`:** a new checklist for the owner: copy the examples into a scratch repo, open the pane wide and narrow, confirm the line, the three jobs and NEEDS YOU.
- [ ] **Step 6: Run** — validate, test, tsc — Expected: PASS.
- [ ] **Step 7: Commit** — `git commit -m "docs: sample jobs and the FACTORY section in the README"`

---

## Not in this plan (phase 2b)

Agents and their prompts, the fence hooks, worktrees, the gate's run and its own approval list, the GitHub writes (`comment`, `setState`, `linkPr`, the draft pull request), cost measured from agent token counts, `/factory plan`, `run`, `stop`, `answer`, `reject`, the keys in the pane (a digit for a NEEDS YOU item, `n`).
