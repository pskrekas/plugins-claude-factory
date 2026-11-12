// One refresh: load the settings, run every reader, write the model.
import { storeKey, approvedOf } from '../core/consent'
import { statusText } from '../core/layout'
import type { Consent, PanelModel } from '../core/model'
import type { Settings } from '../core/settings'
import type { Io } from './io'
import { progressReader } from './readers/progress'
import { loadSettings } from './readers/settings'

export type Ctx = { root: string; settings: Settings; consent: Consent; now: number }

// A reader fetches one part of the model. One that runs a command from the
// settings file must answer {} unless `ctx.consent` is 'approved'.
export type Reader = {
  name: string
  read: (io: Io, ctx: Ctx, prev: PanelModel) => Promise<Partial<PanelModel>>
}

export const readers: Reader[] = [progressReader]

export async function refresh(io: Io): Promise<PanelModel> {
  const loaded = await loadSettings(io)
  const now = await io.now()
  const prev = await io.getModel()
  const ctx: Ctx = { root: loaded.root, settings: loaded.settings, consent: loaded.consent, now }
  const results = await Promise.allSettled(readers.map(reader => reader.read(io, ctx, prev)))

  const isApproved = loaded.consent === 'approved'
  const model: PanelModel = {
    ...prev,
    consent: loaded.consent,
    pendingCommands: loaded.consent === 'needed' ? loaded.commands : [],
    settingsError: loaded.error,
    // What an unapproved settings file asked for is not kept on screen.
    checks: isApproved ? prev.checks : [],
    ports: isApproved ? prev.ports : [],
    notes: [],
    readAt: now,
  }
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') Object.assign(model, result.value)
    else model.notes.push(`${readers[i]?.name ?? 'reader'}: failed`)
  })

  await io.setModel(model)
  io.status(statusText(model))

  return model
}

const count = (lines: string[]) => `${lines.length} command${lines.length === 1 ? '' : 's'}`
const it = (lines: string[]) => (lines.length === 1 ? 'it' : 'them')
const again = (lines: string[]) =>
  `${lines.join('\n')}\nRun /factory approve again to allow ${it(lines)}.`

// `/factory approve`: allows exactly the commands the panel last showed. A file
// that was never shown, or that changed since, is shown first and approved by a
// second run, so the person never approves a line they did not see.
export async function approve(io: Io): Promise<string> {
  const shown = (await io.getModel()).pendingCommands
  if (shown.length === 0) {
    const now = await refresh(io)
    if (now.consent !== 'needed') return 'Nothing to approve.'
    const lines = now.pendingCommands

    return `Not approved yet. The settings file names ${count(lines)}:\n${again(lines)}`
  }
  const key = storeKey(await io.root())
  const before = approvedOf(await io.storeGet(key))
  await io.storeSet(key, [...new Set([...before, ...shown])].sort())
  const now = await refresh(io)
  if (now.consent === 'needed') {
    const lines = now.pendingCommands

    return `The settings file changed. It now names ${count(lines)}:\n${again(lines)}`
  }

  return `Approved ${count(shown)}:\n${shown.join('\n')}`
}
