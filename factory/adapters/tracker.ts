// The contract every tracker adapter offers (design 7.1): the five actions,
// and the three things the line asks beside them (the queue with the items
// the tracker says are in progress, whether an item carries the mark, who
// runs the line). The line uses only these.
import type { RunResult } from '../core/run'

export type TrackerState = 'in-progress' | 'needs-human' | 'done' | 'rejected'

export type TrackerItem = {
  id: string
  title: string
  state: string
  text: string
  author: string
  url: string
  comments: { author: string; text: string }[]
}

// Runs one host command for an adapter. Never rejects. `stdin` is the
// program's standard input: text that came from outside goes there, never
// into an argument.
export type Run = (argv: string[], stdin?: string) => Promise<RunResult>

export type Listed = Pick<TrackerItem, 'id' | 'title' | 'state'>

export interface Tracker {
  kind: 'github' | 'azure-boards' | 'mcp'
  // The queue (`items`: marked, open, not taken by the line) and the items
  // the tracker says are in progress (`claimed`). `items` is null when the
  // list could not be read; `result` is the command's result, for a note.
  // `note` is the adapter's own reason, for a tracker that runs no command.
  scan(): Promise<{ items: Listed[] | null; claimed: Listed[]; result: RunResult | null; note?: string | null }>
  // The queue; empty when it could not be read.
  list(mark: string): Promise<Listed[]>
  // True when the item carries the mark. Only a marked item runs.
  hasMark(id: string): Promise<boolean>
  // The person who runs the line, as the tracker names an author; null when it is not known.
  me(): Promise<string | null>
  // `withComments: false` reads the item alone (the panel shows no comment).
  read(id: string, withComments?: boolean): Promise<TrackerItem | null>
  comment(id: string, markdown: string): Promise<void>
  setState(id: string, state: TrackerState): Promise<void>
  linkPr(id: string, url: string): Promise<void>
  // The reason of the adapter's last reading call that failed, or null. Fixed
  // words or a tool's own error line, cut: never text of an item. Only a
  // tracker that runs no command gives one (as `scan().note`).
  why?: () => string | null
}
