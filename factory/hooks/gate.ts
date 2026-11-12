// The gate: the checks a job's branch must pass. Code runs them, no agent.
import { approvedOf, storeKey } from '../core/consent'
import { containerLine } from '../core/factory-settings'
import type { ContainerSpec } from '../core/factory-settings'
import { gateReport, outputTail, protectedHits, testFilesOf } from '../core/gate'
import type { CheckRun } from '../core/gate'
import type { Job } from '../core/job'
import { GATE_MARK, isBranchName, lineOf, parseSettings } from '../core/settings'
import type { Settings } from '../core/settings'
import { makeGate, removeOf, runArgv } from './container'
import type { Io } from './io'
import { writeJobFile } from './jobs'
import { consentKeyOf } from './readers/repo'
import {
  addCleanCopy,
  baseHeadOf,
  changedFiles,
  fetchBase,
  git,
  headOf,
  removeCleanCopy,
  uncommittedFiles,
} from './worktrees'

const MAX_SETTINGS_CHARS = 256 * 1024

type Box = ContainerSpec | false | null
type Gate = { ok: true; commands: string[][]; baseSha: string; protectedPaths: string[]; container: Box } | { ok: false; why: string }
const BOX_NOT_APPROVED = 'the container settings are not approved'

// The settings file of the base branch, read once by the commit's id, and the
// lines this repository's person approved.
async function baseSettings(
  io: Io,
  root: string,
  base: string,
): Promise<{ ok: true; settings: Settings; baseSha: string; approved: Set<string> } | { ok: false; why: string }> {
  if (!isBranchName(base)) return { ok: false, why: 'not a branch name' }
  const baseSha = await baseHeadOf(io, root, base)
  if (baseSha === null) return { ok: false, why: `no branch origin/${base}` }
  const shown = await git(io, root, { do: 'show-settings', sha: baseSha })
  if (shown === null || 'failed' in shown || shown.exitCode !== 0) return { ok: false, why: `no settings file on ${base}` }
  if (shown.stdout.length > MAX_SETTINGS_CHARS) return { ok: false, why: `settings on ${base}: too large` }
  const { settings, error } = parseSettings(shown.stdout)
  if (error !== null) return { ok: false, why: `settings on ${base}: ${error}` }

  return { ok: true, settings, baseSha, approved: new Set(approvedOf(await io.storeGet(storeKey(await consentKeyOf(io, root))))) }
}

// Where the builder's and the gate's commands run (design 8.3): the base
// branch's container settings, when the person approved their line. `false`
// (on this machine) is the person's own word, so it needs the approval too.
// `null`: the base names none.
export async function baseContainer(io: Io, root: string, base: string): Promise<{ ok: true; container: Box } | { ok: false; why: string }> {
  const read = await baseSettings(io, root, base)
  if (!read.ok) return read
  const { container } = read.settings.factory
  const line = containerLine(container)

  return line !== null && !read.approved.has(line) ? { ok: false, why: BOX_NOT_APPROVED } : { ok: true, container }
}

// The commands of the fast or the full gate, or why there are none to run.
//
// They are read from the settings file of the **base branch**, never from a
// working tree: a job's branch cannot change the checks it is judged by. The
// base is read once, by the full name of its remote ref, and then by that
// commit's id (`baseSha`): a branch or a tag that a job names `origin/<base>`
// is not read in its place. The protected paths are the base branch's too.
// And each command must be on the approved list of this repository, with the
// gate's mark. The container the commands run in is the base branch's too,
// and its line must be approved as well.
export async function gateCommands(io: Io, root: string, base: string, which: 'fast' | 'full'): Promise<Gate> {
  const read = await baseSettings(io, root, base)
  if (!read.ok) return read
  const { settings, baseSha, approved } = read
  const commands = settings.gate[which]
  if (commands.length === 0) return { ok: false, why: 'no gate' }
  if (!commands.every(argv => approved.has(GATE_MARK + lineOf(argv)))) {
    return { ok: false, why: 'gate commands are not approved' }
  }
  const { container } = settings.factory
  const line = containerLine(container)
  if (line !== null && !approved.has(line)) return { ok: false, why: BOX_NOT_APPROVED }

  return { ok: true, commands, baseSha, protectedPaths: settings.factory.protectedPaths, container }
}

// A command of the gate may run for ten minutes. A longer one is a failure:
// a job is never left "in the gate" for good.
const COMMAND_TIMEOUT_MS = 600_000

