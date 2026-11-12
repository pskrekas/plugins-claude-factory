// Runs the environment checks and looks at the ports the settings name.
// Nothing here runs before the person approved the settings file's commands.
import { judgeCheck, judgeDisk, judgePort, parseDfFreeGb } from '../../core/checks'
import type { CheckState } from '../../core/model'
import type { CheckSpec } from '../../core/settings'
import type { Io } from '../io'
import type { Reader } from '../refresh'

const CHECK_TIMEOUT_MS = 10_000
const PORT_TIMEOUT_MS = 3_000

async function runCheck(io: Io, root: string, spec: CheckSpec): Promise<CheckState> {
  if (spec.run) {
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
