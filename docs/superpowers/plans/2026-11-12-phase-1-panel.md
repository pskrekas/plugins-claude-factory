# Factory Plugin, Phase 1: The Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin (`factory`) whose docked pane shows the state of a developer's work in any git repo: the task, progress files, agents, environment checks, ports, worktrees and an owed list, with a status line, alerts and a session brief.

**Architecture:** A Claude Code mod: one hooks module (`factory/hooks/register.tsx`) that is thin, over pure functions in `factory/core/` that hold every rule and are tested directly. Readers in `factory/hooks/readers/` fetch outside data (files, `git`, `gh`, repo commands) and write one `PanelModel` into `$.state`; the pane draws only from that model. A repo configures the panel with `.claude/factory.json`; nothing project-specific is in the plugin.

**Tech Stack:** TypeScript (ES modules, JSX against the global `h`), the Claude Code mod API (`claude-code`, `claude-code/testing`), `claude plugin validate`, `claude plugin test`, `tsc`. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-12-factory-plugin-design.md` (sections 4.1, 4.3, 4.4, 6, 7.1, 7.4, 8.1 "Consent for commands", 9, 10, 11 phase 1, 12 R1). Phase 2 (the factory line, FACTORY section, jobs) is **not** in this plan.

## Global Constraints

- Plugin name `factory`; settings file `.claude/factory.json`; pane id `factory`; pane title `Factory`.
- The repo root is the marketplace (`.claude-plugin/marketplace.json`); the plugin lives in `factory/`.
- No project or company name, ticket prefix, account or email anywhere in code, tests, docs or sample data. Sample ids are `PROJ-12`, sample email `me@example.com`.
- The plugin stores no password or token. Outside data comes only through `$.process.run` of `git`, `gh`, `df`, `nc` and the repo's approved commands, and through `$.fs`.
- No command from a repo's settings file runs before the person approved the command list (spec 8.1).
- A section with nothing to show takes no room. No drawn row is longer than `e.props.bodyColumns`.
- All behaviour is in `factory/core/` as pure functions (no `$`). `factory/hooks/` only reads, calls `core/`, writes state, draws.
- Module rules of the mod API: no `import()`, no Node or DOM globals; plugin files are imported with relative `import` declarations.
- Slow reads run at most once per 60 s each, and not at all while the pane is closed.
- Minimum Claude Code version: 2.1.322 (the version this was designed on). On an older version the plugin prints one line: `factory: needs Claude Code 2.1.322 or later`.
- Terminal surface first; `desktop`, `vscode` and `mobile` must mount without error.
- Every commit message ends with the repo's attribution line if the session provides one. Commit author is the repo's local git identity; do not change it.

**Commands used by every task**

```bash
claude plugin validate factory     # expect: no "refused" lines
claude plugin test factory         # expect: all tests pass
npx -p typescript tsc -p factory   # expect: no errors (needs factory/.claude-plugin/types/, written at the first load; see Task 1 Step 6)
```

## Review Focus

1. **A settings file that is not valid JSON, or has a wrong type in one key.** The panel still opens, shows the general parts and one line `settings: <reason>`; nothing throws. (Tasks 3, 4)
2. **A repo command that hangs or prints megabytes.** A check ends after 10 s as `error`, the pane stays responsive, the output is cut to 200 characters before it is stored. (Task 6)
3. **`gh`, `git` or `nc` missing, or `gh` not logged in.** The section shows one line naming the tool and how to log in; other sections are not affected. (Tasks 6, 7)
4. **A pane 24 columns wide.** Every row is cut to the width with `…`; no row spills. (Task 2)
5. **The settings file's commands change after approval.** The panel goes back to "settings not approved" and runs nothing until approved again. (Task 4)

## File Structure

```
.claude-plugin/marketplace.json     marketplace entry: plugin "factory", source "./factory"
README.md  LICENSE  .gitignore
factory/
  .claude-plugin/plugin.json        name, version, description, types, userConfig
  hooks/hooks.json                  { "modules": ["./register.tsx"] }
  hooks/register.tsx                events, commands, the pane, the timer
  hooks/state.ts                    the $.state atom and its helpers
  hooks/refresh.ts                  runs the readers, merges into the model
  hooks/readers/settings.ts         .claude/factory.json + consent
  hooks/readers/progress.ts         progress files, owed file
  hooks/readers/checks.ts           checks, ports
  hooks/readers/task.ts             branch, tracker item, pull request
  hooks/readers/work.ts             agents, worktrees
  core/model.ts                     PanelModel and its parts; emptyModel()
  core/layout.ts                    model -> rows; status line text
  core/settings.ts                  parse + defaults + command list + hash
  core/consent.ts                   approval rule
  core/progress.ts                  progress and owed parsers
  core/checks.ts                    check and port judging, df parser
  core/task.ts                      ticket id, PR host, gh JSON parsers
  core/work.ts                      worktree parser, agent rows
  core/alerts.ts                    model diff -> alerts
  core/brief.ts                     model -> session brief text
  core/init.ts                      repo facts -> first settings file
  adapters/tracker.ts               the five-action contract (types only in phase 1)
  adapters/github-issues.ts         read() through gh
  adapters/github-pr.ts             PR state through gh
  fx/alert.wav                      the alert sound
  types/index.d.ts                  PluginState contract
  tests/*.test.ts(x)
docs/notes/r1-check.md              result of the R1 check (Task 1)
```

---

### Task 1: Skeleton plugin, model types, the R1 check

**Files:**
- Create: `.claude-plugin/marketplace.json`, `README.md`, `LICENSE` (MIT, holder `pskrekas`, 2026), `.gitignore` (`node_modules/`, `.factory/`, `factory/.claude-plugin/types/`, `*.log`)
- Create: `factory/.claude-plugin/plugin.json`, `factory/hooks/hooks.json`, `factory/hooks/register.tsx`, `factory/hooks/state.ts`, `factory/core/model.ts`, `factory/types/index.d.ts`, `factory/tsconfig.json`
- Create: `docs/notes/r1-check.md`
- Test: `factory/tests/skeleton.test.tsx`

**Interfaces:**
- Produces (`factory/core/model.ts`), used by every later task:

```ts
export type CheckState = { name: string; state: 'ok' | 'wrong' | 'error' | 'unknown'; got?: string }
export type PortState = { name: string; port: number; state: 'up' | 'down' | 'unknown' }
export type ProgressState = { name: string; path: string; done: number; open: number; percent: number | null; blocked: string | null }
export type PrState = { number: number; state: 'open' | 'merged' | 'closed'; isDraft: boolean; build: 'green' | 'red' | 'running' | 'none'; approvals: number; url: string }
export type TaskState = { id: string | null; branch: string; title: string | null; state: string | null; pr: PrState | null; note: string | null }
export type AgentRow = { id: string; label: string; kind: string | null; isRunning: boolean; startedAt: number | null }
export type WorktreeRow = { path: string; branch: string | null; isMerged: boolean }
export type Consent = 'none' | 'needed' | 'approved'   // none = no settings file
export type PanelModel = {
  consent: Consent; pendingCommands: string[]; settingsError: string | null
  task: TaskState | null; progress: ProgressState[]; agents: AgentRow[]
  checks: CheckState[]; ports: PortState[]; worktrees: WorktreeRow[]
  owed: { open: number } | null; notes: string[]; readAt: number | null
}
export function emptyModel(): PanelModel
```

- Produces (`factory/hooks/state.ts`): `export const panel` (an `atom` on `{ plugin: 'factory', key: 'panel' }`, initial `emptyModel()`, `shape: 'panel-1'`); `export const PANE = 'factory'`.
- Produces (`register.tsx`): commands `/factory` (opens the pane, answers `Factory pane opened.`) and `/factory close` (closes it, answers `Factory pane closed.`); a `ui.render` hook on `{ component: 'Pane', requestId: PANE }`.

- [ ] **Step 1: Write the failing test** `factory/tests/skeleton.test.tsx`

```tsx
import { expect, test } from 'claude-code/testing'
const PANE = { plugin: 'factory', component: 'Pane', requestId: 'factory',
  props: { title: 'Factory', isFocused: false, bodyColumns: 40, placement: 'dock',
           scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

test('the pane mounts on every surface and says there is no settings file', async ($, on) => {
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /No settings file/ }))?.text)
      .toBe('No settings file. Run /factory init.')
    await ui.unmount()
  }
})

test('/factory opens the pane and /factory close closes it', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', (_, e) => { opened.push('close:' + e.id); return { value: {} } })
  expect((await $.command.run({ command: 'factory', args: '' })).text).toBe('Factory pane opened.')
  expect((await $.command.run({ command: 'factory', args: 'close' })).text).toBe('Factory pane closed.')
  expect(opened).toEqual(['factory', 'close:factory'])
})
```

If the testing kit spells an input differently (`args`, the `ui.close` answer), follow `claude-code/testing`'s typings and keep the assertions.

- [ ] **Step 2: Run it** — `claude plugin test factory` — Expected: FAIL (no plugin yet).
- [ ] **Step 3: Write the manifests.** `plugin.json`: `{ "name": "factory", "version": "0.1.0", "description": "A work panel and a software factory for Claude Code", "types": "./types/index.d.ts", "userConfig": { "openOnStart": { "type": "boolean", "default": false, "description": "Open the pane when a session starts" }, "sound": { "type": "boolean", "default": true, "description": "Play a short sound with an alert" } } }`. `hooks.json`: `{ "modules": ["./register.tsx"] }`. `marketplace.json`: one plugin, name `factory`, `"source": "./factory"`. `types/index.d.ts`: `declare module 'claude-code' { interface PluginState { factory: { panel: Shaped<PanelModel> } } }`.
- [ ] **Step 4: Implement `core/model.ts`, `hooks/state.ts`, `hooks/register.tsx`.** `register` registers the command in `session.start`, opens the pane there only when `options.openOnStart` is true and `e.viewport?.isFullscreen` is not false, answers `command.run` for `factory` (args `''` and `'close'`; any other argument answers `Unknown: /factory <arg>` in this task), and draws one `<Text dimColor>No settings file. Run /factory init.</Text>` when `consent === 'none'`. Read the engine version with `$.session.version()`; under `2.1.322` log `factory: needs Claude Code 2.1.322 or later` with `$.ui.log` and register nothing else.
- [ ] **Step 5: Run** — `claude plugin validate factory` then `claude plugin test factory` — Expected: validate lists the hooks, no refusal; 2 tests pass.
- [ ] **Step 6: The R1 check (needs the owner's terminal).** Run `claude --plugin-dir ./factory` in the repo, type `/factory`. Record in `docs/notes/r1-check.md`: the Claude Code version, whether the pane seated (docked or inline) and at what terminal width, any dim `factory:` line in the transcript, and whether `factory/.claude-plugin/types/` now exists. Then run `npx -p typescript tsc -p factory` (its `tsconfig.json` extends `./.claude-plugin/types/tsconfig.json`); Expected: no errors. If the pane does not seat or a hook is reported as not run, stop and report; the plan's later tasks assume both work.
- [ ] **Step 7: Write `README.md`** — what it is (two sentences), install (`/plugin marketplace add pskrekas/plugins-claude-factory`, `/plugin install factory@plugins-claude-factory`), `/factory`, "early version: the panel only".
- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: plugin skeleton with an empty pane"`

---

### Task 2: Layout and status line from a model

**Files:**
- Create: `factory/core/layout.ts`
- Modify: `factory/hooks/register.tsx` (the render hook draws `rowsOf`)
- Test: `factory/tests/layout.test.ts`, `factory/tests/pane-width.test.tsx`

**Interfaces:**
- Consumes: `PanelModel`, `emptyModel` (Task 1).
- Produces:

```ts
export type Tone = 'plain' | 'dim' | 'good' | 'warn' | 'bad' | 'head'
export type Row = { left: string; right: string; tone: Tone; rightTone: Tone }
export function rowsOf(model: PanelModel, columns: number, now: number): Row[]
export function statusText(model: PanelModel): string | undefined
export function fit(left: string, right: string, columns: number): { left: string; right: string }
```

Rules `rowsOf` must follow (spec 4.1), in this order; a section with no data adds no row:
- `consent === 'none'` → one dim row `No settings file. Run /factory init.` then the general sections (AGENTS, MORE).
- `consent === 'needed'` → head row `SETTINGS NOT APPROVED`, one row per `pendingCommands` entry (dim), one row `Run /factory approve to allow these commands.`; then the general sections only.
- `settingsError` → one `bad` row `settings: <error>`.
- TASK: head `TASK`; row `<id> <title>` right `<state>`; if `pr`: row `PR <number> · build <build> · <n> approval` (`approvals` when n is not 1) right `ok` (good) when build is green, `draft` (dim) when `isDraft`; if `note`: one dim row with the note.
- PROGRESS: head `PROGRESS`; per item row `<name>` right `<percent>%` (or `-` when null); if `blocked`: a `bad` row `BLOCKED: <text>`.
- AGENTS: head `AGENTS`; per running agent row `<label> <kind>` right `<minutes> m` (from `startedAt` and `now`); at most 6, then `+ N more`.
- CHECKS: head `CHECKS`; per check row `<name>` right `ok` (good) / `<got>` (bad, for `wrong`) / `error` (bad) / `?` (dim).
- PORTS: head `PORTS`; row `<name> :<port>` right `up` (good) / `DOWN` (bad) / `?` (dim).
- MORE: head `MORE`; `WORKTREES <n> · <m> merged, remove?` (omit the tail when m is 0; omit the row when n ≤ 1); `OWED BY YOU <n>` (omit when null or 0).
- Last row, dim, when `readAt` is set: `read <seconds> s ago`.
- `fit` cuts `left` with a trailing `…` so that `left.length + 1 + right.length <= columns`; when `right` alone is too long it is cut too.
- `statusText`: parts joined by ` · `: the task id; `<percent>%` of the first progress item; `checks ok` or `<n> check(s) wrong`; `blocked` when any progress is blocked. `undefined` when there are no parts.

- [ ] **Step 1: Write the failing tests** `factory/tests/layout.test.ts` (pure; the `$` and `on` arguments are unused)

```ts
import { expect, test } from 'claude-code/testing'
import { emptyModel } from '../core/model'
import { fit, rowsOf, statusText } from '../core/layout'

const full = { ...emptyModel(), consent: 'approved' as const,
  task: { id: 'PROJ-12', branch: 'feat/PROJ-12-x', title: 'Add dark mode', state: 'open', note: null,
          pr: { number: 51, state: 'open' as const, isDraft: false, build: 'green' as const, approvals: 1, url: 'u' } },
  progress: [{ name: 'Plan A', path: 'p', done: 7, open: 7, percent: 50, blocked: 'disk is full' }],
  checks: [{ name: 'cloud account', state: 'wrong' as const, got: 'other@example.com' }],
  ports: [{ name: 'database', port: 5432, state: 'down' as const }],
  worktrees: [{ path: '/a', branch: 'main', isMerged: false }, { path: '/b', branch: 'x', isMerged: true }],
  owed: { open: 3 }, readAt: 1000 }

test('an empty model draws only the no-settings line', async () => {
  expect(rowsOf(emptyModel(), 60, 0).map(r => r.left)).toEqual(['No settings file. Run /factory init.'])
})
test('every section appears, in order, with its rows', async () => {
  const heads = rowsOf(full, 60, 5000).filter(r => r.tone === 'head').map(r => r.left)
  expect(heads).toEqual(['TASK', 'PROGRESS', 'CHECKS', 'PORTS', 'MORE'])
  const text = rowsOf(full, 60, 5000).map(r => r.left + '|' + r.right)
  expect(text).toContain('PROJ-12 Add dark mode|open')
  expect(text).toContain('PR 51 · build green · 1 approval|ok')
  expect(text).toContain('Plan A|50%')
  expect(text).toContain('BLOCKED: disk is full|')
  expect(text).toContain('cloud account|other@example.com')
  expect(text).toContain('database :5432|DOWN')
  expect(text).toContain('WORKTREES 2 · 1 merged, remove?|')
  expect(text).toContain('OWED BY YOU 3|')
  expect(text[text.length - 1]).toBe('read 4 s ago|')
})
test('needed consent lists the commands and hides repo sections', async () => {
  const rows = rowsOf({ ...full, consent: 'needed', pendingCommands: ['npm test'] }, 60, 0).map(r => r.left)
  expect(rows.slice(0, 3)).toEqual(['SETTINGS NOT APPROVED', 'npm test', 'Run /factory approve to allow these commands.'])
  expect(rows).not.toContain('CHECKS')
})
test('no row is wider than the pane, at 24 to 120 columns', async () => {
  for (let columns = 24; columns <= 120; columns++)
    for (const r of rowsOf(full, columns, 5000))
      expect(r.left.length + (r.right ? 1 + r.right.length : 0)).toBeLessThanOrEqual(columns)
})
test('fit cuts the left side with an ellipsis', async () => {
  expect(fit('abcdefghij', 'ok', 8)).toEqual({ left: 'abcd…', right: 'ok' })
})
test('status text', async () => {
  expect(statusText(full)).toBe('PROJ-12 · 50% · 1 check wrong · blocked')
  expect(statusText(emptyModel())).toBe(undefined)
})
```

`factory/tests/pane-width.test.tsx`: seed the atom through `on('state.get', …)` with `full` (version 1, the shape tag `panel-1`), mount the pane on `terminal` with `bodyColumns: 24`, and assert that a `Text` matching `/PROJ-12/` exists and that no found `Text`'s `text` is longer than 24.

- [ ] **Step 2: Run** — `claude plugin test factory` — Expected: FAIL (`rowsOf` not defined).
- [ ] **Step 3: Implement `core/layout.ts`** to the rules above.
- [ ] **Step 4: Draw.** In `register.tsx` the render hook reads the atom, calls `rowsOf(model, e.props.bodyColumns, await $.clock.now())` and maps each row to one `<Text>` (`head` → bold; `dim` → `dimColor`; `good`/`warn`/`bad` → the theme's success/warning/error colour keys as the `Text` props type names them). After each model write, call `$.ui.status(statusText(model))`.
- [ ] **Step 5: Run** — validate, test — Expected: all pass.
- [ ] **Step 6: Commit** — `git commit -am "feat: draw the panel from a model"` (add new files first).

---

### Task 3: Settings parser

**Files:**
- Create: `factory/core/settings.ts`
- Test: `factory/tests/settings.test.ts`

**Interfaces:**
- Produces:

```ts
export type CheckSpec = { name: string; run?: string[]; want?: string; minFreeGb?: number }
export type Settings = {
  ticketPattern: string | null
  tracker: { kind: 'github' | 'azure-boards' | 'jira' | 'asana' | 'mcp'; mark: string; project: string | null } | null
  prHost: 'auto' | 'github' | 'azure-repos'
  baseBranch: string
  progress: { files: string; done: string; open: string; blocked: string } | null
  checks: CheckSpec[]
  ports: { name: string; port: number }[]
  owed: string | null
  gate: { fast: string[][]; full: string[][] }
}
export const DEFAULTS: Settings   // ticketPattern null, tracker null, prHost 'auto', baseBranch 'main',
                                  // progress null, checks [], ports [], owed null, gate { fast: [], full: [] }
export function parseSettings(text: string | null): { settings: Settings; error: string | null }
export function commandsOf(settings: Settings): string[]   // each command as one line, argv joined by ' ', sorted, no duplicates
export function hashOf(lines: string[]): string            // stable 8-hex digest (FNV-1a 32-bit of lines joined by '\n')
```

Rules: `null` text → `DEFAULTS`, no error. Invalid JSON → `DEFAULTS`, error `not valid JSON`. A key with a wrong type → that key's default, error `<key>: wrong type` (first one only). Unknown keys are ignored (phase 2 keys such as `factory` must not cause an error). `progress` given without `done`/`open`/`blocked` gets `^- \\[x\\]`, `^- \\[ \\]`, `BLOCKED`. A pattern that is not a valid regular expression → that key's default, error `<key>: not a valid pattern`. `tracker.mark` defaults to `factory`. `commandsOf` returns the `run` of every check and every `gate.fast` and `gate.full` command (the gate does not run in phase 1; its commands are listed so one approval covers them).

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { DEFAULTS, commandsOf, hashOf, parseSettings } from '../core/settings'

test('no file gives the defaults', async () => {
  expect(parseSettings(null)).toEqual({ settings: DEFAULTS, error: null })
})
test('broken JSON gives the defaults and says why', async () => {
  expect(parseSettings('{ nope')).toEqual({ settings: DEFAULTS, error: 'not valid JSON' })
})
test('a wrong type falls back for that key only', async () => {
  const { settings, error } = parseSettings('{"ports": "x", "baseBranch": "dev"}')
  expect(settings.ports).toEqual([]); expect(settings.baseBranch).toBe('dev'); expect(error).toBe('ports: wrong type')
})
test('unknown and phase 2 keys are ignored', async () => {
  expect(parseSettings('{"factory": {"slots": 2}, "zzz": 1}').error).toBe(null)
})
test('progress gets checkbox patterns by default', async () => {
  expect(parseSettings('{"progress": {"files": "docs/*/p.md"}}').settings.progress)
    .toEqual({ files: 'docs/*/p.md', done: '^- \\[x\\]', open: '^- \\[ \\]', blocked: 'BLOCKED' })
})
test('a bad pattern is refused', async () => {
  expect(parseSettings('{"ticketPattern": "("}')).toEqual({ settings: DEFAULTS, error: 'ticketPattern: not a valid pattern' })
})
test('ports map becomes a list', async () => {
  expect(parseSettings('{"ports": {"database": 5432}}').settings.ports).toEqual([{ name: 'database', port: 5432 }])
})
test('commands are listed once, sorted, and hashed stably', async () => {
  const s = parseSettings(JSON.stringify({ checks: [{ name: 'a', run: ['x', 'y'] }, { name: 'd', minFreeGb: 5 }],
    gate: { fast: [['npm', 'test']], full: [['npm', 'test'], ['npm', 'run', 'build']] } })).settings
  expect(commandsOf(s)).toEqual(['npm run build', 'npm test', 'x y'])
  expect(hashOf(commandsOf(s))).toBe(hashOf(['npm run build', 'npm test', 'x y']))
  expect(hashOf(['a'])).not.toBe(hashOf(['b']))
  expect(hashOf(['a'])).toMatch(/^[0-9a-f]{8}$/)
})
```

- [ ] **Step 2: Run** — Expected: FAIL (`parseSettings` not defined).
- [ ] **Step 3: Implement `core/settings.ts`.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add factory/core/settings.ts factory/tests/settings.test.ts && git commit -m "feat: settings parser with defaults"`

