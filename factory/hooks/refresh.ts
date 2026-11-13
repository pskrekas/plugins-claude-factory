// One refresh: load the settings, run every reader, write the model.
import { alertsFor } from '../core/alerts'
import { approvedOf } from '../core/consent'
import { statusText } from '../core/layout'
import type { Consent, PanelModel } from '../core/model'
import { agentRows } from '../core/work'
import type { Settings } from '../core/settings'
import type { Io } from './io'
import { checksReader } from './readers/checks'
import { readJobs } from './jobs'
import { factoryReader, jobsView, lineOf } from './readers/factory'
import { progressReader } from './readers/progress'
import { loadSettings } from './readers/settings'
import { taskReader } from './readers/task'
import { workReader } from './readers/work'
import type { Loaded } from './readers/settings'

// `isLight`: the read at session start. It must be quick, so a reader skips
// what goes over the network (`gh`) and what the settings file asks to run.
export type Ctx = {
  root: string
  settings: Settings
  consent: Consent
  now: number
  isLight: boolean
}

// A reader fetches one part of the model. One that runs a command from the
// settings file must answer {} unless `ctx.consent` is 'approved'.
export type Reader = {
  name: string
  read: (io: Io, ctx: Ctx, prev: PanelModel) => Promise<Partial<PanelModel>>
}

export const readers: Reader[] = [taskReader, factoryReader, progressReader, checksReader, workReader]

export async function refresh(
  io: Io,
  options: { loaded?: Loaded; isLight?: boolean } = {},
): Promise<PanelModel> {
  const loaded = options.loaded ?? (await loadSettings(io))
  const now = await io.now()
  const prev = await io.getModel()
  const ctx: Ctx = {
    root: loaded.root,
    settings: loaded.settings,
    consent: loaded.consent,
    now,
    isLight: options.isLight === true,
  }
  const results = await Promise.allSettled(readers.map(reader => reader.read(io, ctx, prev)))

  const notes: string[] = []
  const pending = loaded.consent === 'needed' ? loaded.commands : []
  // A command counts as shown only when the pane was on screen to draw it. A
  // read with the pane closed, undrawn or behind another tab shows nothing.
  const isDrawn = await io.isPaneDrawn()
  const kept = prev.root === loaded.root ? prev.shown.filter(line => pending.includes(line)) : []
  const patch: Partial<PanelModel> = {
    root: loaded.root,
    consent: loaded.consent,
    pendingCommands: pending,
    shown: isDrawn ? pending : kept,
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

  // The full read saw the jobs as they are now: the job rows' own read need not ask again for this set.
  if (!ctx.isLight) seenJobs.set(io, jobsKey(loaded.root, (await readJobs(io, loaded.root)).jobs.map(job => job.id)))

  // The patch is applied to the model as it is now, not as it was read above:
  // an agent that started meanwhile is not lost.
  const model = await io.updateModel(current => ({ ...current, ...patch }))
  io.status(statusText(model))
  const alerts = alertsFor(prev, model)
  for (const alert of alerts) io.toast(alert)
  if (alerts.length > 0) io.sound()

  return model
}

// The agents alone: a cheap read, done when an agent starts or ends.
export async function refreshAgents(io: Io): Promise<void> {
  if (!(await io.isPaneDrawn())) return
  const [agents, now] = await Promise.all([io.agents(), io.now()])
  await io.updateModel(model => ({ ...model, agents: agentRows(agents, model.agents, now) }))
}

// The ids of the jobs at the last read of the job rows, for each session's
// Io. When they change (a job started, or one was removed) the queue changed
// too, and only the tracker knows it.
const seenJobs = new WeakMap<Io, string>()
const jobsKey = (root: string, ids: string[]) => [root, ...[...ids].sort()].join('\n')

// The job rows alone, from the job files of this machine: done when a job
// moves and on the watch timer, so that the line on screen is not a minute
// old. It asks no tracker and runs no command. A new set of jobs makes one
// full read; with no job at all there is nothing that moves.
export async function refreshJobs(io: Io): Promise<void> {
  if (!(await io.isPaneDrawn())) return
  const loaded = await loadSettings(io)
  const read = await readJobs(io, loaded.root)
  const key = jobsKey(loaded.root, read.jobs.map(job => job.id))
  const prev = await io.getModel()
  const before = seenJobs.get(io)
  seenJobs.set(io, key)
  // A full read: the set of jobs changed since the last look, the repo
  // changed, or this is the first look and there are jobs that were never
  // read. Only the first look asks for that: a reader that keeps failing
  // must not make a full read on every tick.
  const isNewSet = before !== undefined && before !== key
  const isFirstLook = before === undefined && prev.factory === null && read.jobs.length > 0
  if (isNewSet || isFirstLook || prev.root !== loaded.root) {
    await refresh(io, { loaded })

    return
  }
  // With no job nothing moves: the minute's read keeps the rest.
  if (read.jobs.length === 0) return
  const now = await io.now()
  const line = await lineOf(io, loaded.root, now)
  // Applied to the model as it is now: a full read that ended meanwhile keeps its queue and its note.
  const model = await io.updateModel(current =>
    current.factory === null || current.root !== loaded.root
      ? current
      : { ...current, factory: jobsView(read, loaded.settings.factory, current.factory, line, now) },
  )
  io.status(statusText(model))
}

const count = (lines: string[]) => `${lines.length} command${lines.length === 1 ? '' : 's'}`
const readThem = (lines: string[]) =>
  `Read ${lines.length === 1 ? 'it' : 'them'}, then run /factory approve again.`
const NOT_ON_SCREEN =
  'The panel is not on screen, so nothing was approved. Run /factory, read the commands, then run /factory approve.'

const sameLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i])

// `/factory approve`: allows exactly the commands the panel showed, for the
// repo it showed them for. The settings file is read again first. Nothing is
// approved unless the pane is on screen and already showed these very lines:
// a file that was never shown, that changed since, or that belongs to another
// repo is drawn now and approved only by a second run. The answer holds a
// count, never the lines: they are read in the pane, and an answer's text goes
// on to the model.
export async function approve(io: Io): Promise<string> {
  const loaded = await loadSettings(io)
  if (loaded.consent !== 'needed') {
    await refresh(io, { loaded })

    return 'Nothing to approve.'
  }
  const onScreen = await io.getModel()
  const lines = loaded.commands
  if (!(await io.isPaneDrawn())) {
    await refresh(io, { loaded })

    return NOT_ON_SCREEN
  }
  const wasShown = onScreen.root === loaded.root && onScreen.shown.length > 0
  if (!wasShown || !sameLines(onScreen.shown, lines)) {
    await refresh(io, { loaded })

    return wasShown
      ? `The settings file changed. The panel now shows ${count(lines)}. ${readThem(lines)}`
      : `Not approved yet. The panel shows ${count(lines)}. ${readThem(lines)}`
  }
  const before = approvedOf(await io.storeGet(loaded.key))
  await io.storeSet(loaded.key, [...new Set([...before, ...lines])].sort())
  await refresh(io)

  return `Approved ${count(lines)}.`
}
