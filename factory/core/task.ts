// The task of the current branch: its ticket id, and which PR host the repo uses. Pure.
import type { RunResult } from './run'
import type { Settings } from './settings'

const MAX_BRANCH = 200

// The first capture group if the pattern has one, else the whole match.
export function ticketOf(branch: string, pattern: string | null): string | null {
  if (pattern === null) return null
  const match = new RegExp(pattern).exec(branch.slice(0, MAX_BRANCH))
  if (match === null) return null

  return match[1] ?? match[0]
}

// The host name in a git remote: `https://user@host:port/path` or `user@host:path`.
function hostOf(remote: string): string | null {
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(remote)
  const scp = /^[^/@]+@([^:/]+):/.exec(remote)
  const authority = url?.[1] ?? scp?.[1]
  if (authority === undefined) return null

  return (authority.split('@').pop() ?? '').split(':')[0]?.toLowerCase() ?? null
}

// The GitHub repository a remote names, as `owner/name`, or null. Every `gh`
// call that writes names it: in a fork, `gh` alone would pick the project the
// fork came from.
export function repoOf(remote: string | null): string | null {
  if (remote === null || hostOf(remote) !== 'github.com') return null
  const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(remote)
    ? remote.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, '')
    : remote.slice(remote.indexOf(':') + 1)
  const parts = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/')
  const isName = (part: string) => /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/.test(part)

  return parts.length === 2 && parts.every(isName) ? parts.join('/') : null
}

export function prHostOf(
  remote: string | null,
  setting: Settings['prHost'],
): 'github' | 'azure-repos' | null {
  if (setting !== 'auto') return setting
  const host = remote === null ? null : hostOf(remote)
  if (host === null) return null
  if (host === 'github.com') return 'github'
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com')) {
    return 'azure-repos'
  }

  return null
}

// What to tell the person when the tool (`gh` or `az`) could not answer, or
// null when it is nothing they can fix (a branch with no pull request, an
// item that is gone).
export function toolNote(result: RunResult | null, tool: 'gh' | 'az' = 'gh'): string | null {
  if (result === null) return null
  if ('failed' in result) {
    return result.failed === 'timeout' ? `${tool} did not answer in time` : `${tool} could not start. Is it installed?`
  }
  if (result.exitCode === 0) return null
  if (tool === 'gh') return result.stderr.includes('gh auth login') ? 'gh is not logged in. Run: gh auth login' : null
  // `az` with no `azure-devops` extension does not know the command.
  if (/is misspelled or not recognized/.test(result.stderr) || (result.stderr.includes('azure-devops') && result.stderr.includes('extension'))) {
    return 'az has no azure-devops extension. Run: az extension add --name azure-devops'
  }

  return result.stderr.includes('az login') ? 'az is not logged in. Run: az login' : null
}
