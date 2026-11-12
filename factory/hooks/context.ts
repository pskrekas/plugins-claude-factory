// What a command or the line needs to act: the repo, the settings, and the
// tracker when there is one.
import { githubIssues, inRepo } from '../adapters/github-issues'
import { githubPrs } from '../adapters/github-pr'
import type { PrHost } from '../adapters/pr-host'
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
  // The tracker and the pull request host of this repository, each chosen by
  // itself; null when the settings or the remote name none the plugin knows.
  tracker: Tracker | null
  host: PrHost | null
  mark: string | null
  // The person who runs the line, as the tracker names an author; null when it is not known.
  me: () => Promise<string | null>
}

export async function context(io: Io): Promise<Ctx> {
  const { settings, root } = await loadSettings(io)
  const remote = await io.remote()
  // Every gh call names the repository of `origin`. A remote that names none
  // gives no tracker: nothing is written to a project gh would pick itself.
  const repo = repoOf(remote)
  const plain: Run = (argv, stdin) => io.run(argv, { cwd: root, timeoutMs: GH_TIMEOUT_MS, stdin })
  const run = repo === null ? plain : inRepo(plain, repo)
  const kind = settings.tracker?.kind
  const tracker = kind === 'github' && repo !== null && settings.tracker ? githubIssues(run, settings.tracker.mark, settings.factory.forbiddenCommentWords) : null
  const host = prHostOf(remote, settings.prHost) === 'github' && repo !== null ? githubPrs(run) : null

  return {
    root,
    me: async () => (tracker === null ? null : tracker.me()),
    base: settings.baseBranch,
    now: await io.now(),
    f: settings.factory,
    run,
    // As before this contract: with GitHub Issues the pull request host is GitHub too.
    tracker: host === null ? null : tracker,
    host,
    mark: host !== null && tracker !== null && settings.tracker ? settings.tracker.mark : null,
  }
}
