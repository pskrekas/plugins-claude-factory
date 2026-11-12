# Phase 3 (Azure DevOps: Boards and Repos): decisions

Plan: `docs/superpowers/plans/2026-11-12-phase-3-azure-devops.md`. Built on branch
`phase-3-azure-devops` (on top of `phase-2c-container`), 2026-11-12. 495 tests. An
automated security review read every commit; a fresh reviewer read the whole branch
at the end, with the installed `az` code beside it.

## The decision that shaped the work

**Nothing was run against a real Azure DevOps organization** (the owner's choice).
The `az` calls are built from the help of each command and from the installed code
of the Azure CLI and its `azure-devops` extension (`docs/notes/az-check.md`). The
JSON the adapters read is from the documentation. So:

- Reading the tool's own code found what a guess would have missed: `az` loads a word
  that starts with `@` from a file; a WIQL text is sent with no project around it;
  `--draft` takes a value; `az repos pr update --status completed` is a merge.
- It also missed one thing that the final review found in the same code: the version
  text `7.1-preview.4` cannot be read by the extension, so the call for a work item's
  comments could never work. It is `7.1-preview` now, and a rule test reads every
  version text the way the extension does.
- Each adapter fails closed where an answer is not what it expects: an item that
  cannot be parsed is no item; a query that is not a list is an empty queue; a pull
  request with an unknown state is no pull request.
- The hand check (`docs/notes/r1-check.md`, "Azure DevOps, by hand") is where each
  call meets a real answer. Until it is done, phase 3 is not proven.

## Decisions made while building

1. **Two contracts.** `Tracker` (the five actions, and `scan`, `hasMark`, `me`) and
   `PrHost` (open a draft, ready, read, the pull request of a branch, comment, close).
   The line, the commands and the run start name no adapter. There is no merge action
   in the contract.
2. **A tracker and a pull request host are chosen apart.** GitHub Issues or Azure
   Boards; GitHub or Azure Repos. For a mix, `tracker.project` names the other place
   (`owner/name`, or `<organization>/<project>`).
3. **A place that the settings file names counts only when approved.** A settings
   file arrives with a clone. It shows as a line `[tracker] …` in the pane, and
   `/factory approve` allows it, like a gate command. With an Azure DevOps remote the
   organization is always the remote's: the settings cannot name another one.
4. **The mark and the four states are tags.** `<mark>:in-progress`, `needs-human`,
   `done`, `rejected`. An item with a state tag is not in the queue. A work item's own
   workflow state is never changed: process templates differ.
5. **Outside text reaches `az` only in a file.** A title, a description and a comment
   are written to a file in the state folder's `tmp/`, passed as `--<name>=@<file>`,
   and the file is removed. Every other value passes a rule that leaves no `@` and no
   `-` at its start. A rule test checks every list.
6. **No call completes a pull request.** `azArgs` is the only place that builds an
   `az` list; the rule test refuses `completed`, `--auto-complete`, `--bypass-policy`
   and the options that only matter at a merge.
7. **Every call names its place** (`--org`, `--detect false`), and `az` is told not to
   install an extension by itself (`AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no`).
8. **A work item's HTML becomes plain text** in one pass (text from outside must not
   make the plugin wait), with a bug's steps and a story's acceptance criteria. The
   plugin's own comment is escaped, so it shows as text.
9. **An item whose comments cannot be read is not started.** Its author may have
   answered a question there. The panel asks for no comments.
10. **`/factory run` does not start when the tracker cannot be read** (its tool is
    missing or not logged in), also on GitHub, and says why. It refuses when the
    remote has no pull request host.
11. **The host fence refuses `az` whole**, as it refuses `gh`: `az` can also hand out
    a login token.
12. **An item of another project is not this tracker's.** Ids are the organization's;
    an item whose project is not the tracker's reads as no item.

## Known gaps

- **The tags are read and written in two calls.** `az boards work-item update` sends
  no test of what it replaces. A tag that a person changes in the moment between the
  two (well under a second) is written over: a mark that was just removed can come
  back, a tag that was just added can go. The fix is a PATCH with a test of the
  revision through `az devops invoke`; it is not built, because that call cannot be
  proven without a real organization. The README says so.
- **Who "me" is.** `az account show` names the user of the default subscription. If
  Azure DevOps knows the person by another name (another tenant, a token), the
  runner's own comments do not reach an agent. A stranger's never do.
- **A pull request that a person set to auto-complete** completes when the line marks
  it ready. That is the person's own setting.

## Small findings, not fixed

- A reviewers policy counts as "build running" until someone approves; a group's vote
  can count twice. Display only.
- A project or repository name with letters outside ASCII, the short remote form
  `<organization>/_git/<repository>` and the old `vs-ssh.visualstudio.com` form give
  "names no Azure DevOps project".
- A pull request in the same organization but another project is a comment on the
  work item, though a link would work.
- A call that breaks a rule, and a call that ran out of time, both read
  `az: could not start` in a failure text.
- `Ctx.run` and `Adapters.run` have no caller left.
- A file in `tmp/` that a killed hook left is never swept.
- `<img alt=">">` leaves the text after the first `>`; `&lt;script&gt;` becomes the
  text `<script>` in an agent's item file (quoted data).
- The closed states in the query are the names of the stock processes (`Closed`,
  `Done`, `Removed`, `Resolved`): a custom process with other names keeps a closed
  item in the queue until it gets a state tag.
- `hasMark` answers "does not carry the mark" when the tool is missing (from before
  this phase).
- Azure DevOps Server and other clouds are not handled; `tracker.query` is not built.

## Not checked on a real organization

Everything. In order of what is most likely to differ: which `comments` resource
`az devops invoke` picks; the order of the comments; the account name against an
author's `uniqueName`; the fields of a bug; whether a tag keeps its `:`; the text and
the exit code of each failure; how long a call takes.
