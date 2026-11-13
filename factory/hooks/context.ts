// What a command or the line needs to act: the repo, the settings, and the
// tracker when there is one.
import type { PrHost } from '../adapters/pr-host'
import type { Run, Tracker } from '../adapters/tracker'
import type { FactorySettings } from '../core/factory-settings'
import type { Io } from './io'
import { adaptersOf } from './adapters'
import { loadSettings } from './readers/settings'

const GH_TIMEOUT_MS = 30_000
// A tracker that the settings name and the parser refused. A fixed sentence: the
// answer of a command reaches the model, and the reason is text of the settings file.
export const TRACKER_REFUSED = "The tracker in the settings file was refused. The pane's settings line says why."

export type Ctx = {
  root: string
  // The branch jobs start from and are compared with.
  base: string
  now: number
  f: FactorySettings
  run: Run
  // The tracker and the pull request host of this repository, each chosen by
  // itself; null when the settings or the remote name none the plugin knows.
  tracker: Tracker | null
  host: PrHost | null
  mark: string | null
  // Why there is no tracker, when the settings name one that cannot be reached.
  trackerNote: string | null
  // The person who runs the line, as the tracker names an author; null when it is not known.
  me: () => Promise<string | null>
}

export async function context(io: Io): Promise<Ctx> {
  const { settings, root, error } = await loadSettings(io)
  const { run, tracker, host, why } = await adaptersOf(io, root, settings, GH_TIMEOUT_MS)

  return {
    root,
    me: async () => (tracker === null ? null : tracker.me()),
    base: settings.baseBranch,
    now: await io.now(),
    f: settings.factory,
    run,
    tracker,
    host,
    mark: tracker !== null && settings.tracker ? settings.tracker.mark : null,
    trackerNote: why ?? (tracker === null && error !== null && error.startsWith('tracker:') ? TRACKER_REFUSED : null),
  }
}