---

### Task 4: Loading the settings, consent, the refresh loop

**Files:**
- Create: `factory/core/consent.ts`, `factory/hooks/refresh.ts`, `factory/hooks/readers/settings.ts`
- Modify: `factory/hooks/register.tsx` (`/factory approve`, the timer, refresh on open)
- Test: `factory/tests/consent.test.ts`, `factory/tests/refresh.test.ts`

**Interfaces:**
- Consumes: `parseSettings`, `commandsOf`, `hashOf` (Task 3); `panel` atom (Task 1).
- Produces:

```ts
// core/consent.ts
export function consentOf(hasFile: boolean, commands: string[], storedHash: unknown): Consent
//   no file -> 'none'; file with no commands -> 'approved'; storedHash === hashOf(commands) -> 'approved'; else 'needed'
export function storeKey(repoRoot: string): string        // 'consent:' + repoRoot

// hooks/refresh.ts
export type Ctx = { root: string; settings: Settings; consent: Consent; now: number }
export type Reader = ($: Engine, ctx: Ctx, prev: PanelModel) => Promise<Partial<PanelModel>>
export const readers: Reader[]                            // later tasks push their reader here
export async function refresh($: Engine): Promise<PanelModel>

// hooks/readers/settings.ts
export async function loadSettings($: Engine): Promise<{ root: string; settings: Settings; error: string | null; consent: Consent; pendingCommands: string[] }>
```

