import { expect, test } from 'claude-code/testing'

import { FACTORY_DEFAULTS, containerLine } from '../core/factory-settings'
import { GOOD } from './mcp-good'
import { DEFAULTS, commandsOf, parseSettings, trackerLine } from '../core/settings'

test('no factory key gives the defaults', async () => {
  expect(parseSettings('{}').settings.factory).toEqual(FACTORY_DEFAULTS)
  expect(DEFAULTS.factory).toEqual(FACTORY_DEFAULTS)
  expect(FACTORY_DEFAULTS.slots).toBe(2)
  expect(FACTORY_DEFAULTS.maxRounds).toBe(3)
  expect(FACTORY_DEFAULTS.maxRisk).toBe('low')
  expect(FACTORY_DEFAULTS.costLimitUsd).toEqual({ job: 10, day: 50 })
  expect(FACTORY_DEFAULTS.timeLimitMin).toEqual({ job: 60, day: 240 })
  expect(FACTORY_DEFAULTS.minFreeDiskGb).toBe(15)
  expect(FACTORY_DEFAULTS.protectedPaths).toEqual(['.claude/factory.json'])
  expect(FACTORY_DEFAULTS.reviewers).toEqual({
    low: ['code'],
    medium: ['code'],
    high: ['code'],
    ui: ['ux', 'ui'],
    security: ['security'],
  })
  expect(FACTORY_DEFAULTS.models).toEqual({
    intake: 'strongest',
    spec: 'strong',
    builder: 'strong',
    reviewer: 'strong',
    approver: 'strong',
  })
})

test('given keys replace their defaults, the rest stay', async () => {
  const { settings, error } = parseSettings(
    '{"factory": {"slots": 4, "maxRisk": "high", "costLimitUsd": {"job": 5}, "models": {"reviewer": "fast"}, "stations": {"spec": "x.md"}}}',
  )
  expect(error).toBe(null)
  expect(settings.factory.slots).toBe(4)
  expect(settings.factory.maxRisk).toBe('high')
  expect(settings.factory.costLimitUsd).toEqual({ job: 5, day: 50 })
  expect(settings.factory.models.reviewer).toBe('fast')
  expect(settings.factory.models.intake).toBe('strongest')
  // A role takes a tier, a model alias, a full model id, or `inherit` (the session's model).
  const named = parseSettings('{"factory": {"models": {"intake": "claude-example-1-2", "builder": "opus", "spec": "inherit", "approver": "fast"}}}')
  expect(named.error).toBe(null)
  expect(named.settings.factory.models).toEqual({ intake: 'claude-example-1-2', spec: 'inherit', builder: 'opus', reviewer: 'strong', approver: 'fast' })
  expect(settings.factory.maxRounds).toBe(3)
})

test('a value out of range refuses the whole factory key', async () => {
  const cases = [
    { slots: 0 },
    { slots: 9 },
    { slots: 1.5 },
    { maxRounds: 11 },
    { maxRisk: 'huge' },
    { costLimitUsd: { job: 0 } },
    { timeLimitMin: { day: -3 } },
    { minFreeDiskGb: -1 },
    { models: { builder: 'best' } },
    { models: { builder: 'Opus' } },
    { models: { builder: 'claude-' } },
    { models: { builder: 'claude-x y' } },
    { models: { builder: 'claude-' + 'a'.repeat(60) } },
    { models: { builder: 7 } },
    5,
    [],
  ]
  for (const factory of cases) {
    expect(parseSettings(JSON.stringify({ factory }))).toEqual({
      settings: DEFAULTS,
      error: 'factory: wrong type',
    })
  }
})

