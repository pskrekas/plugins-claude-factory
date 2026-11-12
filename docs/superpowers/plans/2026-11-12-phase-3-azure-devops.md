# Phase 3: Azure DevOps (Boards and Repos) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The panel and the factory line work with Azure DevOps: Boards work items as the tracker (the mark is a tag) and Repos as the pull request host, through the `az` command with the person's own login.

**Architecture:** Today the line calls the GitHub adapters by name. Task 2 puts two seams in their place: the `Tracker` contract grows the three actions the line already uses outside it (`scan`, `hasMark`, `me`), and a new `PrHost` contract holds the pull request actions. The context picks an adapter for each seam from the settings and the git remote. Then two new adapters, `azure-boards` and `azure-repos`, each a thin layer over one pure file that builds every `az` argument list. A tracker and a pull request host are chosen apart, so GitHub Issues with Azure Repos (or the other way round) works.

**Tech Stack:** TypeScript hooks module of a Claude Code plugin (no Node, no DOM); `claude plugin test factory`, `claude plugin validate factory`; the `az` CLI 2.x with the `azure-devops` extension (1.0.3 on the machine of the plan).

**Spec:** `docs/superpowers/specs/2026-11-12-factory-plugin-design.md`, sections 6 (settings: `tracker.kind`, `tracker.project`, `prHost`), 7.1 to 7.5 (the tracker contract, the adapters, the PR hosts, what is written), 8 (safety), 11 step 3.

## Global Constraints

