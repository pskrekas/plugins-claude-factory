// The first .claude/factory.json that `/factory init` writes for a repo. Pure.
import { azPlaceOf } from './azure'
import { prHostOf } from './task'

export type RepoFacts = {
  remote: string | null
  baseBranch: string | null
  packageJson: string | null
  hasPyproject: boolean
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

// The scripts a package.json has, or none when it cannot be read.
function scriptsOf(packageJson: string | null): Record<string, unknown> {
  if (packageJson === null) return {}
  try {
    const parsed: unknown = JSON.parse(packageJson)
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts

    return typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function gateOf(facts: RepoFacts): { fast: string[][]; full: string[][] } {
  const scripts = scriptsOf(facts.packageJson)
  const fast: string[][] = []
  const full: string[][] = []
  if (typeof scripts.lint === 'string') {
    fast.push(['npm', 'run', 'lint'])
    full.push(['npm', 'run', 'lint'])
  }
  if (typeof scripts.test === 'string') {
    fast.push(['npm', 'test'])
    full.push(['npm', 'test'])
  }
  if (typeof scripts.build === 'string') full.push(['npm', 'run', 'build'])
  // The gate runs in a clean copy of the commit, which holds no installed
  // packages: the install is the first command of each list.
  for (const list of [fast, full]) if (list.length > 0) list.unshift(['npm', 'install'])
  if (fast.length === 0 && full.length === 0 && facts.hasPyproject) {
    fast.push(['python3', '-m', 'pytest', '-q'])
    full.push(['python3', '-m', 'pytest', '-q'])
  }

  return { fast, full }
}

// The JSON text of a first settings file: 2-space indent, a newline at the end.
// The person reads it and edits it; nothing in it runs before they approve it.
export function draftSettings(facts: RepoFacts): string {
  const isGitHub = prHostOf(facts.remote, 'auto') === 'github'
  const place = azPlaceOf(facts.remote)
  // The container the builder's and the gate's commands run in: an image with
  // the repo's kind of tools. For any other repo the person names one.
  const image = facts.packageJson !== null && Object.keys(scriptsOf(facts.packageJson)).length > 0 ? 'node:22' : facts.hasPyproject ? 'python:3.12' : null
  const draft = {
    ...(isGitHub ? { tracker: { kind: 'github', mark: 'factory' } } : {}),
    // Azure DevOps: the work items of the remote's own project.
    ...(place !== null ? { tracker: { kind: 'azure-boards', mark: 'factory', project: place.project } } : {}),
    baseBranch: facts.baseBranch !== null && BRANCH.test(facts.baseBranch) ? facts.baseBranch : 'main',
    gate: gateOf(facts),
    ...(image === null ? {} : { factory: { container: { image } } }),
    checks: [{ name: 'disk', minFreeGb: 10 }],
    progress: { files: 'docs/plans/*/progress.md' },
    owed: '.claude/owed.md',
  }

  return JSON.stringify(draft, null, 2) + '\n'
}