test('lists are checked', async () => {
  const err = (factory: object) => parseSettings(JSON.stringify({ factory })).error
  expect(err({ protectedPaths: ['../x'] })).toBe('factory: path must be inside the repo')
  expect(err({ forbiddenCommands: [['rm', 'a\nb']] })).toBe('factory: control character in a command')
  expect(err({ forbiddenCommands: [[]] })).toBe('factory: wrong type')
  expect(err({ reviewers: { low: ['nobody'] } })).toBe('factory: unknown reviewer')
  expect(err({ forbiddenCommentWords: Array.from({ length: 51 }, () => 'x') })).toBe('factory: at most 50')
  expect(err({ forbiddenCommands: [['terraform', 'apply']], reviewers: { ui: ['ux'] } })).toBe(null)
  // A risk always gets a reviewer; a surface may add none.
  expect(err({ reviewers: { low: [] } })).toBe('factory: a risk needs a reviewer')
  expect(err({ reviewers: { ui: [] } })).toBe(null)
  // A limit a person could never reach is no limit.
  expect(err({ costLimitUsd: { job: 1e300 } })).toBe('factory: wrong type')
  expect(err({ costLimitUsd: { job: 1000, day: 10000 } })).toBe(null)
  expect(err({ timeLimitMin: { job: 100000 } })).toBe('factory: wrong type')
})

test('a refused factory key leaves the other keys as they are', async () => {
  const { settings, error } = parseSettings('{"baseBranch": "dev", "factory": {"slots": 0}}')
  expect(error).toBe('factory: wrong type')
  expect(settings.baseBranch).toBe('dev')
  expect(settings.factory).toEqual(FACTORY_DEFAULTS)
})

test('the settings file itself is always a protected path', async () => {
  const paths = (protectedPaths: string[]) =>
    parseSettings(JSON.stringify({ factory: { protectedPaths } })).settings.factory.protectedPaths
  expect(paths([])).toEqual(['.claude/factory.json'])
  expect(paths(['tests/known.txt'])).toEqual(['.claude/factory.json', 'tests/known.txt'])
  expect(paths(['.claude/factory.json', 'x'])).toEqual(['.claude/factory.json', 'x'])
})

