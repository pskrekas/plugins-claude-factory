import { expect, test } from 'claude-code/testing'

import { FACTORY_DEFAULTS } from '../core/factory-settings'
import { parseJob } from '../core/job'
import type { Job } from '../core/job'
import { factoryRows } from '../core/line'
import { viewOf } from '../hooks/readers/factory'
import { START, STATE, cmd, engine } from './kit'

// The same objects as docs/examples/factory-jobs/<folder>/job.json. A test has
// no file system, so they are kept here too.
const EXAMPLES: Record<string, unknown> = {
  "12-add-dark-mode": {"id": "12-add-dark-mode", "itemId": "12", "title": "Add dark mode", "stage": "build", "round": 2, "risk": "low", "surfaces": ["ui"], "reviewers": ["code", "ux", "ui"], "stoppedIn": null, "question": null, "sentBack": {"by": "gate", "why": "2 tests failed"}, "pr": {"number": 21, "url": "https://example.com/pull/21"}, "createdAt": 1794490000000, "updatedAt": 1794490840000, "agentMs": 840000, "costUsd": 3.4, "history": [{"at": 1794490000000, "from": null, "to": "intake", "reason": "started"}, {"at": 1794490060000, "from": "intake", "to": "spec", "reason": "accepted, risk low"}, {"at": 1794490180000, "from": "spec", "to": "build", "reason": "spec written"}, {"at": 1794490600000, "from": "build", "to": "gate", "reason": "built"}, {"at": 1794490840000, "from": "gate", "to": "build", "reason": "gate failed"}]},
  "14-different-fonts": {"id": "14-different-fonts", "itemId": "14", "title": "Different fonts", "stage": "needs-info", "round": 1, "risk": null, "surfaces": [], "reviewers": [], "stoppedIn": "intake", "question": "Which font is the default?", "sentBack": null, "pr": null, "createdAt": 1794490000000, "updatedAt": 1794490090000, "agentMs": 90000, "costUsd": 0.2, "history": [{"at": 1794490000000, "from": null, "to": "intake", "reason": "started"}, {"at": 1794490090000, "from": "intake", "to": "needs-info", "reason": "a question for the author"}]},
  "10-multiple-walls": {"id": "10-multiple-walls", "itemId": "10", "title": "Multiple walls", "stage": "ready", "round": 1, "risk": "low", "surfaces": [], "reviewers": ["code"], "stoppedIn": null, "question": null, "sentBack": null, "pr": {"number": 19, "url": "https://example.com/pull/19"}, "createdAt": 1794490000000, "updatedAt": 1794490540000, "agentMs": 540000, "costUsd": 2.1, "history": [{"at": 1794490000000, "from": null, "to": "intake", "reason": "started"}, {"at": 1794490060000, "from": "intake", "to": "spec", "reason": "accepted, risk low"}, {"at": 1794490150000, "from": "spec", "to": "build", "reason": "spec written"}, {"at": 1794490400000, "from": "build", "to": "gate", "reason": "built"}, {"at": 1794490430000, "from": "gate", "to": "review", "reason": "checks passed"}, {"at": 1794490500000, "from": "review", "to": "approve", "reason": "reviewers passed"}, {"at": 1794490540000, "from": "approve", "to": "ready", "reason": "full checks passed"}]},
}

test('the example jobs are job files the plugin accepts', async () => {
  const jobs = Object.entries(EXAMPLES).map(([folder, example]) => parseJob(JSON.stringify(example), folder))
  expect(jobs.every(job => job !== null)).toBe(true)
  expect(jobs.map(job => job?.stage)).toEqual(['build', 'needs-info', 'ready'])

  const view = viewOf(jobs as Job[], FACTORY_DEFAULTS, null, null, 1794490000000)
  const rows = factoryRows(view!, 80).map(row => row.left)
  expect(rows).toContain('NEEDS YOU (2)')
  expect(rows).toContain('14  Which font is the default?')
  expect(rows).toContain('10  PR 19 is ready. You merge.')
  expect(rows).toContain('↺ round 2 of 3 · gate sent it back: 2 tests failed · 14 m · $3.40')
})

test('/factory where says where the state of this repo is kept', async ($, on) => {
  const world = engine(on, { files: {} })
  await $.session.start(START)

  expect((await $.command.run(cmd('where'))).text).toBe(
    'The factory keeps its state for this repository in:\n' + STATE,
  )
  expect(world.writes).toEqual([])
})
