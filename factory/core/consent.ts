// The approval rule for the commands a repo's settings file names (design 8.1).
// The store holds the full list of approved command lines, never a digest of
// it: a command runs only if its exact line is in that list.
import type { Consent } from './model'

export function storeKey(repoRoot: string): string {
  return 'consent:' + repoRoot
}

// The approved lines in what the store gave back, or none if it is anything
// but a list of strings.
export function approvedOf(stored: unknown): string[] {
  return Array.isArray(stored) && stored.every(line => typeof line === 'string') ? stored : []
}

export function consentOf(hasFile: boolean, commands: string[], stored: unknown): Consent {
  if (!hasFile) return 'none'
  const approved = new Set(approvedOf(stored))

  return commands.every(line => approved.has(line)) ? 'approved' : 'needed'
}
