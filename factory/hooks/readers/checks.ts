// Runs the environment checks and looks at the ports the settings name.
// Nothing here runs before the person approved the settings file's commands.
import { judgeCheck, judgeDisk, judgePort, parseDfFreeGb } from '../../core/checks'
import type { CheckState } from '../../core/model'
import type { CheckSpec } from '../../core/settings'
import type { Io } from '../io'
import type { Reader } from '../refresh'

const CHECK_TIMEOUT_MS = 10_000
const PORT_TIMEOUT_MS = 3_000

// True when an argument of the command names something in the repo. A check
// runs by itself each minute; one that hands a repo file to a program (a
// script to an interpreter) would run whatever that file holds at the time,
// which nobody approved. The command line was approved, not the file.
async function namesRepoFile(io: Io, root: string, argv: string[]): Promise<boolean> {
  const found = await Promise.all(
    argv.slice(1).map(arg => (arg.startsWith('-') ? null : io.stat(`${root}/${arg}`))),
  )

  return found.some(entry => entry !== null)
}

async function runCheck(io: Io, root: string, spec: CheckSpec): Promise<CheckState> {
  if (spec.run) {
    if (await namesRepoFile(io, root, spec.run)) {
      return { name: spec.name, state: 'error', got: 'names a repo file' }
    }

    return judgeCheck(spec, await io.run(spec.run, { cwd: root, timeoutMs: CHECK_TIMEOUT_MS }))
  }
  const df = await io.run(['df', '-Pk', root], { timeoutMs: CHECK_TIMEOUT_MS })

  return judgeDisk(spec, 'failed' in df ? null : parseDfFreeGb(df.stdout))
}

export const checksReader: Reader = {
  name: 'checks',
  read: async (io, ctx) => {
    if (ctx.consent !== 'approved') return {}
    const [checks, ports] = await Promise.all([
      Promise.all(ctx.settings.checks.map(spec => runCheck(io, ctx.root, spec))),
      Promise.all(
        ctx.settings.ports.map(async ({ name, port }) =>
          judgePort(
            name,
            port,
            await io.run(['nc', '-z', '-w', '1', '127.0.0.1', String(port)], {
              timeoutMs: PORT_TIMEOUT_MS,
            }),
          ),
        ),
      ),
    ])

    return { checks, ports }
  },
}