`refresh`: calls `loadSettings`; builds `Ctx`; runs every reader with `Promise.allSettled` (a reader that rejects adds `<reader name>: failed` to `notes` and changes nothing else); merges the results over the previous model; sets `consent`, `pendingCommands`, `settingsError`, `readAt`; writes the atom; calls `$.ui.status(statusText(model))`; returns the model. A reader must return `{}` when `ctx.consent !== 'approved'` if it runs a command from the settings.

`loadSettings`: `root` is `(await $.session.repo())?.root ?? await $.session.cwd()`; reads `<root>/.claude/factory.json` with `$.fs.read` (a missing file is `null`, not an error); the stored hash is `await $.store.get(storeKey(root))`.

`register.tsx`: `/factory approve` stores `hashOf(commandsOf(settings))` under `storeKey(root)`, refreshes, answers `Approved <n> command(s).` (or `Nothing to approve.`). A `$.clock.every(60_000, …)` started in `session.start` calls `refresh` only while the pane is open (track open/close in a module variable set by the plugin's own open and close calls and by the `ui.close` event for the pane). `/factory` refreshes after it opens the pane.

- [ ] **Step 1: Write the failing tests**

```ts
// consent.test.ts
import { expect, test } from 'claude-code/testing'
import { consentOf, storeKey } from '../core/consent'
import { hashOf } from '../core/settings'
test('consent states', async () => {
  expect(consentOf(false, [], undefined)).toBe('none')
  expect(consentOf(true, [], undefined)).toBe('approved')
  expect(consentOf(true, ['npm test'], undefined)).toBe('needed')
  expect(consentOf(true, ['npm test'], hashOf(['npm test']))).toBe('approved')
  expect(consentOf(true, ['npm test', 'rm -rf x'], hashOf(['npm test']))).toBe('needed')
  expect(storeKey('/r')).toBe('consent:/r')
})
```

`refresh.test.ts` (engine-level; `mock.store(on)` holds the store, `on('fs.read', …)` answers the settings file, `on('session.repo', …)` answers `{ root: '/r', remote: null }`):
- `a settings file with a check asks for approval and runs nothing`: file `{"checks":[{"name":"a","run":["x"]}]}`; fail the test if `process.run` is dispatched; after `/factory`, the pane shows `SETTINGS NOT APPROVED` and `x`.
- `/factory approve stores the hash and the panel leaves the not-approved state`: after `/factory approve` the answer is `Approved 1 command(s).` and the pane no longer shows `SETTINGS NOT APPROVED`.
- `a changed command asks again`: approve, then answer `fs.read` with `["x","--force"]`, run `/factory`; the pane shows `SETTINGS NOT APPROVED` again.
- `broken settings show one line and the pane still draws`: file `{ nope`; the pane shows `settings: not valid JSON`.
- `a reader that throws is noted and the rest still draws`: push a reader that rejects; the model's `notes` has one entry and `readAt` is set.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `core/consent.ts`, `hooks/readers/settings.ts`, `hooks/refresh.ts`, and the `register.tsx` changes.
- [ ] **Step 4: Run** — validate, test — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: load settings, ask consent for commands, refresh loop"`

---

### Task 5: Progress files and the owed list

**Files:**
- Create: `factory/core/progress.ts`, `factory/hooks/readers/progress.ts`
- Modify: `factory/hooks/refresh.ts` (push the reader)
- Test: `factory/tests/progress.test.ts`

**Interfaces:**
- Consumes: `Settings.progress`, `Settings.owed`, `Reader`, `Ctx`.
- Produces:

```ts
export function parseProgress(text: string, p: { done: string; open: string; blocked: string }): { done: number; open: number; percent: number | null; blocked: string | null }
export function parseOwed(text: string): { open: number }
export function nameOf(text: string, path: string): string   // the first markdown heading's text, else the file's parent folder name
export function matchGlob(pattern: string, paths: string[]): string[]   // supports `*` inside one path segment only
```

Rules: lines are matched with `new RegExp(pattern)` per line. `percent = round(100 * done / (done + open))`, `null` when both are 0. `blocked` is the **last** line that matches the blocked pattern, trimmed, with a leading `#`, `-`, `*` or the pattern's own word and one `:` removed, cut to 80 characters; `null` when a later line contains `UNBLOCKED` or `RESUMED`. `parseOwed` counts lines matching `^\s*- \[ \]`. The reader lists candidate files by walking the directories of the glob with `$.fs.list` (no recursion beyond the glob's depth), reads each (skip files over 1 MiB), sorts by name, keeps at most 8. Progress and owed files are read without consent (they run nothing).

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { matchGlob, nameOf, parseOwed, parseProgress } from '../core/progress'
const P = { done: '^- \\[x\\]', open: '^- \\[ \\]', blocked: 'BLOCKED' }
test('checkboxes give a percent', async () => {
  expect(parseProgress('- [x] a\n- [x] b\n- [ ] c\ntext', P)).toEqual({ done: 2, open: 1, percent: 67, blocked: null })
})
test('no boxes give no percent', async () => {
  expect(parseProgress('hello', P).percent).toBe(null)
})
test('the last blocked line is kept, cleaned', async () => {
  expect(parseProgress('- [ ] a\n## BLOCKED: disk is full\n', P).blocked).toBe('disk is full')
})
test('a later resume clears the block', async () => {
  expect(parseProgress('BLOCKED: x\nRESUMED 12:00\n', P).blocked).toBe(null)
})
test('owed counts open boxes', async () => {
  expect(parseOwed('- [ ] a\n- [x] b\n  - [ ] c')).toEqual({ open: 2 })
})
test('name comes from the heading, else the folder', async () => {
  expect(nameOf('# Plan A\n', 'docs/plans/a/progress.md')).toBe('Plan A')
  expect(nameOf('no heading', 'docs/plans/a/progress.md')).toBe('a')
})
test('glob matches one segment', async () => {
  expect(matchGlob('docs/*/progress.md', ['docs/a/progress.md', 'docs/a/b/progress.md', 'docs/x.md']))
    .toEqual(['docs/a/progress.md'])
})
```

Add one engine-level test: with `fs.list` and `fs.read` answered for `docs/a/progress.md` (`# Plan A\n- [x] a\n- [ ] b`) and `.claude/owed.md` (`- [ ] x`), after `/factory` the pane shows `Plan A`, `50%` and `OWED BY YOU 1`; and with consent `needed` it still shows them.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the parsers and the reader.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: progress files and the owed list"`

