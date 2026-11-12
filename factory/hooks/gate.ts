// The gate: the checks a job's branch must pass. Code runs them, no agent.
import { approvedOf, storeKey } from '../core/consent'
import type { FactorySettings } from '../core/factory-settings'
import { gateReport, protectedHits, tailOf, testFilesOf } from '../core/gate'
import type { CheckRun } from '../core/gate'
import type { Job } from '../core/job'
import { GATE_MARK, isBranchName, lineOf, parseSettings } from '../core/settings'
import type { Io } from './io'
import { writeJobFile } from './jobs'
import { consentKeyOf } from './readers/repo'
import { changedFiles, worktreePath } from './worktrees'

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

// A command of the gate may run for ten minutes. A longer one is a failure:
// a job is never left "in the gate" for good.
const COMMAND_TIMEOUT_MS = 600_000

// Runs the fast or the full gate on a job's branch and writes the report into
// the job's files. `needsPerson` is true when a person must look before the
// job can go on: the commands could not be read or are not approved, the
// changed files could not be listed, or the branch changed a protected path.
export async function runGate(
  io: Io,
  root: string,
  job: Job,
  base: string,
  f: FactorySettings,
  which: 'fast' | 'full',
): Promise<{ pass: boolean; why: string | null; needsPerson: boolean }> {
  const gate = await gateCommands(io, root, base, which)
  if (!gate.ok) return { pass: false, why: gate.why, needsPerson: true }
  const cwd = await worktreePath(io, root, job.id)
  const changed = await changedFiles(io, root, job.id, base)
  if (cwd === null || changed === null) {
    return { pass: false, why: 'the changed files could not be listed', needsPerson: true }
  }

  // A branch that changed the settings file, or another protected path, is
  // not run at all: its own code would be what runs.
  const hits = protectedHits(changed, f.protectedPaths)
  const runs: CheckRun[] = []
  for (const argv of hits.length > 0 ? [] : gate.commands) {
    const started = await io.now()
    const result = await io.run(argv, { cwd, timeoutMs: COMMAND_TIMEOUT_MS })
    const isFailed = 'failed' in result
    runs.push({
      line: lineOf(argv),
      exitCode: isFailed ? null : result.exitCode,
      failed: isFailed ? result.failed : null,
      tail: isFailed ? '' : tailOf(result.stdout + (result.stderr === '' ? '' : '\n' + result.stderr)),
      ms: (await io.now()) - started,
    })
    if (isFailed || result.exitCode !== 0) break
  }

  const report = gateReport({ which, round: job.round, runs, protectedHits: hits, testFiles: testFilesOf(changed) })
  const name = which === 'fast' ? 'checks.md' : 'merge-checks.md'
  await writeJobFile(io, root, job.id, `round-${job.round}/${name}`, report.markdown)

  return { pass: report.pass, why: report.why, needsPerson: hits.length > 0 }
}
