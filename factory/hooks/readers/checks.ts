// Runs the environment checks and looks at the ports the settings name.
// Nothing here runs before the person approved the settings file's commands.
import { judgeCheck, judgeDisk, judgePort, parseDfFreeGb } from '../../core/checks'
import type { CheckState } from '../../core/model'
import type { CheckSpec } from '../../core/settings'
import type { Io } from '../io'
import type { Reader } from '../refresh'

const CHECK_TIMEOUT_MS = 10_000
const PORT_TIMEOUT_MS = 3_000
const AT_ONCE = 4

// True when an argument of the command names a file of the repo. A check runs
// by itself each minute; one that hands a repo file to a program (a script to
// an interpreter) would run whatever that file holds at the time. This is a
// guard against the plain case, not a boundary: an inline script or a build
// tool still runs repo code, and the README says so. A folder's name is not
// refused: `config` is an ordinary word of many commands.
async function namesRepoFile(io: Io, root: string, argv: string[]): Promise<boolean> {
  const found = await Promise.all(
    argv.slice(1).map(arg => (arg.startsWith('-') ? null : io.stat(`${root}/${arg}`))),
  )

  return found.some(entry => entry?.kind === 'file')
}

// Runs `jobs` a few at a time, in order.
async function inBatches<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const done: T[] = []
  for (let i = 0; i < jobs.length; i += AT_ONCE) {
    done.push(...(await Promise.all(jobs.slice(i, i + AT_ONCE).map(job => job()))))
  }

  return done
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
    if (ctx.consent !== 'approved' || ctx.isLight) return {}
    const checks = await inBatches(
      ctx.settings.checks.map(spec => () => runCheck(io, ctx.root, spec)),
    )
    const ports = await inBatches(
      ctx.settings.ports.map(({ name, port }) => async () =>
        judgePort(
          name,
          port,
          await io.run(['nc', '-z', '-w', '1', '127.0.0.1', String(port)], {
            timeoutMs: PORT_TIMEOUT_MS,
          }),
        ),
      ),
    )

    return { checks, ports }
  },
}
