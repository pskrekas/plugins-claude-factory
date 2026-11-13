# Jira, through Atlassian's MCP server

Not tested. Nobody ran this mapping against Jira.

This page gives a settings file for Atlassian's remote MCP server. The names of the tools and their arguments are from the server's own tool list, as read on 2026-11-13. The shapes of the answers (`issues`, `key`, `fields.summary`, `fields.status.name`, `fields.reporter.displayName`, `fields.labels`, `fields.comment.comments`, `author.displayName`, `body`) are the shapes of Jira's REST API. They were not seen from the MCP server. Try the mapping with `/factory tracker` before you run the line.

The reference for every key is [mcp.md](mcp.md).

## Before you start

- Connect Atlassian's MCP server with `/mcp`, and sign in to your site there.
- The example names the server `atlassian`. Use the name `/mcp` shows for it.
- Replace `<your-site>` (six times) with your site's name, and `PROJ` (twice) with your project's key.

## The settings

```json
{
  "tracker": {
    "kind": "mcp",
    "mark": "factory",
    "server": "atlassian",
    "url": "https://<your-site>.atlassian.net/browse/{id}",
    "list": {
      "tool": "searchJiraIssuesUsingJql",
      "args": {
        "cloudId": "<your-site>.atlassian.net",
        "jql": "project = PROJ AND labels = \"{mark}\" AND labels not in (\"{mark}:in-progress\", \"{mark}:needs-human\", \"{mark}:done\", \"{mark}:rejected\") AND statusCategory != Done",
        "fields": ["summary", "status"]
      },
      "rows": "issues", "id": "key", "title": "fields.summary", "state": "fields.status.name"
    },
    "claimed": {
      "tool": "searchJiraIssuesUsingJql",
      "args": {
        "cloudId": "<your-site>.atlassian.net",
        "jql": "project = PROJ AND labels = \"{mark}\" AND labels = \"{mark}:in-progress\"",
        "fields": ["summary", "status"]
      },
      "rows": "issues", "id": "key", "title": "fields.summary", "state": "fields.status.name"
    },
    "read": {
      "tool": "getJiraIssue",
      "args": {
        "cloudId": "<your-site>.atlassian.net",
        "issueIdOrKey": "{id}",
        "fields": ["summary", "description", "status", "reporter", "labels", "comment"],
        "responseContentFormat": "markdown"
      },
      "title": "fields.summary", "text": "fields.description", "author": "fields.reporter.displayName",
      "state": "fields.status.name", "labels": "fields.labels",
      "comments": "fields.comment.comments", "commentAuthor": "author.displayName", "commentText": "body"
    },
    "comment": {
      "tool": "addCommentToJiraIssue",
      "args": {
        "cloudId": "<your-site>.atlassian.net",
        "issueIdOrKey": "{id}",
        "commentBody": "{text}",
        "contentFormat": "markdown"
      }
    },
    "states": {
      "labels": {
        "tool": "editJiraIssue",
        "args": {
          "cloudId": "<your-site>.atlassian.net",
          "issueIdOrKey": "{id}",
          "fields": { "labels": "{labels}" }
        }
      }
    }
  }
}
```

The tools it calls:

| Action | Tool | Arguments |
| --- | --- | --- |
| `list`, `claimed` | `searchJiraIssuesUsingJql` | `cloudId`, `jql`, `fields` |
| `read` | `getJiraIssue` | `cloudId`, `issueIdOrKey`, `fields`, `responseContentFormat` |
| `comment` | `addCommentToJiraIssue` | `cloudId`, `issueIdOrKey`, `commentBody`, `contentFormat` |
| `states` | `editJiraIssue` | `cloudId`, `issueIdOrKey`, `fields` |

## How it works

- **The queue** is a JQL search: the issues of `PROJ` with the label `factory`, with none of the four state labels, and not done. `{mark}` stands inside the JQL text five times in `list` and twice in `claimed`. That is allowed, because the mark holds no quote.
- **The states are labels**: `factory:in-progress`, `factory:needs-human`, `factory:done` and `factory:rejected`. The plugin reads the issue's labels, takes the old state label away, adds the new one, and writes the whole list with `editJiraIssue`. Your other labels stay. It never moves an issue in its workflow: a finished job only gets the label `factory:done`.
- **Claimed** is the issues with both `factory` and `factory:in-progress`.
- **The pull request is a comment.** The server has no tool for a remote link, so there is no `linkPr`. The plugin writes the pull request's address as a comment.
- **The address** of an issue is `https://<your-site>.atlassian.net/browse/<key>`, from the `url` key.
- **No `me`.** The fields of `atlassianUserInfo` are not known (see below). Without `me`, your own comments on an issue reach no agent.
- With these settings the pane shows seven lines to approve.

## What to check first

1. **The `cloudId`.** The example gives the site's address (`<your-site>.atlassian.net`). If the server refuses it, use the id of your site that the server gives.
2. **Whether a label takes a `:`.** If Jira refuses `factory:in-progress`, give other names with `names`, and use the same names in both JQL texts:

   ```json
   "states": {
     "labels": {
       "tool": "editJiraIssue",
       "args": { "cloudId": "<your-site>.atlassian.net", "issueIdOrKey": "{id}", "fields": { "labels": "{labels}" } },
       "names": { "in-progress": "factory-in-progress", "needs-human": "factory-needs-human", "done": "factory-done", "rejected": "factory-rejected" }
     }
   }
   ```

3. **The fields of `atlassianUserInfo`, for `me`.** It takes no argument. Ask Claude in the chat to call it, and find the field that holds your name as Jira shows it in an issue's reporter. Then add `"me": { "tool": "atlassianUserInfo", "args": {}, "name": "<that field>" }`. A display name can belong to two people. If the answer holds your account id, use it, and read the authors by their account id too (`fields.reporter.accountId`, `author.accountId`).
4. **That `/factory tracker` reads an issue.** Put the label `factory` on a test issue and run `/factory tracker` (it reads the first issue of the queue), or `/factory tracker PROJ-12` (its key). Look for `title found` and `text found`, the number of comments, and `carries the mark: yes`. `text not there` on an issue with a description means the description did not come as text: check `responseContentFormat`. `0 comments` on an issue with comments means the same for a comment's `body`.
5. **Many comments.** In Jira's REST shape, `fields.comment.comments` gives the oldest comment first, and the plugin reads the first 50 of the answer. On an issue with more than 50 comments the newest ones are lost, so an answer of the author there would not reach an agent. If that matters, read the comments with a separate `comments` call whose tool takes an order or a limit.
6. **The size of the queue.** The search answers as many issues as the server gives by default, and the plugin reads at most 200. The tool also takes `maxResults`.
