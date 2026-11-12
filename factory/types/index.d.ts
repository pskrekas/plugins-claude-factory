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

// One factory job, as the pane draws it.
export type JobStage =
  | 'intake'
  | 'needs-info'
  | 'spec'
  | 'build'
  | 'gate'
  | 'review'
  | 'approve'
  | 'needs-human'
  | 'ready'
  | 'done'
  | 'rejected'

export type JobView = {
  itemId: string
  title: string
  stage: JobStage
  stoppedIn: JobStage | null
  round: number
  maxRounds: number
  sentBack: { by: 'gate' | 'review' | 'approve' | 'you'; why: string } | null
  question: string | null
  prNumber: number | null
  minutes: number
  costUsd: number | null
}

export type FactoryView = {
  // Some of the running jobs, then some of the waiting ones; at most 20.
  jobs: JobView[]
  // The jobs at each station, of all jobs: Queue, Intake … Approve, You.
  counts: number[]
  // How many jobs run and how many wait for the person, of all jobs.
  running: number
  waiting: number
  // Running and waiting jobs that are not in `jobs`.
  moreRunning: number
  moreWaiting: number
  // Items that carry the mark; null when it is not known.
  queue: number | null
  slots: number
  today: { done: number; minutes: number; costUsd: number | null; firstRound: number; finished: number }
  note: string | null
  // Who runs the line: this session, another one, or nobody.
  lock: 'free' | 'mine' | 'theirs'
  // Where the other session is; null unless `lock` is `theirs`.
  holder: string | null
  // The line starts no new station.
  isStopped: boolean
  // Items the tracker says are in progress that have no job here; at most 10.
  // They count in `waiting` and at the last station.
  claimed: string[]
  // The rows of the last dry run (`/factory plan`): what Intake said of each item; at most 10.
  plan: {
    itemId: string
    verdict: 'running' | 'accept' | 'needs-info' | 'reject' | 'failed'
    risk: 'low' | 'medium' | 'high' | null
    note: string
  }[]
}

// none = the repo has no settings file
export type Consent = 'none' | 'needed' | 'approved'

export type PanelModel = {
  // The repo this model was read for: its commands are approved for it only.
  root: string | null
  consent: Consent
  pendingCommands: string[]
  // The pending command lines the person was shown: by the open pane, or by
  // the answer of /factory approve. Only these can be approved.
  shown: string[]
  settingsError: string | null
  task: TaskState | null
  // The factory line; null when there is nothing to show.
  factory: FactoryView | null
  progress: ProgressState[]
  // Progress files that exist and are not listed (only the newest are).
  progressMore: number
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
