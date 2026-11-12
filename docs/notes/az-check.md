# The `az` command: what the plan of phase 3 rests on

Written on 2026-11-12 from two sources on the machine of the plan: the help of each
command (`az <command> -h`), and the installed code of the Azure CLI 2.86.0 and of
its `azure-devops` extension 1.0.3. **No call was run against a real organization**
(the owner's choice). Every JSON shape below is from the documentation of the Azure
DevOps REST API, as the extension passes it on. The hand check
(`docs/notes/r1-check.md`) is where each one meets a real answer.

## What the code says

| Question | Answer | Source |
|---|---|---|
| Does `az` read a value from a file? | Yes. A word that starts with `@` is taken as a file name, and its content is the value (`@-` is standard input, `@~/x` a file of the home folder). Also after `=`: `--title=@/path` loads `/path`. A file that cannot be read leaves the word as it is. | `azure/cli/core/commands/__init__.py`, `_expand_file_prefixed_files` |
| So what must the plugin never do? | Hand `az` a word of outside text that starts with `@`: `az` would send a file of the person's machine. The plugin writes such text to a file of its own and passes `--<name>=@<that file>`. | the same |
| Is `--draft` a flag or a value? | A value: `--draft true`, `--draft false` (create and update). | `repos/arguments.py` |
| Which call completes (merges) a pull request? | `az repos pr update --status completed`, and `--auto-complete true`. The plugin builds neither. | `repos/pull_request.py` |
| How is a description given? | `--description` takes several words, joined by line ends. One word that holds line ends is one description. | `repos/pull_request.py` |
| How is a field set? | `--fields "<name>=<value>"`, split at the first `=`. Tags are the field `System.Tags`, one text with `; ` between tags: a write replaces the whole list. | `boards/work_item.py` |
| What does `--discussion` do? | It adds the text to the work item's history (a comment). The service shows it as HTML. | `boards/work_item.py` |
| Does a WIQL query know the project? | `az boards query --wiql` sends the text with no project around it, so `@project` is not used: the query names the project as text. It answers the work items with the fields the query selects, at most 1000. | `boards/work_item.py`, `query_work_items` |
| Do work item and pull request ids need a project? | No. `az boards work-item show|update` and `az repos pr show|update|policy list` take `--org` only. `az repos pr create|list` take `--project` and `--repository`. | the help |
| Is there a command for a pull request comment, or to read a work item's comments? | No. Both go through `az devops invoke` (`--area`, `--resource`, `--route-parameters key=value …`, `--api-version`, `--http-method`, `--in-file <a JSON file>`). | the help, `team/invoke.py` |
| What happens when the `azure-devops` extension is missing? | `az` answers `'boards …' is misspelled or not recognized by the system`, and first tries to install the extension by itself, which can wait a long time. Every call of the plugin has a time limit. | seen on the machine, with a wrong command name |
| What does `az` say when nobody is logged in? | `Before you can run Azure DevOps commands, you need to run the login command (az login if using AAD/MSA identity else az devops login if using PAT token) …` | `common/services.py` |
| How long is a call? | The help of a command took about 1 s with `AZURE_CORE_COLLECT_TELEMETRY=no`. A real call was not timed. | seen on the machine |

## The JSON the adapters read (from the documentation)

Sample names only: organization `acme`, project `Shop`, repository `web`.

- **A work item** (`az boards work-item show`): `{ "id": 12, "fields": { "System.Title": "…", "System.State": "New", "System.Description": "<div>…</div>", "System.Tags": "bug; factory", "System.TeamProject": "Shop", "System.CreatedBy": { "displayName": "…", "uniqueName": "me@example.com" } } }`. An older service gives `System.CreatedBy` as one text, `Name <me@example.com>`.
- **A query** (`az boards query`): a list of such objects, each with only the selected fields.
- **A work item's comments** (`az devops invoke --area wit --resource comments`): `{ "count": 2, "comments": [ { "text": "<div>…</div>", "createdBy": { "uniqueName": "me@example.com" } } ] }`.
- **A pull request** (`az repos pr show`, and what `create` prints; `list` gives a list): `{ "pullRequestId": 7, "status": "active" | "completed" | "abandoned", "isDraft": true, "reviewers": [ { "vote": 10 } ], … }`. Votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting, -10 rejected.
- **Its policies** (`az repos pr policy list`): a list of `{ "status": "approved" | "running" | "queued" | "rejected" | "broken" | "notApplicable", "configuration": { "isBlocking": true } }`.
- **A new thread** on a pull request (the body of the POST): `{ "comments": [ { "parentCommentId": 0, "content": "…", "commentType": 1 } ], "status": 1 }`.
- **Who is logged in**: `az account show --query user.name --output tsv` prints one line, the account's name.

## Not known until the hand check

- The exact text of each failure, and its exit code.
- Whether a tag keeps a `:` as written (`factory:in-progress`).
- Whether the comments of a work item come newest first.
- Whether `7.1-preview.4` is the version a given server accepts for the comments.
- Whether a work item's discussion shows the plugin's text as the plugin escaped it.