- The plugin stores no credential. `az` uses the person's own login. "If the tool is missing or not logged in, the panel says which one and how to log in; nothing else fails." (7.2)
- The factory never merges. No `az` call completes a pull request: never `--status completed`, never `--auto-complete`, never `--bypass-policy`. A rule test checks every argument list.
- Every `az` call that reads or writes names its place: `--org https://dev.azure.com/<org>` (and `--project`, `--repository` where the command takes them), with `--detect false` and `--output json`. The place comes from the git remote `origin`, never from `az`'s own defaults.
- Text that came from outside (an item's title, a comment, an agent's question) is never an argument that `az` can read as an option or as a file name. `az` loads a value that starts with `@` from a file: such text goes into a file in the plugin's state folder, and the argument is `--<name>=@<that file>`.
- Every `az` call has a time limit (30 s), as `gh` calls do. An `az` that tries to install an extension by itself must not hang a hook.
- Only the comments of the item's author and of the person who runs the line reach an agent (phase 2b rule). On Azure DevOps a person is their `uniqueName`.
- The repository is public: no real organization, project, person or address in code, tests, docs or fixtures. Sample values: organization `acme`, project `Shop`, repository `web`, `me@example.com`.
- The four tracker states are `in-progress`, `needs-human`, `done`, `rejected` (7.1). The adapter does not change a work item's own workflow state: process templates differ.
- Not in this phase: `tracker.query` (the design's optional narrowing of the list). The mark and the project are the scope.

## Review Focus

1. **Text that starts with `@` or `-`.** A title `@/etc/hosts` or `--help`, a comment that starts with `@`: `az` never reads a local file for it and never takes it as an option. (Tasks 3, 4, 5)
2. **`az` is missing, not logged in, or has no `azure-devops` extension.** The panel and `/factory run` say one line with what to run; no call waits past its time limit. (Tasks 4, 6)
3. **A work item's text is HTML, long, or holds a script.** An agent's item file holds plain text, cut, with no tag; the plugin's own comment shows as text in the work item, not as markup. (Task 4)
4. **A pull request that someone completed or abandoned, or that a policy blocks.** The states map to `merged`, `closed`, `open`; a failed policy is a red build; the line never completes a pull request. (Task 5)
5. **A person changes the tags of a work item while the line runs.** The line's write keeps every tag that is not its own. (Task 4)

## File Structure

```
docs/notes/az-check.md                 the check of the real `az` (Task 1)
factory/adapters/tracker.ts            + scan, hasMark, me on Tracker
factory/adapters/pr-host.ts            new: the PrHost contract
factory/adapters/github-issues.ts      githubIssues() offers the new actions
factory/adapters/github-pr.ts          + githubPrs(run): PrHost
factory/core/azure.ts                  new, pure: the place of a remote, every az argument list, HTML <-> text
factory/adapters/azure-boards.ts       new: parsers and azureBoards(): Tracker
factory/adapters/azure-repos.ts        new: parsers and azureRepos(): PrHost
factory/core/task.ts                   toolNote for az
factory/core/init.ts                   a first settings file for an Azure remote
factory/core/fence.ts                  az boards / repos / devops are the line's (host mode)
factory/hooks/context.ts               picks the tracker and the host
factory/hooks/line.ts, commands.ts, start.ts, readers/task.ts, readers/factory.ts   use the seams
factory/tests/azure.test.ts, azure-boards.test.ts, azure-repos.test.ts, seams.test.ts
```

---

### Task 1: The check of the real `az`

Needs from the owner: an Azure DevOps organization, project and repository where the line may make one work item and one draft pull request, and remove them again. Without one, this task records what the `az` help says, marks every JSON shape below as "from the documentation", and the real check moves to the hand check (Task 7).

**Files:** Create `docs/notes/az-check.md`. No plugin code.

- [ ] **Step 1: Run each call once by hand** against the test project, with a throw-away work item and branch: `az boards work-item show --id <n> --expand all`; `az boards query --wiql "<the list query of Task 3>"`; `az devops invoke --area wit --resource comments --route-parameters project=<p> workItemId=<n> --api-version 7.1-preview.4` (read, then `--http-method POST --in-file <file>`); `az boards work-item update --id <n> --fields "System.Tags=a; b"`; `az boards work-item update --id <n> --discussion=@<file>`; `az repos pr create --draft true --title=@<file> …`; `az repos pr show --id <n>`; `az repos pr list --source-branch <b> --status all --top 1`; `az repos pr policy list --id <n>`; `az repos pr update --id <n> --draft false`; `az repos pr update --id <n> --status abandoned`; `az devops invoke --area git --resource pullRequestThreads … --in-file <file>`; `az account show --query user.name`.
- [ ] **Step 2: Write `docs/notes/az-check.md`:** a table of question and answer, as `r2c-check.md` has: the JSON fields the adapters read (with every real name replaced by a sample one); whether `--<name>=@<file>` loads the file for `--title`, `--description`, `--discussion`; whether a value that starts with `-` after `=` is a value; what a tag may hold (is `factory:in-progress` kept as written); whether a discussion comment is HTML or markdown; what `az` prints and which exit code it gives when it is not logged in and when the extension is missing; how long a call takes.
- [ ] **Step 3: Commit** `docs: the check of the az command`. If an answer differs from what Tasks 3 to 5 assume, change those tasks in this plan in the same commit and say so in the note.

---

### Task 2: The seams (no change of behaviour)

**Files:** Create `factory/adapters/pr-host.ts`. Modify `factory/adapters/tracker.ts`, `github-issues.ts`, `github-pr.ts`, `factory/hooks/context.ts`, `line.ts`, `commands.ts`, `start.ts`, `readers/task.ts`, `readers/factory.ts`. Test: `factory/tests/seams.test.ts`; every existing test stays green.

**Interfaces (Produces):**

```ts
// tracker.ts
export type Listed = { id: string; title: string; state: string }
export interface Tracker {
  kind: 'github' | 'azure-boards'
  // The queue (marked, open, not taken by the line) and the items the tracker says are in progress.
  // `items` is null when the list could not be read; `result` is the command's result, for the panel's note.
  scan(): Promise<{ items: Listed[] | null; claimed: Listed[]; result: RunResult | null }>
  list(mark: string): Promise<Listed[]>            // = scan().items ?? []
  hasMark(id: string): Promise<boolean>
  me(): Promise<string | null>                     // the person who runs the line, as the tracker names an author
  read(id: string): Promise<TrackerItem | null>
  comment(id: string, markdown: string): Promise<void>
  setState(id: string, state: TrackerState): Promise<void>
  linkPr(id: string, url: string): Promise<void>
}
// pr-host.ts
export interface PrHost {
  kind: 'github' | 'azure-repos'
  open(pr: { head: string; base: string; title: string; body: string }): Promise<{ pr: { number: number; url: string } | null; result: RunResult }>
  ready(number: number): Promise<RunResult>
  read(number: number): Promise<{ pr: PrState | null; result: RunResult }>
  current(branch: string): Promise<{ pr: PrState | null; result: RunResult }>   // the panel: the pull request of a branch
  comment(number: number, markdown: string): Promise<RunResult>
  close(number: number): Promise<RunResult>
}
// context.ts: Ctx gains `host: PrHost | null`; `Ctx.me` becomes `() => ctx.tracker?.me() ?? null`.
```

- `githubIssues(run, mark, forbidden)` returns the new `Tracker` (its `me` is the `gh api user` call that `context.ts` holds today). `githubPrs(run): PrHost` wraps the functions of `github-pr.ts`; `current` ignores its argument (`gh pr view` reads the checked-out branch).
- `line.ts`, `commands.ts`, `start.ts` call `ctx.host.*` and `ctx.tracker.scan / hasMark`; they import no GitHub adapter. A job that needs a pull request and finds `ctx.host === null` fails its step with `no pull request host for this repository`.
- The two refusals become `/factory run needs a tracker in the settings (github or azure-boards).` and the same for `/factory plan`.
- `failureText('gh', …)` in `commands.ts` takes the tool's name from the adapter's `kind` (`gh` or `az`).

- [ ] **Step 1: Failing test** `seams.test.ts`: `githubIssues(...).scan()` gives the same `items` and `claimed` as `listIssues`; `hasMark`, `me` as today; `githubPrs(run)` runs the same `gh` lines, word for word, as the six functions; a grep-style test that `hooks/line.ts`, `hooks/commands.ts`, `hooks/start.ts` hold no `adapters/github-` import.
- [ ] **Step 2: Run** `claude plugin test factory` — the new tests fail. **Step 3: Implement.** **Step 4: Run** all three commands — pass, with no change to any other test's expectation except the two refusal texts.
- [ ] **Step 5: Commit** `refactor: a tracker and a pull request host behind two contracts`.

---

### Task 3: Every `az` call, as a list (pure)

**Files:** Create `factory/core/azure.ts`. Test: `factory/tests/azure.test.ts`.

**Interfaces (Produces):**

```ts
export type AzPlace = { org: string; project: string; repo: string }   // org is the full URL https://dev.azure.com/<org>
// https://dev.azure.com/<org>/<project>/_git/<repo> (also with `<user>@`), git@ssh.dev.azure.com:v3/<org>/<project>/<repo>,
// https://<org>.visualstudio.com/<project>/_git/<repo>. Null for anything else. Each part: [A-Za-z0-9][A-Za-z0-9 ._-]{0,63}, URL-decoded once.
export function azPlaceOf(remote: string | null): AzPlace | null
export type AzCall =
  | { do: 'item'; place: AzPlace; id: string }
  | { do: 'item-comments'; place: AzPlace; id: string }
  | { do: 'query'; place: AzPlace; mark: string }
  | { do: 'set-tags'; place: AzPlace; id: string; tags: string[] }
  | { do: 'discuss'; place: AzPlace; id: string; file: string }
  | { do: 'link-item'; place: AzPlace; pr: number; id: string }
  | { do: 'me' }
  | { do: 'pr-open'; place: AzPlace; head: string; base: string; titleFile: string; bodyFile: string }
  | { do: 'pr-show'; place: AzPlace; pr: number }
  | { do: 'pr-of-branch'; place: AzPlace; branch: string }
  | { do: 'pr-policies'; place: AzPlace; pr: number }
  | { do: 'pr-ready'; place: AzPlace; pr: number }
  | { do: 'pr-abandon'; place: AzPlace; pr: number }
  | { do: 'pr-thread'; place: AzPlace; pr: number; file: string }
export function azArgs(call: AzCall): string[] | null     // null when a value breaks a rule
export function htmlToText(html: string, max?: number): string   // tags and entities out, `<br>` and `</p>` are line ends, cut at max (20000)
export function textToHtml(text: string): string                 // & < > escaped, line ends are <br>
export const stateTag = (mark: string, state: TrackerState) => `${mark}:${state}`
// The tags of a work item after the line set `state`: every tag that does not start with `<mark>:` is kept, in its order; then the one state tag.
export function tagsAfter(tags: string[], mark: string, state: TrackerState): string[]
```

- The lists, word for word (each ends with `--org <org> --detect false --output json`; `…` below stands for that):
  - `item`: `az boards work-item show --id <digits> --expand fields …`
  - `item-comments`: `az devops invoke --area wit --resource comments --route-parameters project=<project> workItemId=<digits> --api-version 7.1-preview.4 …`
  - `query`: `az boards query --wiql <one text> --project <project> …` with the text `SELECT [System.Id], [System.Title], [System.State], [System.Tags] FROM WorkItems WHERE [System.TeamProject] = '<project>' AND [System.Tags] CONTAINS '<mark>' AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') ORDER BY [System.Id]`. The mark passes `isMark` and holds no `'`; a project name holds no `'` either (the rule of `azPlaceOf`). The project is in the text: `az` sends a WIQL text with no project around it (`az-check.md`).
  - `set-tags`: `az boards work-item update --id <digits> --fields=System.Tags=<tags joined by "; "> …`. A tag: `[A-Za-z0-9][A-Za-z0-9:_ .-]{0,99}`, no `;`, no `,`.
  - `discuss`: `az boards work-item update --id <digits> --discussion=@<file> …`
  - `link-item`: `az repos pr work-item add --id <pr> --work-items <digits> …`
  - `me`: `az account show --query user.name --output tsv`
  - `pr-open`: `az repos pr create --draft true --source-branch <head> --target-branch <base> --title=@<titleFile> --description=@<bodyFile> --project <project> --repository <repo> …`. The head is `factory/<job id>`; the base passes `isBranchName`.
  - `pr-show`: `az repos pr show --id <pr> …`; `pr-of-branch`: `az repos pr list --source-branch <branch> --status all --top 1 --project <project> --repository <repo> …`; `pr-policies`: `az repos pr policy list --id <pr> …`
  - `pr-ready`: `az repos pr update --id <pr> --draft false …`; `pr-abandon`: `az repos pr update --id <pr> --status abandoned …`
  - `pr-thread`: `az devops invoke --area git --resource pullRequestThreads --route-parameters project=<project> repositoryId=<repo> pullRequestId=<pr> --http-method POST --in-file <file> --api-version 7.1 …`
- A `file` is an absolute path with no `..`, no control character, and it ends in `.txt` or `.json`.

- [ ] **Step 1: Failing tests:** `azPlaceOf` for the three forms, a user in the address, a space as `%20`, and nulls (a GitHub remote, four path parts, a part with `/..`); every list word for word; `azArgs` null for a bad id, a mark with `'`, a tag with `;`, a head that is not a job's branch, a file path that is relative; **the rule test**: over every list `azArgs` can answer, `list[0] === 'az'`, no word is `completed`, `--auto-complete`, `--bypass-policy`, `--delete-source-branch`, `--squash` or `--open`; every list but `me` holds `--org` and `--detect false`; no word starts with `@`, and a word that holds `=@` holds a path of the call's own file; `htmlToText('<p>a &amp; b</p><script>x</script><br>c')` is `a & b\nc`; `textToHtml('<b>&\n')` is `&lt;b&gt;&amp;<br>`; `tagsAfter(['bug', 'factory', 'factory:in-progress', 'Factory:x'], 'factory', 'needs-human')` is `['bug', 'factory', 'Factory:x', 'factory:needs-human']` (tags are compared as written); `tagsAfter` with `done` and `rejected` gives `factory:done`, `factory:rejected`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat: every az call of the factory, as a list`.

---

### Task 4: Azure Boards as a tracker

**Files:** Create `factory/adapters/azure-boards.ts`. Modify `factory/core/task.ts` (`toolNote(result, tool: 'gh' | 'az')`). Test: `factory/tests/azure-boards.test.ts`.

**Interfaces:**
- Consumes: `azArgs`, `AzPlace`, `htmlToText`, `textToHtml`, `tagsAfter`, `stateTag` (Task 3); `Tracker`, `Run` (Task 2); `commentOf`, `failureText`.
- Produces:

```ts
export type Put = (text: string, ext: 'txt' | 'json') => Promise<string | null>   // writes a file in the state folder's tmp/, answers its path
export function parseAzItem(json: string, place: AzPlace): TrackerItem | null     // id, title, state (lower-cased), text = htmlToText(System.Description), author = System.CreatedBy.uniqueName, url = <org>/<project>/_workitems/edit/<id>
export function parseAzComments(json: string): { author: string; text: string }[] // author = createdBy.uniqueName, text = htmlToText(text)
export function parseAzQuery(json: string): { id: string; title: string; state: string; tags: string[] }[]   // System.Tags is "a; b"
export function azureBoards(run: Run, put: Put, place: AzPlace, mark: string, forbidden: string[]): Tracker
```

- `scan`: one `query`. Only rows whose tag list holds the mark itself, as written, count (the query's `CONTAINS` may match more). `items` = those with no tag that starts with `<mark>:`; `claimed` = those with the tag `<mark>:in-progress`.
- `read`: `item`, then `item-comments`; the comments are the newest 50.
- `hasMark`: `item`, the tag list holds the mark (as written).
- `comment`: `commentOf(markdown, forbidden)`, then `textToHtml`, `put`, `discuss`. `setState`: `item` (the tags as they are now), `tagsAfter`, `set-tags`. `linkPr`: when the address is `<org>/<project>/_git/<repo>/pullrequest/<n>` of this place, `link-item`; else a comment `Pull request: <url>`.
- `me`: `az account show …`, one line that looks like an account name, else null.
- A method throws one readable line when its command fails (`failureText('az', result)`), as `githubIssues` does.
- `toolNote(result, 'az')`: `az could not start. Is it installed?`, `az did not answer in time`, `az is not logged in. Run: az login` (stderr holds `az login`), `az has no azure-devops extension. Run: az extension add --name azure-devops` (stderr holds `azure-devops` and `extension`, or `is misspelled or not recognized`).

- [ ] **Step 1: Failing tests** with a fake `run` that answers by the start of the line (fixtures from `az-check.md`, sample names only): the three parsers, also for JSON that is not what is expected (null or `[]`); `scan` splits queue and claimed; `read` gives plain text for an HTML description with a script, cut at 20000; `setState` keeps a person's tags (Review Focus 5: the tags are read in the same call, just before the write); `comment` writes the text through `put` and the `az` line holds `--discussion=@<path>`, never the text; a comment whose text starts with `@/etc/hosts` reaches `az` only inside the file (Review Focus 1); a forbidden word stops the comment before `put`; `linkPr` for an address of this place and for another; each `toolNote` text (Review Focus 2); a failing command throws `az: …`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat: Azure Boards as a tracker`.

---

### Task 5: Azure Repos as a pull request host

**Files:** Create `factory/adapters/azure-repos.ts`. Test: `factory/tests/azure-repos.test.ts`.

**Interfaces:**
- Consumes: `azArgs`, `AzPlace` (Task 3); `PrHost` (Task 2); `Put` (Task 4); `PrState` (`core/model`).
- Produces:

```ts
// status active -> open, completed -> merged, abandoned -> closed; isDraft; approvals = reviewers with vote >= 5 and no reviewer with vote < 0 (else 0);
// url = <org>/<project>/_git/<repo>/pullrequest/<pullRequestId>, built from the place (each part URL-encoded); build is filled by parseAzPolicies.
export function parseAzPr(json: string, place: AzPlace): PrState | null   // one object, or the first of a list
// 'none' for no policy; 'red' when any is rejected or broken; 'running' when any is queued or running; else 'green'.
export function parseAzPolicies(json: string): PrState['build']
export function azureRepos(run: Run, put: Put, place: AzPlace): PrHost
```

- `open`: the title (cleaned, at most 200 characters) and the body each go through `put`; `pr-open`; the answer is `parseAzPr` of what `az` prints (`number`, `url`). Nothing runs for a head that is not `factory/<job id>`.
- `read`: `pr-show`, then `pr-policies` for the build (a policy call that fails leaves `build: 'none'`). `current(branch)`: `pr-of-branch`, then `pr-policies`.
- `ready`: `pr-ready`. `close`: `pr-abandon`. `comment`: `put` of `{"comments":[{"parentCommentId":0,"content":<markdown>,"commentType":1}],"status":1}` as `json`, then `pr-thread`.

- [ ] **Step 1: Failing tests:** `parseAzPr` for active, draft, completed, abandoned, a list of one, and bad JSON; votes `10, 5` -> 2 approvals, `10, -10` -> 0; `parseAzPolicies` for each case; `open` puts the title in a file (a title `--help` and a title `@/etc/hosts` are text in that file; Review Focus 1) and answers the number and the web address; `open` with a head `main` runs nothing; `read` of a completed pull request is `merged` (Review Focus 4); `comment` writes valid JSON whose content is the markdown; **the factory never completes a pull request**: over every line the adapter ran in this file's tests, no word is `completed`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat: Azure Repos as a pull request host`.

---

### Task 6: The wiring

**Files:** Modify `factory/hooks/context.ts`, `readers/task.ts`, `readers/factory.ts`, `factory/core/init.ts`, `factory/core/fence.ts`, `factory/core/settings.ts` (the comment on `tracker.project`). Test: `factory/tests/line-run.test.ts` (one Azure path), `context` tests, `init.test.tsx`, `fence.test.ts`, `task` reader tests.

**Interfaces:**
- Consumes: `azureBoards`, `azureRepos`, `azPlaceOf`, `githubIssues`, `githubPrs`.
- `context(io)`: the host is `prHostOf(remote, settings.prHost)`: `github` -> `githubPrs` (needs `repoOf(remote)`), `azure-repos` -> `azureRepos` (needs `azPlaceOf(remote)`), else null. The tracker is by `settings.tracker.kind`: `github` -> `githubIssues` (needs `repoOf(remote)`); `azure-boards` -> `azureBoards` with the place of the remote, and `tracker.project` in place of the remote's project when it is set; a tracker kind with no adapter yet (`jira`, `asana`, `mcp`) -> null. `put` writes under `<state>/tmp/` and the file is removed after the call that used it.
- `/factory run` and `/factory plan` with `azure-boards` and a remote that names no Azure DevOps place: `The remote origin names no Azure DevOps project. Set tracker.project and use a dev.azure.com remote.`
- Readers: the task reader reads the item with `ctx`'s tracker kind and the pull request with `host.current(branch)`; the line `Azure DevOps Repos comes in a later version` goes. The factory reader's queue uses `tracker.scan()`.
- `draftSettings`: for an Azure remote, `tracker: { kind: 'azure-boards', mark: 'factory', project: <the remote's project> }`.
- Fence (host mode `Bash`): `az boards`, `az repos`, `az devops` and `az rest` are refused with `The line talks to the host; an agent does not.` (today only `az repos`).

- [ ] **Step 1: Failing tests:** a line run with `tracker.kind: 'azure-boards'` and an Azure remote goes from the queue to a ready pull request with only `az` lines for the tracker and the host (the fake answers the `az` lines; `inOrder`: query, show, set-tags, discuss, pr create, pr update `--draft false`, set-tags); GitHub Issues with an Azure remote uses `gh issue …` and `az repos pr …`; the refusal for a remote with no place; `/factory reject` abandons the pull request (`--status abandoned`); the panel's task row shows an Azure pull request (`current`); the `toolNote` for `az` shows as the row's note; `draftSettings` for an Azure remote; the four fence refusals.
- [ ] **Step 2–4.** **Step 5: Commit** `feat: the line runs on Azure DevOps`.

---

### Task 7: README, hand check, decisions

- [ ] **Step 1: README:** Install (the `az` CLI, `az extension add --name azure-devops`, `az login`); Settings (`tracker.kind: "azure-boards"`, `tracker.project`, `prHost`); "What it writes" for Azure DevOps (tags `<mark>:in-progress | needs-human | done | rejected`, discussion comments, a draft pull request, a link from the pull request to the work item; never a workflow state, never a completed pull request); every `az` call in the list of calls; troubleshooting for the three `az` notes. Say which mixes work.
- [ ] **Step 2: `docs/notes/r1-check.md`:** a hand check on a scratch Azure DevOps project (the steps of the GitHub one, with a tag in place of the label).
- [ ] **Step 3: `docs/notes/phase-3-decisions.md`** after the final review. **Step 4: Run all three commands** — pass. **Step 5: Commit** `docs: Azure DevOps`.
