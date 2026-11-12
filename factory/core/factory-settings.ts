// The `factory` key of a repo's settings file: how the line runs. Every key is
// optional. One refused key refuses the whole `factory` object, so a line never
// runs with half of what its settings asked for.
import { CONTROL_CHAR, isInside, isObject, isText } from './rules'

export type Risk = 'low' | 'medium' | 'high'
export type Role = 'intake' | 'spec' | 'builder' | 'reviewer' | 'approver'
export type Tier = 'strongest' | 'strong' | 'fast'

export type FactorySettings = {
  slots: number
  maxRounds: number
  maxRisk: Risk
  costLimitUsd: { job: number; day: number }
  timeLimitMin: { job: number; day: number }
  minFreeDiskGb: number
  protectedPaths: string[]
  forbiddenCommands: string[][]
  forbiddenCommentWords: string[]
  models: Record<Role, Tier>
  reviewers: { low: string[]; medium: string[]; high: string[]; ui: string[]; security: string[] }
}

export const FACTORY_DEFAULTS: FactorySettings = {
  slots: 2,
  maxRounds: 3,
  maxRisk: 'low',
  costLimitUsd: { job: 10, day: 50 },
  timeLimitMin: { job: 60, day: 240 },
  minFreeDiskGb: 15,
  protectedPaths: ['.claude/factory.json'],
  forbiddenCommands: [],
  forbiddenCommentWords: [],
  models: { intake: 'strongest', spec: 'strong', builder: 'strong', reviewer: 'strong', approver: 'strong' },
  reviewers: { low: ['code'], medium: ['code'], high: ['code'], ui: ['ux', 'ui'], security: ['security'] },
}

export const RISKS: readonly Risk[] = ['low', 'medium', 'high']
const ROLES: readonly Role[] = ['intake', 'spec', 'builder', 'reviewer', 'approver']
const TIERS: readonly string[] = ['strongest', 'strong', 'fast']
const REVIEWERS: readonly string[] = ['code', 'ux', 'ui', 'security']
const ROUTES = ['low', 'medium', 'high', 'ui', 'security'] as const
const MAX_LIST = 50
const SETTINGS_FILE = '.claude/factory.json'
// A limit a person could never reach is no limit: these are the most a
// settings file may ask for.
const MOST = { costLimitUsd: { job: 1000, day: 10_000 }, timeLimitMin: { job: 1440, day: 10_080 } }

const WRONG = 'wrong type'
type Refused = { no: string }
const no = (reason: string): Refused => ({ no: reason })

const isWhole = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

// A list of non-empty strings of at most MAX_LIST entries, or why not.
function texts(v: unknown): string[] | Refused {
  if (!Array.isArray(v) || !v.every(isText)) return no(WRONG)

  return v.length > MAX_LIST ? no(`at most ${MAX_LIST}`) : v
}

// `{ job, day }`, each above zero, over the defaults.
function pair(
  v: unknown,
  defaults: { job: number; day: number },
  most: { job: number; day: number },
): { job: number; day: number } | Refused {
  if (!isObject(v)) return no(WRONG)
  const out = { ...defaults }
  for (const key of ['job', 'day'] as const) {
    if (v[key] === undefined) continue
    const amount = v[key]
    if (!isAmount(amount) || amount > most[key]) return no(WRONG)
    out[key] = amount
  }

  return out
}

export function parseFactory(v: unknown): { ok: FactorySettings } | Refused {
  if (!isObject(v)) return no(WRONG)
  const f: FactorySettings = {
    ...FACTORY_DEFAULTS,
    models: { ...FACTORY_DEFAULTS.models },
    reviewers: { ...FACTORY_DEFAULTS.reviewers },
  }

  if (v.slots !== undefined) {
    if (!isWhole(v.slots, 1, 8)) return no(WRONG)
    f.slots = v.slots
  }
  if (v.maxRounds !== undefined) {
    if (!isWhole(v.maxRounds, 1, 10)) return no(WRONG)
    f.maxRounds = v.maxRounds
  }
  if (v.maxRisk !== undefined) {
    if (!RISKS.includes(v.maxRisk as Risk)) return no(WRONG)
    f.maxRisk = v.maxRisk as Risk
  }
  if (v.minFreeDiskGb !== undefined) {
    if (typeof v.minFreeDiskGb !== 'number' || !(v.minFreeDiskGb >= 0)) return no(WRONG)
    f.minFreeDiskGb = v.minFreeDiskGb
  }
  for (const key of ['costLimitUsd', 'timeLimitMin'] as const) {
    if (v[key] === undefined) continue
    const parsed = pair(v[key], FACTORY_DEFAULTS[key], MOST[key])
    if ('no' in parsed) return parsed
    f[key] = parsed
  }

  if (v.protectedPaths !== undefined) {
    const paths = texts(v.protectedPaths)
    if ('no' in paths) return paths
    if (!paths.every(isInside)) return no('path must be inside the repo')
    // The settings file is always protected: a job must not be able to change
    // the rules it runs under.
    f.protectedPaths = [SETTINGS_FILE, ...paths.filter(path => path !== SETTINGS_FILE)]
  }
  if (v.forbiddenCommentWords !== undefined) {
    const words = texts(v.forbiddenCommentWords)
    if ('no' in words) return words
    f.forbiddenCommentWords = words
  }
  if (v.forbiddenCommands !== undefined) {
    if (!Array.isArray(v.forbiddenCommands)) return no(WRONG)
    if (v.forbiddenCommands.length > MAX_LIST) return no(`at most ${MAX_LIST}`)
    const commands: string[][] = []
    for (const argv of v.forbiddenCommands) {
      const words = texts(argv)
      if ('no' in words) return words
      if (words.length === 0) return no(WRONG)
      if (words.some(word => CONTROL_CHAR.test(word))) return no('control character in a command')
      commands.push(words)
    }
    f.forbiddenCommands = commands
  }

  if (v.models !== undefined) {
    if (!isObject(v.models)) return no(WRONG)
    for (const role of ROLES) {
      const tier = v.models[role]
      if (tier === undefined) continue
      if (!isText(tier) || !TIERS.includes(tier)) return no(WRONG)
      f.models[role] = tier as Tier
    }
  }
  if (v.reviewers !== undefined) {
    if (!isObject(v.reviewers)) return no(WRONG)
    for (const route of ROUTES) {
      if (v.reviewers[route] === undefined) continue
      const names = texts(v.reviewers[route])
      if ('no' in names) return names
      if (!names.every(name => REVIEWERS.includes(name))) return no('unknown reviewer')
      if (names.length === 0 && RISKS.includes(route as Risk)) return no('a risk needs a reviewer')
      f.reviewers[route] = [...new Set(names)]
    }
  }

  return { ok: f }
}
