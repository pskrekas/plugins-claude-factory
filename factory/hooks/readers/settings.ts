// Reads the repo's .claude/factory.json and says whether its commands are approved.
import { consentOf, storeKey } from '../../core/consent'
import type { Consent } from '../../core/model'
import { commandsOf, parseSettings } from '../../core/settings'
import type { Settings } from '../../core/settings'
import type { Io } from '../io'
import { readInside } from './files'

const MAX_SETTINGS_BYTES = 256 * 1024

export type Loaded = {
  root: string
  // The store key the approvals of this repo are kept under.
  key: string
  settings: Settings
  error: string | null
  consent: Consent
  commands: string[]
}

export async function loadSettings(io: Io): Promise<Loaded> {
  const root = await io.root()
  // A missing file is the normal case, not an error. A settings file that is a
  // link to somewhere outside the repo counts as missing.
  const text = await readInside(io, root, '.claude/factory.json', MAX_SETTINGS_BYTES)
  const { settings, error } = parseSettings(text)
  const commands = commandsOf(settings)
  const key = storeKey(await io.consentKey())
  const stored = await io.storeGet(key)

  return { root, key, settings, error, consent: consentOf(text !== null, commands, stored), commands }
}