---

### Task 6: Checks and ports

**Files:**
- Create: `factory/core/checks.ts`, `factory/hooks/readers/checks.ts`
- Modify: `factory/hooks/refresh.ts`
- Test: `factory/tests/checks.test.ts`

**Interfaces:**
- Consumes: `CheckSpec`, `Settings.ports`, `Reader`, `Ctx`.
- Produces:

```ts
export type RunResult = { exitCode: number; stdout: string } | { failed: 'timeout' | 'not-found' | 'other' }
export function judgeCheck(spec: CheckSpec, result: RunResult): CheckState
export function parseDfFreeGb(stdout: string): number | null   // POSIX `df -Pk <path>`: 4th column of the last line, KiB -> GiB, one decimal
export function judgeDisk(spec: CheckSpec, freeGb: number | null): CheckState
export function judgePort(name: string, port: number, result: RunResult): PortState
```

Rules: `judgeCheck` with `want`: `ok` when `stdout.trim() === want`, else `wrong` with `got` = trimmed stdout cut to 200 characters; without `want`: `ok` when `exitCode === 0`, else `wrong` with `got` `exit <code>`. A `failed` result → `error` with `got` `timeout`, `not found` or `failed`. `judgeDisk`: `ok` when `freeGb >= minFreeGb`, else `wrong` with `got` `<free> GB free`; `null` → `unknown`. `judgePort`: `up` on exit 0, `down` on another exit code, `unknown` when `nc` failed to start. The reader runs each check with `$.process.run(run, { cwd: root, timeoutMs: 10_000 })`, the disk check with `['df', '-Pk', root]`, each port with `['nc', '-z', '-w', '1', '127.0.0.1', String(port)]`, all in parallel; a rejection maps to `{ failed: … }`. It returns `{}` when `ctx.consent !== 'approved'`; this holds for the disk and port checks too, so one rule covers the whole reader (a settings file with no commands is `approved` by `consentOf`).

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { judgeCheck, judgeDisk, judgePort, parseDfFreeGb } from '../core/checks'
test('a check with a wanted value', async () => {
  const spec = { name: 'cloud account', run: ['x'], want: 'me@example.com' }
  expect(judgeCheck(spec, { exitCode: 0, stdout: 'me@example.com\n' })).toEqual({ name: 'cloud account', state: 'ok' })
  expect(judgeCheck(spec, { exitCode: 0, stdout: 'other@example.com\n' }))
    .toEqual({ name: 'cloud account', state: 'wrong', got: 'other@example.com' })
})
test('a check with no wanted value passes on exit 0', async () => {
  expect(judgeCheck({ name: 'a', run: ['x'] }, { exitCode: 3, stdout: '' })).toEqual({ name: 'a', state: 'wrong', got: 'exit 3' })
})
test('long output is cut to 200 characters', async () => {
  expect(judgeCheck({ name: 'a', run: ['x'], want: 'y' }, { exitCode: 0, stdout: 'z'.repeat(5000) }).got?.length).toBe(200)
})
test('a timeout is an error, not a crash', async () => {
  expect(judgeCheck({ name: 'a', run: ['x'] }, { failed: 'timeout' })).toEqual({ name: 'a', state: 'error', got: 'timeout' })
})
test('df output gives free GiB', async () => {
  const out = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/d1 482797652 424673280 34603008 93% /\n'
  expect(parseDfFreeGb(out)).toBe(33); expect(parseDfFreeGb('garbage')).toBe(null)
})
test('disk and port judging', async () => {
  expect(judgeDisk({ name: 'disk', minFreeGb: 40 }, 33)).toEqual({ name: 'disk', state: 'wrong', got: '33 GB free' })
  expect(judgeDisk({ name: 'disk', minFreeGb: 10 }, null)).toEqual({ name: 'disk', state: 'unknown' })
  expect(judgePort('database', 5432, { exitCode: 1, stdout: '' })).toEqual({ name: 'database', port: 5432, state: 'down' })
  expect(judgePort('database', 5432, { failed: 'not-found' })).toEqual({ name: 'database', port: 5432, state: 'unknown' })
})
```

Engine-level tests: (a) approved settings with one check; `process.run` answered `{ exitCode: 0, stdout: 'x' }`; the pane shows the check `ok`. (b) `process.run` rejects; the pane shows `error` and the other sections still draw. (c) consent `needed`: fail the test if `process.run` is dispatched.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: environment checks and ports"`

