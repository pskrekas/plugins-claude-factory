import { expect, test } from 'claude-code/testing'

import { DEFAULTS, commandsOf, hashOf, parseSettings } from '../core/settings'

test('no file gives the defaults', async () => {
  expect(parseSettings(null)).toEqual({ settings: DEFAULTS, error: null })
})

test('broken JSON gives the defaults and says why', async () => {
  expect(parseSettings('{ nope')).toEqual({ settings: DEFAULTS, error: 'not valid JSON' })
})

test('a file that is not an object gives the defaults and says why', async () => {
  expect(parseSettings('[1, 2]')).toEqual({ settings: DEFAULTS, error: 'not a JSON object' })
})

test('a wrong type falls back for that key only', async () => {
  const { settings, error } = parseSettings('{"ports": "x", "baseBranch": "dev"}')
  expect(settings.ports).toEqual([])
  expect(settings.baseBranch).toBe('dev')
  expect(error).toBe('ports: wrong type')
})

test('unknown and phase 2 keys are ignored', async () => {
  expect(parseSettings('{"factory": {"slots": 2}, "zzz": 1}').error).toBe(null)
})

test('progress gets checkbox patterns by default', async () => {
  expect(parseSettings('{"progress": {"files": "docs/*/p.md"}}').settings.progress).toEqual({
    files: 'docs/*/p.md',
    done: '^- \\[x\\]',
    open: '^- \\[ \\]',
    blocked: 'BLOCKED',
  })
})

test('a bad pattern is refused', async () => {
  expect(parseSettings('{"ticketPattern": "("}')).toEqual({
    settings: DEFAULTS,
    error: 'ticketPattern: not a valid pattern',
  })
  expect(parseSettings('{"progress": {"files": "a/*.md", "done": "("}}').error).toBe(
    'progress: not a valid pattern',
  )
})

test('ports map becomes a list', async () => {
  expect(parseSettings('{"ports": {"database": 5432}}').settings.ports).toEqual([
    { name: 'database', port: 5432 },
  ])
})

test('the tracker gets its mark and project defaults', async () => {
  expect(parseSettings('{"tracker": {"kind": "github"}}').settings.tracker).toEqual({
    kind: 'github',
    mark: 'factory',
    project: null,
  })
  expect(parseSettings('{"tracker": {"kind": "nope"}}')).toEqual({
    settings: DEFAULTS,
    error: 'tracker: wrong type',
  })
})

test('a check must have a name and a command of strings', async () => {
  const { settings, error } = parseSettings(
    '{"checks": [{"name": "a", "run": ["x", 1]}, {"name": "disk", "minFreeGb": 5}]}',
  )
  expect(settings.checks).toEqual([])
  expect(error).toBe('checks: wrong type')
})

test('commands are listed once, sorted, and hashed stably', async () => {
  const text = JSON.stringify({
    checks: [
      { name: 'a', run: ['x', 'y'] },
      { name: 'd', minFreeGb: 5 },
    ],
    gate: { fast: [['npm', 'test']], full: [['npm', 'test'], ['npm', 'run', 'build']] },
  })
  const { settings } = parseSettings(text)
  expect(commandsOf(settings)).toEqual(['npm run build', 'npm test', 'x y'])
  expect(hashOf(commandsOf(settings))).toBe(hashOf(['npm run build', 'npm test', 'x y']))
  expect(hashOf(['a'])).not.toBe(hashOf(['b']))
  expect(hashOf(['a'])).toMatch(/^[0-9a-f]{8}$/)
})
