// What a command or the line needs to act: the repo, the settings, and the
// tracker when there is one.
import { githubIssues, inRepo } from '../adapters/github-issues'
import type { Run, Tracker } from '../adapters/tracker'
import type { FactorySettings } from '../core/factory-settings'
import { prHostOf, repoOf } from '../core/task'
import type { Io } from './io'
import { loadSettings } from './readers/settings'

const GH_TIMEOUT_MS = 30_000

export type Ctx = {
  root: string
  // The branch jobs start from and are compared with.
  base: string
  now: number
  f: FactorySettings
  run: Run
  // The tracker and the pull request host are GitHub, or there is none here.
  tracker: Tracker | null
  mark: string | null
}

export async function context(io: Io): Promise<Ctx> {
  const { settings, root } = await loadSettings(io)
  const remote = await io.remote()
  // Every gh call names the repository of `origin`. A remote that names none
  // gives no tracker: nothing is written to a project gh would pick itself.
  const repo = repoOf(remote)
  const plain: Run = (argv, stdin) => io.run(argv, { cwd: root, timeoutMs: GH_TIMEOUT_MS, stdin })
  const run = repo === null ? plain : inRepo(plain, repo)
  const tracker = settings.tracker
  const isGitHub = tracker?.kind === 'github' && prHostOf(remote, settings.prHost) === 'github' && repo !== null

  return {
    root,
    base: settings.baseBranch,
    now: await io.now(),
    f: settings.factory,
    run,
    tracker: isGitHub && tracker ? githubIssues(run, tracker.mark, settings.factory.forbiddenCommentWords) : null,
    mark: isGitHub && tracker ? tracker.mark : null,
  }
}
