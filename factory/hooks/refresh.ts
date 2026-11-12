// One refresh: load the settings, run every reader, write the model.
import { storeKey, approvedOf } from '../core/consent'
import { statusText } from '../core/layout'
import type { Consent, PanelModel } from '../core/model'
import { agentRows } from '../core/work'
import type { Settings } from '../core/settings'
import type { Io } from './io'
import { checksReader } from './readers/checks'
import { progressReader } from './readers/progress'
import { loadSettings } from './readers/settings'
import { taskReader } from './readers/task'
import { workReader } from './readers/work'
import type { Loaded } from './readers/settings'

export type Ctx = { root: string; settings: Settings; consent: Consent; now: number }

// A reader fetches one part of the model. One that runs a command from the
// settings file must answer {} unless `ctx.consent` is 'approved'.
export type Reader = {
  name: string
  read: (io: Io, ctx: Ctx, prev: PanelModel) => Promise<Partial<PanelModel>>
}

export const readers: Reader[] = [taskReader, progressReader, checksReader, workReader]

export async function refresh(io: Io, given?: Loaded): Promise<PanelModel> {
  const loaded = given ?? (await loadSettings(io))
  const now = await io.now()
  const prev = await io.getModel()
  const ctx: Ctx = { root: loaded.root, settings: loaded.settings, consent: loaded.consent, now }
  const results = await Promise.allSettled(readers.map(reader => reader.read(io, ctx, prev)))

  const notes: string[] = []
  const patch: Partial<PanelModel> = {
    root: loaded.root,
    consent: loaded.consent,
    pendingCommands: loaded.consent === 'needed' ? loaded.commands : [],
    settingsError: loaded.error,
    notes,
    readAt: now,
  }
  // What an unapproved settings file asked for is not kept on screen.
  if (loaded.consent !== 'approved') Object.assign(patch, { checks: [], ports: [] })
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') Object.assign(patch, result.value)
    else notes.push(`${readers[i]?.name ?? 'reader'}: failed`)
  })

  // The patch is applied to the model as it is now, not as it was read above:
  // an agent that started meanwhile is not lost.
  const model = await io.updateModel(current => ({ ...current, ...patch }))
  io.status(statusText(model))

  return model
}

// The agents alone: a cheap read, done when an agent starts or ends.
export async function refreshAgents(io: Io): Promise<void> {
  if (!(await io.isPaneOpen())) return
  const [agents, now] = await Promise.all([io.agents(), io.now()])
  await io.updateModel(model => ({ ...model, agents: agentRows(agents, model.agents, now) }))
}

const count = (lines: string[]) => `${lines.length} command${lines.length === 1 ? '' : 's'}`
const it = (lines: string[]) => (lines.length === 1 ? 'it' : 'them')
const again = (lines: string[]) =>
  `${lines.join('\n')}\nRun /factory approve again to allow ${it(lines)}.`

const sameLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i])

// `/factory approve`: allows exactly the commands the panel last showed, for
// the repo it showed them for. The settings file is read again first: a file
// that was never shown, that changed since, or that belongs to another repo
// than the one on screen is shown now and approved only by a second run. So
// the person never approves a line they did not see.
export async function approve(io: Io): Promise<string> {
  const onScreen = await io.getModel()
  const loaded = await loadSettings(io)
  if (loaded.consent !== 'needed') {
    await refresh(io, loaded)

    return 'Nothing to approve.'
  }
  const lines = loaded.commands
  const wasShown = onScreen.root === loaded.root && onScreen.pendingCommands.length > 0
  if (!wasShown || !sameLines(onScreen.pendingCommands, lines)) {
    await refresh(io, loaded)
    const why = wasShown
      ? `The settings file changed. It now names ${count(lines)}`
      : `Not approved yet. The settings file names ${count(lines)}`

    return `${why}:\n${again(lines)}`
  }
  const key = storeKey(loaded.root)
  const before = approvedOf(await io.storeGet(key))
  await io.storeSet(key, [...new Set([...before, ...lines])].sort())
  await refresh(io)

  return `Approved ${count(lines)}:\n${lines.join('\n')}`
}