---

### Task 7: The task: ticket, tracker item, pull request

**Files:**
- Create: `factory/adapters/tracker.ts`, `factory/adapters/github-issues.ts`, `factory/adapters/github-pr.ts`, `factory/core/task.ts`, `factory/hooks/readers/task.ts`
- Modify: `factory/hooks/refresh.ts`
- Test: `factory/tests/task.test.ts`

**Interfaces:**
- Consumes: `Settings.ticketPattern`, `Settings.tracker`, `Settings.prHost`, `TaskState`, `PrState`.
- Produces:

```ts
// adapters/tracker.ts — the contract of spec 7.1; phase 1 implements read() only
export type TrackerState = 'in-progress' | 'needs-human' | 'done' | 'rejected'
export type TrackerItem = { id: string; title: string; state: string; text: string; author: string; url: string; comments: { author: string; text: string }[] }
export type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
export interface Tracker {
  list(mark: string): Promise<Pick<TrackerItem, 'id' | 'title' | 'state'>[]>
  read(id: string): Promise<TrackerItem | null>
  comment(id: string, markdown: string): Promise<void>
  setState(id: string, state: TrackerState): Promise<void>
  linkPr(id: string, url: string): Promise<void>
}
// adapters/github-issues.ts
export function githubIssues(run: Run): Pick<Tracker, 'read'>
export function parseGhIssue(json: string): TrackerItem | null
// adapters/github-pr.ts
export function parseGhPr(json: string): PrState | null
export async function readPr(run: Run): Promise<PrState | null>      // gh pr view --json number,state,isDraft,reviewDecision,statusCheckRollup,url
// core/task.ts
export function ticketOf(branch: string, pattern: string | null): string | null   // first capture group if the pattern has one, else the whole match
export function prHostOf(remote: string | null, setting: Settings['prHost']): 'github' | 'azure-repos' | null
export function toolNote(stderr: string, tool: 'gh'): string | null
```

