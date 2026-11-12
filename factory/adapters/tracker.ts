// The contract every tracker adapter offers (design 7.1). The core uses only
// these five actions. This phase implements `read` for GitHub Issues.
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

export interface Tracker {
  list(mark: string): Promise<Pick<TrackerItem, 'id' | 'title' | 'state'>[]>
  read(id: string): Promise<TrackerItem | null>
  comment(id: string, markdown: string): Promise<void>
  setState(id: string, state: TrackerState): Promise<void>
  linkPr(id: string, url: string): Promise<void>
}
