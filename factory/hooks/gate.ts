// The gate: the checks a job's branch must pass. Code runs them, no agent.
import { approvedOf, storeKey } from '../core/consent'
import { GATE_MARK, isBranchName, lineOf, parseSettings } from '../core/settings'
import type { Io } from './io'
import { consentKeyOf } from './readers/repo'

const GIT_TIMEOUT_MS = 10_000
const MAX_SETTINGS_CHARS = 256 * 1024

// The commands of the fast or the full gate, or why there are none to run.
//
// They are read from the settings file of the **base branch** (`git show`),
// never from a working tree: a job's branch cannot change the checks it is
// judged by. And each one must be on the approved list of this repository,
// with the gate's mark.
export async function gateCommands(
  io: Io,
  root: string,
  base: string,
  which: 'fast' | 'full',
): Promise<{ ok: true; commands: string[][] } | { ok: false; why: string }> {
  if (!isBranchName(base)) return { ok: false, why: 'not a branch name' }
  const shown = await io.run(['git', 'show', `origin/${base}:.claude/factory.json`], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if ('failed' in shown || shown.exitCode !== 0) return { ok: false, why: `no settings file on ${base}` }
  if (shown.stdout.length > MAX_SETTINGS_CHARS) return { ok: false, why: `settings on ${base}: too large` }
  const { settings, error } = parseSettings(shown.stdout)
  if (error !== null) return { ok: false, why: `settings on ${base}: ${error}` }
  const commands = settings.gate[which]
  if (commands.length === 0) return { ok: false, why: 'no gate' }

  const approved = new Set(approvedOf(await io.storeGet(storeKey(await consentKeyOf(io, root)))))
  if (!commands.every(argv => approved.has(GATE_MARK + lineOf(argv)))) {
    return { ok: false, why: 'gate commands are not approved' }
  }

  return { ok: true, commands }
}