// Runs the fast or the full gate on a job's branch and writes the report into
// the job's files. `needsPerson` is true when a person must look before the
// job can go on: the base branch could not be fetched or read, the commands
// are not approved, the changed files could not be listed, the clean copy
// could not be made, or the branch changed a protected path.
//
// `sha` is the commit the gate judged, when it wrote a report: a caller that
// pushes the branch or marks its pull request ready after the gate must see
// that the branch is still at this commit (`headOf`).
//
// The gate judges one commit against one commit. It fetches the base, reads
// the base's last commit and the job branch's last commit once, each by the
// full name of its ref, and from then on uses only the two ids: for the
// settings file, for the list of changed files, and for a fresh copy of the
// job's commit (`gate/<job id>` in the state folder) that the commands run
// in. Every one of these calls runs in the repo, never in the folder the
// builder worked in. So a file that is not committed, a file git ignores, a
// file git was told to overlook, or a ref with a look-alike name cannot change
// what is checked or what the commands see. The copy holds no installed
// packages: the gate's own commands install them.
//
// The commands run code that an agent wrote. So they run in a container that
// holds the clean copy and nothing else of this machine (design 8.3), unless
// the base branch's settings say `"container": false` and the person approved
// that. With no container setting the gate does not run.
export async function runGate(
  io: Io,
  root: string,
  job: Job,
  base: string,
  which: 'fast' | 'full',
): Promise<{ pass: boolean; why: string | null; needsPerson: boolean; sha: string | null }> {
  const stop = (why: string) => ({ pass: false, why, needsPerson: true, sha: null })
  if (!isBranchName(base)) return stop('not a branch name')
  if (!(await fetchBase(io, root, base)).ok) return stop('the base branch could not be fetched')
  const gate = await gateCommands(io, root, base, which)
  if (!gate.ok) return stop(gate.why)
  if (gate.container === null) return stop('no container is set')
  const spec = gate.container
  const sha = await headOf(io, root, job.id)
  const changed = sha === null ? null : await changedFiles(io, root, gate.baseSha, sha)
  if (sha === null || changed === null) return stop('the changed files could not be listed')
  // Only a note for the report, and the one thing read in the builder's folder.
  const uncommitted = (await uncommittedFiles(io, root, job.id)) ?? []

  // A branch that changed the settings file, or another protected path, is
  // not run at all: its own code would be what runs.
  const hits = protectedHits(changed, gate.protectedPaths)
  const runs: CheckRun[] = []
  // A branch that changed no file would pass on the base's own content.
  const isEmpty = changed.length === 0
  if (hits.length === 0 && !isEmpty) {
    // A container that an earlier gate run left may still run in the old
    // copy: docker must say that it is gone before git touches the folder.
    if (spec !== false && !(await removeOf(io, root, job.id, 'gate'))) return stop("the gate's container could not be stopped (start Docker)")
    const copy = await addCleanCopy(io, root, job.id, sha)
    if (!copy.ok) return stop('the clean copy could not be made')
    let box: { name: string; folder: string } | null = null
    try {
      if (spec !== false) {
        const made = await makeGate(io, root, job.id, spec)
        if (!made.ok) return stop(`the gate's container could not be made (${made.why})`)
        box = made
      }
      for (const argv of gate.commands) {
        const started = await io.now()
        const result = box === null ? await io.run(argv, { cwd: copy.path, timeoutMs: COMMAND_TIMEOUT_MS }) : await runArgv(io, box.name, box.folder, argv, COMMAND_TIMEOUT_MS)
        const isFailed = 'failed' in result
        runs.push({
          line: lineOf(argv),
          exitCode: isFailed ? null : result.exitCode,
          failed: isFailed ? result.failed : null,
          tail: isFailed ? '' : outputTail(result.stdout, result.stderr),
          isCut: !isFailed && result.isCut === true,
          ms: (await io.now()) - started,
        })
        if (isFailed || result.exitCode !== 0) break
      }
    } finally {
      // The container goes first: nothing runs in the copy when it is removed.
      // While docker does not say that it is gone, the copy stays; the next
      // gate run removes both.
      const isGone = spec === false || (await removeOf(io, root, job.id, 'gate').catch(() => false))
      if (isGone) await removeCleanCopy(io, root, job.id)
    }
  }

  const report = gateReport({
    which,
    round: job.round,
    runs,
    protectedHits: hits,
    testFiles: testFilesOf(changed),
    uncommitted: [...uncommitted].sort(),
    isEmpty,
  })
  const name = which === 'fast' ? 'checks.md' : 'merge-checks.md'
  await writeJobFile(io, root, job.id, `round-${job.round}/${name}`, report.markdown)

  return { pass: report.pass, why: report.why, needsPerson: hits.length > 0, sha }
}
