import { expect, test } from 'claude-code/testing'

import { FACTORY_DEFAULTS } from '../core/factory-settings'
import { DEFAULTS, parseSettings } from '../core/settings'

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