Rules: `githubIssues.read(id)` runs `gh issue view <digits of id> --json number,title,state,body,author,comments,url`; a non-zero exit → `null`. `parseGhPr`: `state` lower-cased (`OPEN`→`open`, `MERGED`→`merged`, `CLOSED`→`closed`); `build`: `none` when `statusCheckRollup` is empty, `red` when any entry's `conclusion` is `FAILURE`, `TIMED_OUT` or `CANCELLED`, `running` when any `status` is not `COMPLETED`, else `green`; `approvals`: 1 when `reviewDecision === 'APPROVED'`, else 0. `prHostOf`: `auto` reads the remote (`github.com` → `github`, `dev.azure.com` or `visualstudio.com` → `azure-repos`, else `null`). `toolNote`: stderr containing `command not found` or `ENOENT` → `gh is not installed`; containing `gh auth login` → `gh is not logged in. Run: gh auth login`; else `null`. The reader: branch from `git rev-parse --abbrev-ref HEAD`; the task is `null` when there is no branch (not a repo); the tracker is read only when `tracker.kind === 'github'` and a ticket id was found; the PR only when the PR host is `github` (an Azure remote gets `note` `Azure DevOps Repos comes in a later version`). `gh` and `git` are not repo commands, so this reader runs without consent.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { prHostOf, ticketOf, toolNote } from '../core/task'
import { parseGhIssue } from '../adapters/github-issues'
import { parseGhPr } from '../adapters/github-pr'
test('ticket id from a branch', async () => {
  expect(ticketOf('feat/PROJ-12-dark-mode', 'PROJ-\\d+')).toBe('PROJ-12')
  expect(ticketOf('issue-12-x', 'issue-(\\d+)')).toBe('12')
  expect(ticketOf('main', 'PROJ-\\d+')).toBe(null)
  expect(ticketOf('x', null)).toBe(null)
})
test('PR host from the remote', async () => {
  expect(prHostOf('git@github.com:a/b.git', 'auto')).toBe('github')
  expect(prHostOf('https://dev.azure.com/o/p/_git/r', 'auto')).toBe('azure-repos')
  expect(prHostOf('https://example.com/r.git', 'auto')).toBe(null)
  expect(prHostOf(null, 'github')).toBe('github')
})
test('gh issue JSON', async () => {
  const j = JSON.stringify({ number: 12, title: 'Add dark mode', state: 'OPEN', body: 'b', url: 'u',
    author: { login: 'ann' }, comments: [{ author: { login: 'bob' }, body: 'c' }] })
  expect(parseGhIssue(j)).toEqual({ id: '12', title: 'Add dark mode', state: 'open', text: 'b', author: 'ann', url: 'u',
    comments: [{ author: 'bob', text: 'c' }] })
  expect(parseGhIssue('not json')).toBe(null)
})
test('gh PR JSON', async () => {
  const pr = (extra: object) => JSON.stringify({ number: 51, state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', url: 'u', statusCheckRollup: [], ...extra })
  expect(parseGhPr(pr({}))).toEqual({ number: 51, state: 'open', isDraft: false, build: 'none', approvals: 1, url: 'u' })
  expect(parseGhPr(pr({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }))?.build).toBe('green')
  expect(parseGhPr(pr({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] }))?.build).toBe('running')
  expect(parseGhPr(pr({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }] }))?.build).toBe('red')
  expect(parseGhPr('')).toBe(null)
})
test('a missing or logged-out gh gives a plain note', async () => {
  expect(toolNote('zsh: command not found: gh', 'gh')).toBe('gh is not installed')
  expect(toolNote('To get started with GitHub CLI, please run:  gh auth login', 'gh')).toBe('gh is not logged in. Run: gh auth login')
  expect(toolNote('other', 'gh')).toBe(null)
})
```

Engine-level tests: (a) settings `{"ticketPattern":"PROJ-(\\d+)","tracker":{"kind":"github"}}`; `process.run` answers the branch `feat/PROJ-12-x`, the issue JSON and the PR JSON above; the pane shows the rows `12 Add dark mode` and `PR 51 · build none · 1 approval`. (b) `gh` rejects as not found; the TASK section shows the branch and the dim row `gh is not installed`, and PROGRESS still draws.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: task section with GitHub issue and pull request"`

