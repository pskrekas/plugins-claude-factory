// The engine, as the readers and the refresh loop see it. The engine's own
// handle (`$`) may only be used as `$.noun.event(...)` inside a hook: it cannot
// be passed to another function. So register.tsx builds this set of plain
// functions inside its `session.start` hook, and everything else takes an Io.
import type { AgentInfo } from 'claude-code'

import type { PanelModel } from '../core/model'
import type { RunResult } from '../core/run'

export type Io = {
  now: () => Promise<number>
  // The top of the working tree the session is in (a linked worktree's own
  // folder, not the main checkout's), or the session's folder outside git.
  root: () => Promise<string>
  remote: () => Promise<string | null>
  // This session's id: what the lock file names its holder by.
  sessionId: () => Promise<string>
  // The folder of the person's own where the factory keeps its state, or null
  // when there is no home folder. Never a folder of the repo.
  stateDir: () => Promise<string | null>
  // What a path is, how large, and where it really is once every symbolic
  // link is followed; null when there is nothing there.
  stat: (
    path: string,
  ) => Promise<{ kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; realPath: string } | null>
  // True when the path itself is a symbolic link (also one that leads nowhere).
  isLink: (path: string) => Promise<boolean>
  // A file's text, or null when it cannot be read.
  readFile: (path: string) => Promise<string | null>
  // The names in a directory (folders end with '/'), or [] when it cannot be listed.
  listDir: (path: string) => Promise<string[]>
  writeFile: (path: string, text: string) => Promise<void>
  // Runs a host command. Never rejects.
  run: (argv: string[], init?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  getModel: () => Promise<PanelModel>
  // Applies `change` to the stored model in one step and answers the result.
  updateModel: (change: (model: PanelModel) => PanelModel) => Promise<PanelModel>
  status: (text: string | undefined) => void
  toast: (text: string) => void
  sound: () => void
  agents: () => Promise<readonly AgentInfo[]>
  // True only when the pane is on screen: placed, and the tab the surface
  // shows. A pane that waits undrawn, or sits behind another, shows nothing.
  isPaneDrawn: () => Promise<boolean>
}