test('prices per model and the time one station may take', async () => {
  expect([FACTORY_DEFAULTS.prices, FACTORY_DEFAULTS.stationTimeoutMin]).toEqual([{}, 30])
  const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
  const ok = parseSettings(JSON.stringify({ factory: { prices: { 'model-a': price }, stationTimeoutMin: 45 } }))
  expect([ok.error, ok.settings.factory.prices, ok.settings.factory.stationTimeoutMin]).toEqual([null, { 'model-a': price }, 45])
  const bad = [
    { prices: { m: { ...price, input: -1 } } },
    { prices: { m: { ...price, output: 1001 } } },
    { prices: { m: { input: 3 } } },
    { prices: { 'a\u0007b': price } },
    { prices: { ['m'.repeat(81)]: price } },
    { prices: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m${i}`, price])) },
    { prices: [price] },
    { stationTimeoutMin: 4 },
    { stationTimeoutMin: 241 },
    { stationTimeoutMin: 7.5 },
  ]
  for (const factory of bad) {
    const { settings, error } = parseSettings(JSON.stringify({ factory }))
    expect(error).not.toBe(null)
    expect(settings.factory).toEqual(FACTORY_DEFAULTS)
  }
})

test('the container: an image and its limits, or an explicit "on this machine"', async () => {
  expect(FACTORY_DEFAULTS.container).toBe(null)
  const container = (value: unknown) => parseSettings(JSON.stringify({ factory: { container: value } }))
  expect([container({ image: 'node:22' }).error, container({ image: 'node:22' }).settings.factory.container]).toEqual([null, { image: 'node:22', network: 'on', memory: '4g', cpus: 2 }])
  const full = { image: 'ghcr.io/acme/build@sha256:abc123', network: 'none', memory: '512m', cpus: 0.5 }
  expect(container(full).settings.factory.container).toEqual(full)
  expect([container(false).error, container(false).settings.factory.container]).toEqual([null, false])

  const bad = [{ image: '--privileged' }, { image: 'a b' }, { image: '' }, { image: '.hidden' }, { image: 'x'.repeat(201) }, {}, 'node:22', true,
    { image: 'node:22', network: 'host' }, { image: 'node:22', memory: 'lots' }, { image: 'node:22', memory: '4g; rm' }, { image: 'node:22', cpus: 0 }, { image: 'node:22', cpus: 99 }]
  for (const value of bad) {
    const { settings, error } = container(value)
    expect([JSON.stringify(value), error === null, settings.factory.container]).toEqual([JSON.stringify(value), false, null])
  }
})

test('the container is approved as its own line, also the choice to run on this machine', async () => {
  expect(containerLine(null)).toBe(null)
  expect(containerLine({ image: 'node:22', network: 'on', memory: '4g', cpus: 2 })).toBe('[container] node:22 · network on · memory 4g · cpus 2')
  expect(containerLine(false)).toBe('[container] none: the builder and the gate run on this machine')
  const settings = (factory: object) => parseSettings(JSON.stringify({ gate: { fast: [['npm', 'test']] }, checks: [{ name: 'a', run: ['x', 'y'] }], factory })).settings
  expect(commandsOf(settings({ container: { image: 'node:22', network: 'none' } }))).toEqual(['x y', '[gate] npm test', '[container] node:22 · network none · memory 4g · cpus 2'])
  expect(commandsOf(settings({ container: false })).at(-1)).toBe('[container] none: the builder and the gate run on this machine')
  expect(commandsOf(settings({}))).toEqual(['x y', '[gate] npm test'])
  // Another image, or the network turned on, is another line: it asks again.
  expect(commandsOf(settings({ container: { image: 'node:23' } })).at(-1)).toBe('[container] node:23 · network on · memory 4g · cpus 2')
})

test('a tracker place that the settings name, and not the remote, is a line to approve', async () => {
  const tracker = (kind: 'github' | 'azure-boards', project: string | null) => ({ kind, mark: 'factory', project, mcp: null })
  expect(trackerLine(tracker('azure-boards', 'acme/Shop'))).toBe('[tracker] azure-boards acme/Shop')
  expect(trackerLine(tracker('github', 'a/b'))).toBe('[tracker] github a/b')
  // A project of the remote's own organization, or no project, is the remote's place: nothing to approve.
  expect([trackerLine(tracker('azure-boards', 'Shop')), trackerLine(tracker('azure-boards', null)), trackerLine(tracker('github', null)), trackerLine(null)]).toEqual([null, null, null, null])
  // Text that could hide in a line is not shown as one.
  expect(trackerLine(tracker('azure-boards', 'acme/Shop\n[gate] rm -rf /'))).toBe(null)
  const { settings } = parseSettings('{"tracker": {"kind": "azure-boards", "project": "acme/Shop"}, "gate": {"fast": [["npm", "test"]]}}')
  expect(commandsOf(settings)).toEqual(['[gate] npm test', '[tracker] azure-boards acme/Shop'])
})

test('an mcp tracker: its calls are lines to approve, after the gate lines', async () => {
  const { settings, error } = parseSettings(JSON.stringify({ tracker: GOOD, gate: { fast: [['npm', 'test']] } }))
  expect(error).toBe(null)
  expect(settings.tracker?.kind).toBe('mcp')
  expect(settings.tracker?.mcp?.server).toBe('tasks')
  const lines = commandsOf(settings)
  expect(lines[0]).toBe('[gate] npm test')
  expect(lines.length).toBe(13)
  expect(lines.slice(1).every(line => line.startsWith('[tracker] mcp tasks · '))).toBe(true)
  expect(lines).toContain('[tracker] mcp tasks · mark: factory')
  expect(trackerLine(settings.tracker)).toBe(null)
  const marked = parseSettings(JSON.stringify({ tracker: { ...GOOD, mark: 'factory OR x' } })).settings
  expect(commandsOf(marked)).not.toEqual(commandsOf(parseSettings(JSON.stringify({ tracker: GOOD })).settings))

  const bad = parseSettings(JSON.stringify({ tracker: { ...GOOD, server: 'factory' } }))
  expect(bad.settings.tracker).toBe(null)
  expect(bad.error).toBe('tracker: server: is the plugin itself')
  expect(parseSettings('{"tracker": {"kind": "github"}}').settings.tracker?.mcp).toBe(null)
})

test('a tracker kind that names one product is sent to kind mcp', async () => {
  for (const kind of ['jira', 'asana']) {
    const { settings, error } = parseSettings(JSON.stringify({ tracker: { kind } }))
    expect(settings.tracker).toBe(null)
    expect(error).toBe('tracker: use kind mcp: see docs/trackers')
  }
})
