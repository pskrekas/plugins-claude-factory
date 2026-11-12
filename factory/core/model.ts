// The model's types live in the state contract (types/index.d.ts).
import type { PanelModel } from '../types'

export type {
  AgentRow,
  CheckState,
  Consent,
  PanelModel,
  PortState,
  PrState,
  ProgressState,
  TaskState,
  WorktreeRow,
} from '../types'

export function emptyModel(): PanelModel {
  return {
    root: null,
    consent: 'none',
    pendingCommands: [],
    shown: [],
    settingsError: null,
    task: null,
    progress: [],
    progressMore: 0,
    agents: [],
    checks: [],
    ports: [],
    worktrees: [],
    owed: null,
    notes: [],
    readAt: null,
  }
}
