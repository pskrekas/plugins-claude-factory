// The inbox: small fact files that a hook drops and the code that advances
// the jobs reads. A hook must answer fast and must not wait for another hook,
// so it writes what it learned (an agent's turn ended, a command was refused)
// and returns. The folder is the plugin's own: no agent writes there.
import type { Usage } from '../core/price'
import type { Io } from './io'
import { stateDirOf } from './jobs'
import { readInside, writeInside } from './readers/files'

export type Fact =
  | { kind: 'turn'; agentId: string; answer: string; ms: number; usage: Usage | null; reason: string; at: number }
  | { kind: 'refusal'; agentId: string; command: string; at: number }

const MAX_FACTS = 200
const MAX_FACT_CHARS = 20_000
const MAX_ANSWER = 2_000
const MAX_COMMAND = 200
const MAX_ID = 100
let count = 0

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_ID

function usageOf(v: unknown): Usage | null | undefined {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object') return undefined
  const u = v as Record<string, unknown>
  const counts = [u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]
  if (typeof u.model !== 'string' || !counts.every(isCount)) return undefined
  const [input_tokens = 0, output_tokens = 0, cache_read_input_tokens = 0, cache_creation_input_tokens = 0] = counts as number[]

  return { model: u.model.slice(0, MAX_ID), input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
}

// A fact as it reads back from a file, or null when the text is not one.
function parseFact(text: string | null): Fact | null {
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const f = raw as Record<string, unknown>
  if (!isId(f.agentId) || !isCount(f.at)) return null
  if (f.kind === 'refusal') {
    return typeof f.command === 'string' ? { kind: 'refusal', agentId: f.agentId, command: f.command.slice(0, MAX_COMMAND), at: f.at } : null
  }
  if (f.kind !== 'turn' || typeof f.answer !== 'string' || !isCount(f.ms) || typeof f.reason !== 'string') return null
  const usage = usageOf(f.usage)
  if (usage === undefined) return null

  return { kind: 'turn', agentId: f.agentId, answer: f.answer.slice(0, MAX_ANSWER), ms: f.ms, usage, reason: f.reason.slice(0, 40), at: f.at }
}

// Writes one fact. The name starts with its time, so the folder sorts oldest first.
export async function dropFact(io: Io, root: string, fact: Fact): Promise<void> {
  const dir = await stateDirOf(io, root)
  if (dir === null) return
  const cut: Fact =
    fact.kind === 'turn'
      ? { ...fact, answer: fact.answer.slice(0, MAX_ANSWER) }
      : { ...fact, command: fact.command.slice(0, MAX_COMMAND) }
  count += 1
  const name = `${String(Math.floor(Math.max(0, fact.at))).padStart(15, '0')}-${count.toString(36)}${Math.random().toString(36).slice(2, 8)}.json`
  await writeInside(io, dir, `inbox/${name}`, JSON.stringify(cut))
}

// Reads the facts, oldest first, at most 200 at one time, and removes each
// file it looked at. A file that is not a fact is removed too.
export async function drainFacts(io: Io, root: string): Promise<Fact[]> {
  const dir = await stateDirOf(io, root)
  if (dir === null) return []
  const names = (await io.listDir(`${dir}/inbox`))
    .filter(name => !name.endsWith('/') && !name.includes('/') && !name.startsWith('-'))
    .sort()
    .slice(0, MAX_FACTS)
  const facts: Fact[] = []
  for (const name of names) {
    const fact = name.endsWith('.json') ? parseFact(await readInside(io, dir, `inbox/${name}`, MAX_FACT_CHARS)) : null
    if (fact !== null) facts.push(fact)
    await io.run(['rm', '-f', `${dir}/inbox/${name}`])
  }

  return facts
}
