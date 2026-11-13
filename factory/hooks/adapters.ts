// Which tracker and which pull request host a repository uses: each chosen
// by itself, from the settings and the git remote `origin`.
import { azureBoards } from '../adapters/azure-boards'
import type { Put } from '../adapters/azure-boards'
import { azureRepos } from '../adapters/azure-repos'
import { githubIssues, inRepo } from '../adapters/github-issues'
import { githubPrs } from '../adapters/github-pr'
import { mcpTracker } from '../adapters/mcp-tracker'
import type { PrHost } from '../adapters/pr-host'
import type { Run, Tracker } from '../adapters/tracker'
import { azPlaceOf, boardsPlaceOf } from '../core/azure'
import { approvedOf, storeKey } from '../core/consent'
import { mcpLines } from '../core/mcp-tracker'
import { trackerLine } from '../core/settings'
import type { Settings } from '../core/settings'
import { githubRepoOf, prHostOf, repoOf } from '../core/task'
import type { Io } from './io'
import { stateDirOf } from './jobs'
import { consentKeyOf } from './readers/repo'

// `az` is told to send no usage data: on some machines it never ends while it sends it,
// and then every call runs into its time limit.
const AZ_ENV = { AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no', AZURE_CORE_COLLECT_TELEMETRY: 'no' }
export const NO_AZ_PLACE = 'The remote origin names no Azure DevOps project. Set tracker.project to <organization>/<project>, or use a dev.azure.com remote.'
// No text of the settings file: the answer reaches the model, and the file is not approved yet.
export const PLACE_NOT_APPROVED = "The tracker's place is named by the settings file, not by the remote. Read its [tracker] line in the pane, then /factory approve."
export const MCP_NOT_APPROVED = "The MCP tracker's calls are not approved. Read them in the pane, then /factory approve."

export type Adapters = {
  // Runs one host command in the repository; a `gh` call names the repository of `origin`.
  run: Run
  tracker: Tracker | null
  host: PrHost | null
  // Why there is no tracker, when the settings name one that cannot be reached; else null.
  why: string | null
}

export async function adaptersOf(io: Io, root: string, settings: Settings, timeoutMs: number): Promise<Adapters> {
  const remote = await io.remote()
  // `az` installs a missing extension by itself when nobody can be asked:
  // it is told not to, so that it says at once what is missing.
  const plain: Run = (argv, stdin) => io.run(argv, { cwd: root, timeoutMs, stdin, ...(argv[0] === 'az' ? { env: AZ_ENV } : {}) })
  // A file of the plugin's own, in the state folder: `az` reads outside text
  // only from such a file. The adapter removes it after its call.
  const put: Put = async (text, ext) => {
    const dir = await stateDirOf(io, root)
    if (dir === null) return null
    const fresh = () => Math.random().toString(36).slice(2)
    const path = `${dir}/tmp/${fresh()}${fresh()}.${ext}`
    try {
      await io.run(['mkdir', '-p', `${dir}/tmp`])
      await io.writeFile(path, text)

      return path
    } catch {
      return null
    }
  }
  // The repository of the code. Every `gh` call that writes names it.
  const codeRepo = repoOf(remote)
  const codePlace = azPlaceOf(remote)
  const hostKind = prHostOf(remote, settings.prHost)
  let host: PrHost | null = null
  // The pull request of the checked-out branch is asked with no repository named: `gh` finds it.
  if (hostKind === 'github' && codeRepo !== null) host = githubPrs(inRepo(plain, codeRepo), plain)
  if (hostKind === 'azure-repos' && codePlace !== null) host = azureRepos(plain, put, codePlace)

  let tracker: Tracker | null = null
  let why: string | null = null
  const wanted = settings.tracker
  // A place that the settings file names, and not the remote, counts only
  // when the person approved its line: a settings file arrives with a clone.
  const isAllowed = async (isFromSettings: boolean): Promise<boolean> => {
    const line = trackerLine(wanted)
    if (!isFromSettings || line === null) return true
    if (approvedOf(await io.storeGet(storeKey(await consentKeyOf(io, root)))).includes(line)) return true
    why = PLACE_NOT_APPROVED

    return false
  }
  if (wanted?.kind === 'github') {
    // The issues are those of the remote's repository; with code on another
    // host, `tracker.project` names the GitHub repository (`owner/name`).
    const repo = githubRepoOf(remote, wanted.project)
    if (repo !== null && (await isAllowed(codeRepo === null))) tracker = githubIssues(inRepo(plain, repo), wanted.mark, settings.factory.forbiddenCommentWords)
  }
  if (wanted?.kind === 'azure-boards') {
    const place = boardsPlaceOf(remote, wanted.project)
    if (place === null) why = NO_AZ_PLACE
    else if (await isAllowed(codePlace === null)) tracker = azureBoards(plain, put, place, wanted.mark, settings.factory.forbiddenCommentWords)
  }
  // A tracker behind an MCP server: every call the settings name, and the mark,
  // must be approved line by line before any of them is made. `$.mcp.call`
  // asks no permission, and uses the person's own sign-in.
  if (wanted?.kind === 'mcp' && wanted.mcp !== null) {
    const spec = wanted.mcp
    const approved = new Set(approvedOf(await io.storeGet(storeKey(await consentKeyOf(io, root)))))
    if (mcpLines(spec, wanted.mark).every(line => approved.has(line))) {
      tracker = mcpTracker((tool, args) => io.mcp(spec.server, tool, args, timeoutMs), spec, wanted.mark, settings.factory.forbiddenCommentWords)
    } else why = MCP_NOT_APPROVED
  }

  return { run: codeRepo === null ? plain : inRepo(plain, codeRepo), tracker, host, why }
}
