import { expect, test } from 'claude-code/testing'

import { itemOf, labelsAfter, listedOf, mcpLines, parseMcpTracker } from '../core/mcp-tracker'
import type { McpTracker } from '../core/mcp-tracker'
import { commandsOf, parseSettings } from '../core/settings'

import { GOOD } from './mcp-good'

// The settings files of docs/trackers/mcp.md and docs/trackers/jira.md, copied
// from the pages character for character. A test has no file system, so they
// are kept here too: a change to a page's JSON is a change here.
const REFERENCE_PAGE = String.raw`{
  "tracker": {
    "kind": "mcp",
    "mark": "factory",
    "server": "tasks",
    "url": "https://tracker.example.com/tasks/{id}",
    "list": {
      "tool": "find_tasks",
      "args": { "label": "{mark}", "states": ["open"] },
      "rows": "tasks", "id": "id", "title": "title", "state": "state"
    },
    "claimed": {
      "tool": "find_tasks",
      "args": { "label": "{mark}", "states": ["started"] },
      "rows": "tasks", "id": "id", "title": "title", "state": "state"
    },
    "read": {
      "tool": "show_task",
      "args": { "task_id": "{id}" },
      "title": "title", "text": "description", "author": "made_by",
      "state": "state", "labels": "labels",
      "comments": "comments", "commentAuthor": "by", "commentText": "text"
    },
    "comment": { "tool": "add_comment", "args": { "task_id": "{id}", "text": "{text}" } },
    "states": {
      "in-progress": [{ "tool": "move_task", "args": { "task_id": "{id}", "to": "started" } }],
      "needs-human": [{ "tool": "move_task", "args": { "task_id": "{id}", "to": "waiting" }, "optional": true }],
      "done": [{ "tool": "move_task", "args": { "task_id": "{id}", "to": "closed" } }],
      "rejected": [{ "tool": "cancel_task", "args": { "task_id": "{id}" } }]
    },
    "linkPr": { "tool": "attach_link", "args": { "task_id": "{id}", "ref": "{url}" } },
    "me": { "tool": "who_am_i", "args": {}, "name": "name" }
  }
}`

const JIRA_PAGE = String.raw`{
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
}`

const trackerOf = (page: string): McpTracker => {
  const parsed = parseMcpTracker(JSON.parse(page).tracker)
  if (!('ok' in parsed)) throw new Error(parsed.no)

  return parsed.ok
}

test("the reference page's example is a settings file the plugin accepts, and its lines are the page's", async () => {
  const { settings, error } = parseSettings(REFERENCE_PAGE)
  expect(error).toBe(null)
  expect(settings.tracker?.kind).toBe('mcp')
  expect(JSON.parse(REFERENCE_PAGE).tracker).toEqual(GOOD)
  const lines = mcpLines(trackerOf(REFERENCE_PAGE), 'factory')
  // The twelve lines the page shows, in the pane's order.
  expect(lines).toEqual([
    '[tracker] mcp tasks · list: find_tasks {"label":"{mark}","states":["open"]} → rows=tasks id=id title=title state=state',
    '[tracker] mcp tasks · claimed: find_tasks {"label":"{mark}","states":["started"]} → rows=tasks id=id title=title state=state',
    '[tracker] mcp tasks · read: show_task {"task_id":"{id}"} → title=title text=description author=made_by state=state labels=labels comments=comments commentAuthor=by commentText=text',
    '[tracker] mcp tasks · comment: add_comment {"task_id":"{id}","text":"{text}"}',
    '[tracker] mcp tasks · state in-progress 1/1: move_task {"task_id":"{id}","to":"started"}',
    '[tracker] mcp tasks · state needs-human 1/1 (optional): move_task {"task_id":"{id}","to":"waiting"}',
    '[tracker] mcp tasks · state done 1/1: move_task {"task_id":"{id}","to":"closed"}',
    '[tracker] mcp tasks · state rejected 1/1: cancel_task {"task_id":"{id}"}',
    '[tracker] mcp tasks · linkPr: attach_link {"ref":"{url}","task_id":"{id}"}',
    '[tracker] mcp tasks · me: who_am_i {} → name=name',
    '[tracker] mcp tasks · url: https://tracker.example.com/tasks/{id}',
    '[tracker] mcp tasks · mark: factory',
  ])
  expect(lines.every(line => commandsOf(settings).includes(line))).toBe(true)
})

test("the Jira page's example is a settings file the plugin accepts, with seven lines", async () => {
  const { settings, error } = parseSettings(JIRA_PAGE)
  expect(error).toBe(null)
  const jira = trackerOf(JIRA_PAGE)
  expect([jira.server, jira.states.as, jira.linkPr, jira.me]).toEqual(['atlassian', 'labels', null, null])
  const lines = mcpLines(jira, 'factory')
  expect(lines.length).toBe(7)
  expect(lines.every(line => commandsOf(settings).includes(line))).toBe(true)
  expect(lines).toContain('[tracker] mcp atlassian · states as labels: editJiraIssue {"cloudId":"<your-site>.atlassian.net","fields":{"labels":"{labels}"},"issueIdOrKey":"{id}"}')
  expect(lines.at(-1)).toBe('[tracker] mcp atlassian · mark: factory')
})

test("the Jira mapping reads answers in Jira's REST shapes (not seen from the server: the page says so)", async () => {
  const jira = trackerOf(JIRA_PAGE)
  const search = { issues: [{ key: 'PROJ-12', fields: { summary: 'Add dark mode', status: { name: 'To Do' } } }, { key: 'PROJ-13', fields: { status: { name: 'To Do' } } }] }
  expect(listedOf(search, jira.list)).toEqual([{ id: 'PROJ-12', title: 'Add dark mode', state: 'to do' }])
  const issue = {
    key: 'PROJ-12',
    fields: {
      summary: 'Add dark mode',
      description: 'A switch in the settings.',
      status: { name: 'To Do' },
      reporter: { displayName: 'Ann Lee' },
      labels: ['factory', 'ui'],
      comment: { comments: [{ author: { displayName: 'Ann Lee' }, body: 'Dark grey, not black.' }] },
    },
  }
  const read = itemOf(issue, jira.read, 'PROJ-12', jira.url)
  expect(read?.item).toEqual({
    id: 'PROJ-12',
    title: 'Add dark mode',
    state: 'to do',
    text: 'A switch in the settings.',
    author: 'ann lee',
    url: 'https://<your-site>.atlassian.net/browse/PROJ-12',
    comments: [{ author: 'ann lee', text: 'Dark grey, not black.' }],
  })
  expect(labelsAfter(read?.labels ?? [], 'factory', 'in-progress', null)).toEqual(['factory', 'ui', 'factory:in-progress'])
})
