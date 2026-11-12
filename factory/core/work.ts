// Worktrees and agents, as the panel lists them. Pure.
import type { AgentInfo } from 'claude-code'

import type { AgentRow, WorktreeRow } from './model'

const MAX_LABEL = 40
const MAX_ENDED = 3
const RUNNING: readonly string[] = ['pending', 'running', 'waiting']

// `git worktree list --porcelain`: one block per worktree.
export function parseWorktrees(
  porcelain: string,
  mergedBranches: string[],
  baseBranch: string,
): WorktreeRow[] {
  const rows: WorktreeRow[] = []
  for (const block of porcelain.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (path === undefined) continue
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null
    const isMerged = branch !== null && branch !== baseBranch && mergedBranches.includes(branch)
    rows.push({ path, branch, isMerged })
  }

  return rows
}

// `git branch --merged <base>`: one branch per line, with or without git's marks.
export function parseMerged(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.replace(/^[*+]?\s*/, '').trim())
    .filter(line => line !== '')
}

// Running agents first, then a few that ended. An agent keeps the time it was
// first seen, so its clock does not start again at every read.
export function agentRows(
  agents: readonly AgentInfo[],
  before: readonly AgentRow[],
  now: number,
): AgentRow[] {
  const rows = agents.map(agent => ({
    id: agent.id,
    label: (agent.description || agent.name || agent.type || 'agent').slice(0, MAX_LABEL),
    kind: agent.type || null,
    isRunning: RUNNING.includes(agent.status),
    startedAt: before.find(row => row.id === agent.id)?.startedAt ?? now,
  }))

  return [
    ...rows.filter(row => row.isRunning),
    ...rows.filter(row => !row.isRunning).slice(0, MAX_ENDED),
  ]
}
