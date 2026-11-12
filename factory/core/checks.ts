// Judges the result of an environment check, the free disk space and a port. Pure.
import type { CheckState, PortState } from './model'
import type { RunResult } from './run'
import type { CheckSpec } from './settings'

const MAX_GOT = 200 // a command can print megabytes: only this much is kept

const FAILED = { timeout: 'timeout', 'not-found': 'not found', other: 'failed' } as const

export function judgeCheck(spec: CheckSpec, result: RunResult): CheckState {
  if ('failed' in result) return { name: spec.name, state: 'error', got: FAILED[result.failed] }
  if (spec.want !== undefined) {
    const got = result.stdout.trim()
    if (got === spec.want) return { name: spec.name, state: 'ok' }

    return { name: spec.name, state: 'wrong', got: got.slice(0, MAX_GOT) || '(nothing)' }
  }
  if (result.exitCode === 0) return { name: spec.name, state: 'ok' }

  return { name: spec.name, state: 'wrong', got: `exit ${result.exitCode}` }
}

// POSIX `df -Pk <path>`: the 4th column of the last line is the free space in KiB.
export function parseDfFreeGb(stdout: string): number | null {
  const lines = stdout.trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  const free = Number(last.trim().split(/\s+/)[3])
  if (lines.length < 2 || !Number.isFinite(free)) return null

  return Math.round((free / (1024 * 1024)) * 10) / 10
}

export function judgeDisk(spec: CheckSpec, freeGb: number | null): CheckState {
  if (freeGb === null) return { name: spec.name, state: 'unknown' }
  if (freeGb >= (spec.minFreeGb ?? 0)) return { name: spec.name, state: 'ok' }

  return { name: spec.name, state: 'wrong', got: `${freeGb} GB free` }
}

// `nc -z` exits 0 when something listens on the port.
export function judgePort(name: string, port: number, result: RunResult): PortState {
  if ('failed' in result) return { name, port, state: 'unknown' }

  return { name, port, state: result.exitCode === 0 ? 'up' : 'down' }
}

const FALLBACK_PATH = '/usr/bin:/bin'

// The PATH a command of the plugin runs with: the person's own, less every
// entry that is relative (".", "bin", an empty one) or inside the repo. So a
// program name is never found in the repo itself.
export function safePath(path: string | undefined, root: string): string {
  const base = root.replace(/\/+$/, '')
  const kept = (path ?? '')
    .split(':')
    .filter(entry => entry.startsWith('/') && entry !== base && !entry.startsWith(base + '/'))

  return kept.length > 0 ? kept.join(':') : FALLBACK_PATH
}
