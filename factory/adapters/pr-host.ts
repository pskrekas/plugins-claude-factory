// The contract every pull request host offers (design 7.4). The line uses
// only these actions. There is no action that merges: the factory never
// merges, on any host.
import type { PrState } from '../core/model'
import type { RunResult } from '../core/run'

export interface PrHost {
  kind: 'github' | 'azure-repos'
  // A draft pull request from a job's branch. Nothing runs for a head that is not `factory/<job id>`.
  open(pr: { head: string; base: string; title: string; body: string }): Promise<{ pr: { number: number; url: string } | null; result: RunResult }>
  ready(number: number): Promise<RunResult>
  read(number: number): Promise<{ pr: PrState | null; result: RunResult }>
  // The pull request of a branch, for the panel.
  current(branch: string): Promise<{ pr: PrState | null; result: RunResult }>
  comment(number: number, markdown: string): Promise<RunResult>
  // Closes the pull request of a job that a person dropped. Never a merge.
  close(number: number): Promise<RunResult>
}
