// How a host command ended, as the readers see it. A command that could not
// start, or ran past its time, is a value, never a thrown error.
export type RunResult =
  | { exitCode: number; stdout: string; stderr: string }
  | { failed: 'timeout' | 'not-found' | 'other' }

// Names why a `$.process.run` call rejected.
export function failureOf(error: unknown): RunResult {
  const text = String(error instanceof Error ? error.message : error).toLowerCase()
  if (text.includes('enoent') || text.includes('not found')) return { failed: 'not-found' }
  if (text.includes('timeout') || text.includes('timed out') || text.includes('still running')) {
    return { failed: 'timeout' }
  }

  return { failed: 'other' }
}
