// Reads the repo's .claude/factory.json and says whether its commands are approved.
import { consentOf, storeKey } from '../../core/consent'
import type { Consent } from '../../core/model'
import { commandsOf, parseSettings } from '../../core/settings'
import type { Settings } from '../../core/settings'
import type { Io } from '../io'

export type Loaded = {
  root: string
  settings: Settings
  error: string | null
  consent: Consent
  commands: string[]
}

export async function loadSettings(io: Io): Promise<Loaded> {
  const root = await io.root()
  // A missing file is the normal case, not an error.
  const text = await io.readFile(`${root}/.claude/factory.json`)
  const { settings, error } = parseSettings(text)
  const commands = commandsOf(settings)
  const stored = await io.storeGet(storeKey(root))

  return { root, settings, error, consent: consentOf(text !== null, commands, stored), commands }
}
