// The plugin's state contract. It must be self-contained (no import).
// PanelModel is the one value the pane draws from: readers fill it,
// core/layout.ts turns it into rows.

export type CheckState = {
  name: string
  state: 'ok' | 'wrong' | 'error' | 'unknown'
  got?: string
}

export type PortState = { name: string; port: number; state: 'up' | 'down' | 'unknown' }

export type ProgressState = {
  name: string
  path: string
  done: number
  open: number
  percent: number | null
  blocked: string | null
}

export type PrState = {
  number: number
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  build: 'green' | 'red' | 'running' | 'none'
  approvals: number
  url: string
}

export type TaskState = {
  id: string | null
  branch: string
  title: string | null
  state: string | null
  pr: PrState | null
  note: string | null
}

export type AgentRow = {
  id: string
  label: string
  kind: string | null
  isRunning: boolean
  startedAt: number | null
}

export type WorktreeRow = { path: string; branch: string | null; isMerged: boolean }

// none = the repo has no settings file
export type Consent = 'none' | 'needed' | 'approved'

export type PanelModel = {
  // The repo this model was read for: its commands are approved for it only.
  root: string | null
  consent: Consent
  pendingCommands: string[]
  settingsError: string | null
  task: TaskState | null
  progress: ProgressState[]
  agents: AgentRow[]
  checks: CheckState[]
  ports: PortState[]
  worktrees: WorktreeRow[]
  owed: { open: number } | null
  notes: string[]
  readAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    factory: { panel: Shaped<PanelModel> }
  }
}
