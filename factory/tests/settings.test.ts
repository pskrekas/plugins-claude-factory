import { expect, test } from 'claude-code/testing'

import { DEFAULTS, GATE_MARK, commandsOf, lineOf, parseSettings } from '../core/settings'

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

test('progress gets checkbox marks by default', async () => {
  expect(parseSettings('{"progress": {"files": "docs/*/p.md"}}').settings.progress).toEqual({
    files: 'docs/*/p.md',
    done: '- [x]',
    open: '- [ ]',
    blocked: 'BLOCKED',
  })
  expect(
    parseSettings('{"progress": {"files": "a/*.md", "done": "DONE", "blocked": "STUCK"}}').settings
      .progress,
  ).toEqual({ files: 'a/*.md', done: 'DONE', open: '- [ ]', blocked: 'STUCK' })
  expect(parseSettings('{"progress": {"files": "a/*.md", "done": 5}}').error).toBe(
    'progress: wrong type',
  )
})

test('a ticket pattern that is not valid, or that can run for a very long time, is refused', async () => {
  const refused = { settings: DEFAULTS, error: 'ticketPattern: not a valid pattern' }
  expect(parseSettings('{"ticketPattern": "("}')).toEqual(refused)
  expect(parseSettings('{"ticketPattern": "(a+)+$"}')).toEqual(refused)
  expect(parseSettings('{"ticketPattern": "(ab)*c"}')).toEqual(refused)
  expect(parseSettings('{"ticketPattern": "(a|aa){2,}"}')).toEqual(refused)
  expect(parseSettings('{"ticketPattern": "(a)\\\\1"}')).toEqual(refused)
  expect(parseSettings(JSON.stringify({ ticketPattern: 'a'.repeat(101) }))).toEqual(refused)
  // Only a small subset is accepted: no alternation, no look-around, no lazy
  // repeat, and at most two repeats with no upper limit.
  // Every repeat counts, also `?` and {n,m}: at most three in a pattern.
  for (const pattern of ['a?a?a?a?aaaa', 'a{1,5}b{1,5}c{1,5}d{1,5}', 'a+b*c?d{2}']) {
    expect(parseSettings(JSON.stringify({ ticketPattern: pattern }))).toEqual(refused)
  }
  for (const pattern of ['a|b', '(?=a)b', '(?:a)b', 'a+?', '((a))', 'a**', '\\d*\\d*\\d*\\d*x', '\\p{L}+', '[[a]]']) {
    expect(parseSettings(JSON.stringify({ ticketPattern: pattern }))).toEqual(refused)
  }
  for (const pattern of ['PROJ-\\d+', '^([A-Z]+-\\d+)', 'issue-(\\d{1,6})$', 'feat/[a-z0-9_.]+-\\d+', 'a.c']) {
    expect(parseSettings(JSON.stringify({ ticketPattern: pattern })).error).toBe(null)
  }
  expect(parseSettings('{"ticketPattern": "PROJ-(\\\\d+)"}').settings.ticketPattern).toBe('PROJ-(\\d+)')
  expect(parseSettings('{"ticketPattern": "[A-Z]{2,5}-\\\\d+"}').error).toBe(null)
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

test('the commands to approve: the checks, then the gate commands with their mark', async () => {
  const text = JSON.stringify({
    checks: [
      { name: 'a', run: ['x', 'y'] },
      { name: 'd', minFreeGb: 5 },
    ],
    gate: { fast: [['npm', 'test']], full: [['npm', 'test'], ['npm', 'run', 'build']] },
  })
  const { settings } = parseSettings(text)
  // A gate command is on the list with a mark: approved for the gate, the
  // same words never run as a check, and the other way round.
  expect(commandsOf(settings)).toEqual(['x y', '[gate] npm run build', '[gate] npm test'])
})

test('a control character in a command is refused', async () => {
  const { settings, error } = parseSettings(
    '{"checks": [{"name": "a", "run": ["sh", "-c", "echo hi\\u001b[2J"]}]}',
  )
  expect(settings.checks).toEqual([])
  expect(error).toBe('checks: control character in a command')
  expect(parseSettings('{"gate": {"fast": [["a", "b\\nc"]]}}').error).toBe(
    'gate: control character in a command',
  )
})

test('two commands that differ only in how they are split never look the same', async () => {
  const a = parseSettings('{"checks": [{"name": "a", "run": ["rm", "x y"]}]}').settings
  const b = parseSettings('{"checks": [{"name": "a", "run": ["rm", "x", "y"]}]}').settings
  expect(commandsOf(a)).toEqual(['rm "x y"'])
  expect(commandsOf(b)).toEqual(['rm x y'])
})

test('an argument that only looks quoted is quoted again', async () => {
  const a = parseSettings('{"checks": [{"name": "a", "run": ["rm", "\\"x y\\""]}]}').settings
  expect(commandsOf(a)).toEqual(['rm "\\"x y\\""'])
})

test('an argument outside printable ASCII is shown with visible escapes', async () => {
  const a = parseSettings(
    '{"checks": [{"name": "a", "run": ["echo", "ab\\u202ecd\\u200b", "\\u00e9"]}]}',
  ).settings
  expect(commandsOf(a)).toEqual(['echo "ab\\u202ecd\\u200b" "\\u00e9"'])
  expect(/^[\x20-\x7e]*$/.test(commandsOf(a).join(''))).toBe(true)
})

test('a check must name a program on PATH, never a path', async () => {
  for (const program of ['./check.sh', 'scripts/check', '/usr/bin/env', '../x']) {
    const { settings, error } = parseSettings(JSON.stringify({ checks: [{ name: 'a', run: [program] }] }))
    expect(settings.checks).toEqual([])
    expect(error).toBe('checks: a check must name a program on PATH, not a path')
  }
  expect(parseSettings('{"checks": [{"name": "a", "run": ["git", "status"]}]}').error).toBe(null)
})

test('a base branch that could be read as an option is refused', async () => {
  for (const baseBranch of ['-D', '--exec=x', 'a b', 'x'.repeat(101), 'a\\b']) {
    expect(parseSettings(JSON.stringify({ baseBranch }))).toEqual({
      settings: DEFAULTS,
      error: 'baseBranch: not a branch name',
    })
  }
  expect(parseSettings('{"baseBranch": "release/1.2_x"}').settings.baseBranch).toBe('release/1.2_x')
})

test('a settings file cannot ask for more than 20 checks or 20 ports', async () => {
  const ports = Object.fromEntries(Array.from({ length: 21 }, (_, i) => ['p' + i, 3000 + i]))
  expect(parseSettings(JSON.stringify({ ports }))).toEqual({ settings: DEFAULTS, error: 'ports: at most 20' })
  const checks = Array.from({ length: 21 }, (_, i) => ({ name: 'd' + i, minFreeGb: 1 }))
  expect(parseSettings(JSON.stringify({ checks }))).toEqual({ settings: DEFAULTS, error: 'checks: at most 20' })
  expect(parseSettings(JSON.stringify({ checks: checks.slice(0, 20) })).error).toBe(null)
})

test('a progress path is at most 200 characters', async () => {
  expect(parseSettings(JSON.stringify({ progress: { files: 'a/'.repeat(101) + '*.md' } })).error).toBe(
    'progress: wrong type',
  )
})

test('no command line can look like a marked gate command', async () => {
  // The mark starts with a character a plain argument cannot hold, and a
  // quoted argument starts with a double quote: no line of a check starts with it.
  expect(GATE_MARK).toBe('[gate] ')
  for (const first of ['gate:', '[gate]', '[gate', 'gate', '"[gate]"', ' [gate]', '[gate] npm test']) {
    const line = lineOf([first, 'npm', 'test'])
    expect(line.startsWith(GATE_MARK)).toBe(false)
    expect(line.startsWith('[')).toBe(false)
  }
  const tricky = parseSettings(
    JSON.stringify({ checks: [{ name: 'a', run: ['[gate]', 'npm', 'test'] }, { name: 'b', run: ['gate:', 'npm', 'test'] }], gate: { fast: [['npm', 'test']] } }),
  ).settings
  const lines = commandsOf(tricky)
  expect(lines.filter(line => line === '[gate] npm test').length).toBe(1)
  expect(new Set(lines).size).toBe(lines.length)
  expect(lines.length).toBe(3)
})
