// The `factory` key of a repo's settings file: how the line runs. Every key is
// optional. One refused key refuses the whole `factory` object, so a line never
// runs with half of what its settings asked for.
import { CONTROL_CHAR, isInside, isObject, isText } from './rules'

export type Risk = 'low' | 'medium' | 'high'
export type Role = 'intake' | 'spec' | 'builder' | 'reviewer' | 'approver'
export type Tier = 'strongest' | 'strong' | 'fast'
// Where the builder's commands and the gate's commands run: in a container
// of this image, which sees only the job's folder (design 8.3).
export type ContainerSpec = { image: string; network: 'on' | 'none'; memory: string; cpus: number }
// US dollars per million tokens of one model.
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

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
  // For each role: a tier (`strongest`, `strong`, `fast`), or the model itself (an alias, a full id, `inherit`).
  models: Record<Role, string>
  // The price table for the cost estimate, by model id. Empty: cost unknown.
  prices: Record<string, Price>
  // How long one agent may work at a station before the station counts as failed.
  stationTimeoutMin: number
  // The container; `false`: the person chose that commands run on this machine;
  // null: not set, and then the line does not run.
  container: ContainerSpec | false | null
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
  prices: {},
  stationTimeoutMin: 30,
  container: null,
  models: { intake: 'strongest', spec: 'strong', builder: 'strong', reviewer: 'strong', approver: 'strong' },
  reviewers: { low: ['code'], medium: ['code'], high: ['code'], ui: ['ux', 'ui'], security: ['security'] },
}

export const RISKS: readonly Risk[] = ['low', 'medium', 'high']
export const ROLES: readonly Role[] = ['intake', 'spec', 'builder', 'reviewer', 'approver']
const TIERS: readonly string[] = ['strongest', 'strong', 'fast']
// A role's model by name: an alias the engine knows, `inherit` (the session's
// own model), or a full model id. Anything else is a mistyped tier, and is refused.
const MODEL_ALIASES: readonly string[] = ['opus', 'sonnet', 'haiku', 'inherit']
const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{0,47}$/
const isModelChoice = (v: string): boolean => TIERS.includes(v) || MODEL_ALIASES.includes(v) || MODEL_ID.test(v)
const REVIEWERS: readonly string[] = ['code', 'ux', 'ui', 'security']
const ROUTES = ['low', 'medium', 'high', 'ui', 'security'] as const
const MAX_LIST = 50
const MAX_PRICES = 20
const MOST_PRICE = 1000
const PRICE_PARTS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
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

// An image name is an argument of `docker`: it can never be read as an option.
export const isImage = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/.test(v)
const isMemory = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,5}[mg]$/.test(v)

function containerOf(v: unknown): ContainerSpec | Refused {
  if (!isObject(v) || !isImage(v.image)) return no('container: an image is needed')
  const network = v.network ?? 'on'
  const memory = v.memory ?? '4g'
  const cpus = v.cpus ?? 2
  if (network !== 'on' && network !== 'none') return no('container: network is on or none')
  if (!isMemory(memory)) return no('container: memory is a number and m or g')
  if (typeof cpus !== 'number' || !(cpus >= 0.5 && cpus <= 16)) return no('container: cpus is 0.5 to 16')

  return { image: v.image, network, memory, cpus }
}

// The container as the line a person approves, or null when none is set.
// Another image, network or limit is another line, so it asks again.
export function containerLine(container: ContainerSpec | false | null): string | null {
  if (container === null) return null
  if (container === false) return '[container] none: the builder and the gate run on this machine'

  return `[container] ${container.image} · network ${container.network} · memory ${container.memory} · cpus ${container.cpus}`
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

  if (v.stationTimeoutMin !== undefined) {
    if (!isWhole(v.stationTimeoutMin, 5, 240)) return no(WRONG)
    f.stationTimeoutMin = v.stationTimeoutMin
  }
  if (v.prices !== undefined) {
    if (!isObject(v.prices)) return no(WRONG)
    const models = Object.keys(v.prices)
    if (models.length > MAX_PRICES) return no(`at most ${MAX_PRICES} prices`)
    const prices: Record<string, Price> = {}
    for (const model of models) {
      const given = v.prices[model]
      if (!/^[\x21-\x7e]{1,80}$/.test(model) || !isObject(given)) return no(WRONG)
      const parts = PRICE_PARTS.map(part => given[part])
      if (!parts.every(part => typeof part === 'number' && Number.isFinite(part) && part >= 0 && part <= MOST_PRICE)) {
        return no(WRONG)
      }
      const [input = 0, output = 0, cacheRead = 0, cacheWrite = 0] = parts as number[]
      prices[model] = { input, output, cacheRead, cacheWrite }
    }
    f.prices = prices
  }

  if (v.container !== undefined) {
    const container = v.container === false ? false : containerOf(v.container)
    if (container !== false && 'no' in container) return container
    f.container = container
  }

  if (v.models !== undefined) {
    if (!isObject(v.models)) return no(WRONG)
    for (const role of ROLES) {
      const tier = v.models[role]
      if (tier === undefined) continue
      if (!isText(tier) || !isModelChoice(tier)) return no(WRONG)
      f.models[role] = tier
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