---

### Task 8: Agents and worktrees

**Files:**
- Create: `factory/core/work.ts`, `factory/hooks/readers/work.ts`
- Modify: `factory/hooks/refresh.ts`, `factory/hooks/register.tsx` (refresh the agents on `agent.spawn` and on a subagent's `turn.complete`)
- Test: `factory/tests/work.test.ts`

**Interfaces:**
- Consumes: `AgentRow`, `WorktreeRow`, `Settings.baseBranch`; `AgentInfo` from `claude-code` (read its fields in the types file; use its id, its description or type for the label, and whether it is still running).
- Produces:

```ts
export function parseWorktrees(porcelain: string, mergedBranches: string[], baseBranch: string): WorktreeRow[]
export function parseMerged(stdout: string): string[]                 // `git branch --merged <base>` output -> branch names
export function agentRows(agents: readonly AgentInfo[], startedAt: Record<string, number>): AgentRow[]
```

Rules: `parseWorktrees` reads `git worktree list --porcelain` blocks (`worktree <path>`, `branch refs/heads/<name>`, `detached`); `isMerged` is true when the branch is in `mergedBranches` and is not `baseBranch`. `agentRows` keeps running agents first, then at most 3 ended ones; `label` is cut to 40 characters. The plugin records each agent's start time itself (a module map filled on `agent.spawn`, with `$.clock.now()`), because the rows need a running clock. The reader runs `git worktree list --porcelain` and `git branch --merged <baseBranch> --format=%(refname:short)` (no consent needed).

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { parseMerged, parseWorktrees } from '../core/work'
const PORCELAIN = 'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/wt/a\nHEAD def\nbranch refs/heads/feat-a\n\nworktree /r/wt/b\nHEAD 123\ndetached\n'
test('worktrees with merged marks', async () => {
  expect(parseWorktrees(PORCELAIN, ['main', 'feat-a'], 'main')).toEqual([
    { path: '/r', branch: 'main', isMerged: false },
    { path: '/r/wt/a', branch: 'feat-a', isMerged: true },
    { path: '/r/wt/b', branch: null, isMerged: false },
  ])
})
test('merged branch list', async () => {
  expect(parseMerged('main\nfeat-a\n')).toEqual(['main', 'feat-a'])
})
```

Engine-level tests: (a) `agent.list` answers one running agent; after an `agent.spawn` the pane shows the `AGENTS` head and the agent's label. (b) `git worktree list` answered with `PORCELAIN` and merged `feat-a`: the pane shows `WORKTREES 3 · 1 merged, remove?`. (c) not a git repo (`git` exits 128): no `MORE` head, no error row.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: agents and worktrees"`

---

### Task 9: Alerts and the session brief

**Files:**
- Create: `factory/core/alerts.ts`, `factory/core/brief.ts`, `factory/fx/alert.wav`
- Modify: `factory/hooks/refresh.ts` (raise alerts after a refresh), `factory/hooks/register.tsx` (`prompt.compose` hook)
- Test: `factory/tests/alerts.test.ts`

**Interfaces:**
- Consumes: `PanelModel`; `options.sound` (Task 1's `userConfig`).
- Produces:

```ts
export function alertsFor(prev: PanelModel, next: PanelModel): string[]
export function briefOf(model: PanelModel): string | null
```

Rules for `alertsFor` (an alert is raised only on a change, never on the first read where `prev.readAt === null`): a progress item whose `blocked` went from `null` to a text → `<name> is BLOCKED: <text>`; a check that went from `ok` to `wrong` or `error` → `Check "<name>" is wrong: <got>`; a port that went from `up` to `down` → `<name> :<port> is DOWN`. `refresh` shows each with `$.ui.toast(text)` and, when `options.sound` is true and there is at least one, plays `$.audio.play({ asset: 'fx/alert.wav' })` once.

Rules for `briefOf`: `null` when there is no task, no progress and no owed count. Else lines, in this order, only those that have data: `Task: <id> <title> (<state>).`; `Branch: <branch>.`; `Pull request: <number>, <state>, build <build>.`; one `Progress: <name> <percent>%[, BLOCKED: <text>].` per item (at most 3); `Owed by the user: <n> item(s).` The `prompt.compose` hook adds `{ id: 'factory:brief', text: 'Work state (from the factory plugin):\n' + brief, scope: 'session' }` last, from the model in the atom, and adds nothing when `briefOf` is `null`. It never refreshes: a brief must not delay a prompt.

`fx/alert.wav`: 0.15 s, 880 Hz sine, 8-bit mono, 8000 Hz, with a 20 ms fade in and out. Generate it once with a throwaway script outside the repo and commit only the file (about 1.2 kB).

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { emptyModel } from '../core/model'
import { alertsFor } from '../core/alerts'
import { briefOf } from '../core/brief'
const base = { ...emptyModel(), consent: 'approved' as const, readAt: 1,
  progress: [{ name: 'Plan A', path: 'p', done: 1, open: 1, percent: 50, blocked: null }],
  checks: [{ name: 'cloud account', state: 'ok' as const }],
  ports: [{ name: 'database', port: 5432, state: 'up' as const }] }
test('nothing on the first read', async () => {
  expect(alertsFor(emptyModel(), base)).toEqual([])
})
test('a new block, a wrong check and a port that went down each alert once', async () => {
  const next = { ...base,
    progress: [{ ...base.progress[0], blocked: 'disk is full' }],
    checks: [{ name: 'cloud account', state: 'wrong' as const, got: 'other@example.com' }],
    ports: [{ name: 'database', port: 5432, state: 'down' as const }] }
  expect(alertsFor(base, next)).toEqual(['Plan A is BLOCKED: disk is full',
    'Check "cloud account" is wrong: other@example.com', 'database :5432 is DOWN'])
  expect(alertsFor(next, next)).toEqual([])
})
test('the brief', async () => {
  expect(briefOf(emptyModel())).toBe(null)
  expect(briefOf({ ...base, owed: { open: 2 },
    task: { id: 'PROJ-12', branch: 'feat/PROJ-12-x', title: 'Add dark mode', state: 'open', pr: null, note: null } }))
    .toBe('Task: PROJ-12 Add dark mode (open).\nBranch: feat/PROJ-12-x.\nProgress: Plan A 50%.\nOwed by the user: 2 items.')
})
```

Engine-level tests: (a) two refreshes where a check turns wrong dispatch exactly one `ui.toast` with the text above, and one `audio.play`; with `test(name, { options: { sound: false } }, …)` no `audio.play`. (b) `$.prompt.compose()` with a seeded model answers a list whose last section has id `factory:brief`; with an empty model no such section.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**, and add the sound file.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: alerts and the session brief"`

---

### Task 10: `/factory init`, README, final check

**Files:**
- Create: `factory/core/init.ts`
- Modify: `factory/hooks/register.tsx` (`/factory init`, `/factory` help for unknown arguments), `README.md`
- Test: `factory/tests/init.test.ts`

**Interfaces:**
- Consumes: `Settings` (Task 3), `prHostOf` (Task 7).
- Produces:

```ts
export type RepoFacts = { remote: string | null; baseBranch: string | null; packageJson: string | null; hasPyproject: boolean; hasMakefile: boolean }
export function draftSettings(facts: RepoFacts): string      // the JSON text of a first .claude/factory.json, 2-space indent, trailing newline
```

Rules: `tracker` is `{ "kind": "github", "mark": "factory" }` only for a GitHub remote, else the key is left out. `baseBranch` from the facts, default `main`. `gate.fast` / `gate.full` from `package.json` scripts: `lint` → `["npm","run","lint"]` in both; `test` → `["npm","test"]` in both; `build` → `["npm","run","build"]` in full only. With `hasPyproject` and no package.json: `["python3","-m","pytest","-q"]` in both. Otherwise both are `[]`. Always: `"checks": [{ "name": "disk", "minFreeGb": 10 }]`, `"progress": { "files": "docs/plans/*/progress.md" }`, `"owed": ".claude/owed.md"`. No `ticketPattern` (the person adds it). The command `/factory init`: refuses when `.claude/factory.json` exists (`.claude/factory.json exists. Edit it by hand.`), else writes the draft with `$.fs.write` and answers `Wrote .claude/factory.json. Read it, then run /factory approve.` It never overwrites. `/factory <other>` answers `Commands: /factory, /factory close, /factory init, /factory approve`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { draftSettings } from '../core/init'
import { parseSettings } from '../core/settings'
test('a GitHub repo with npm scripts', async () => {
  const s = parseSettings(draftSettings({ remote: 'git@github.com:a/b.git', baseBranch: 'main', hasPyproject: false, hasMakefile: false,
    packageJson: JSON.stringify({ scripts: { lint: 'x', test: 'y', build: 'z' } }) }))
  expect(s.error).toBe(null)
  expect(s.settings.tracker).toEqual({ kind: 'github', mark: 'factory', project: null })
  expect(s.settings.gate).toEqual({ fast: [['npm', 'run', 'lint'], ['npm', 'test']],
    full: [['npm', 'run', 'lint'], ['npm', 'test'], ['npm', 'run', 'build']] })
  expect(s.settings.checks).toEqual([{ name: 'disk', minFreeGb: 10 }])
})
test('a Python repo with another remote', async () => {
  const s = parseSettings(draftSettings({ remote: 'https://example.com/r.git', baseBranch: 'dev', packageJson: null, hasPyproject: true, hasMakefile: false })).settings
  expect(s.tracker).toBe(null); expect(s.baseBranch).toBe('dev')
  expect(s.gate.fast).toEqual([['python3', '-m', 'pytest', '-q']])
})
test('an unknown repo gets no gate', async () => {
  expect(parseSettings(draftSettings({ remote: null, baseBranch: null, packageJson: 'not json', hasPyproject: false, hasMakefile: false })).settings.gate)
    .toEqual({ fast: [], full: [] })
})
```

Engine-level tests: (a) no settings file: `/factory init` dispatches one `fs.write` to `<root>/.claude/factory.json` and answers the "Wrote" line. (b) the file exists: no `fs.write`, the "exists" answer.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — validate, test, tsc — Expected: all pass.
- [ ] **Step 5: Finish `README.md`:** what the panel shows (the table of spec 4.1 without FACTORY), the commands of this phase, the settings keys of this phase with the example of spec section 6 cut to them, "What it can reach" (the commands it runs: `git`, `gh`, `df`, `nc`, and the repo's approved commands; it stores no token; it runs no repo command before approval), troubleshooting (pane does not appear; `gh` not logged in; settings not approved), "Next: the factory line (phase 2)".
- [ ] **Step 6: Whole-plugin check by hand** in a scratch git repo with a GitHub remote: `claude --plugin-dir <repo>/factory`; `/factory init`; `/factory approve`; confirm TASK, PROGRESS (add a `docs/plans/a/progress.md` with two boxes), CHECKS (disk), the status line, and one alert (add a `BLOCKED: test` line, wait one minute). Write what was seen under a new heading in `docs/notes/r1-check.md`.
- [ ] **Step 7: Commit** — `git commit -m "feat: /factory init, README for the panel phase"`

---

## Not in this plan (later phases)

The FACTORY section and the line, jobs and `.factory/`, `/factory plan|run|stop|answer|reject`, the tracker actions `list`, `comment`, `setState`, `linkPr`, Azure DevOps, Jira, Asana, the `mcp` tracker kind, TESTS in MORE (it has no honest source before the gate exists), the desktop picture of the line, the keys `w`, `t`, `o`.
