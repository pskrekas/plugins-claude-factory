// The gate's judgement: which changed files are protected, which are tests or
// test settings, and what a run of the checks comes to. Pure.

const MAX_TAIL = 4_000
const MAX_TEST_FILES = 50
const TEST_FOLDERS = ['test', 'tests', '__tests__', 'spec']
const TEST_NAME = /\.(test|spec)\.[a-z]+$/
const SETTINGS_NAMES = [
  /^package\.json$/,
  /^pyproject\.toml$/,
  /^pytest\.ini$/,
  /^Makefile$/,
  /^jest\.config\./,
  /^vitest\.config\./,
  /^tsconfig.*\.json$/,
]

// A changed file is protected when it is a protected path, or under one that ends with `/`.
export function protectedHits(changed: string[], protectedPaths: string[]): string[] {
  const isProtected = (file: string) =>
    protectedPaths.some(path => file === path || (path.endsWith('/') && file.startsWith(path)))

  return changed.filter(isProtected).sort()
}

// The changed files a reviewer and the person should look at twice: tests, and
// the settings of the test and build tools. A branch that weakens these can
// pass a gate it should fail; the gate cannot judge that, a reader can.
export function testFilesOf(changed: string[]): string[] {
  const isTest = (file: string) => {
    const parts = file.split('/')
    const name = parts[parts.length - 1] ?? ''

    return (
      parts.slice(0, -1).some(part => TEST_FOLDERS.includes(part)) ||
      TEST_NAME.test(name) ||
      SETTINGS_NAMES.some(pattern => pattern.test(name))
    )
  }

  return changed.filter(isTest).sort().slice(0, MAX_TEST_FILES)
}

// One command of the gate, as it ended. `tail` is the end of what it printed.
export type CheckRun = {
  line: string
  exitCode: number | null
  failed: 'timeout' | 'not-found' | 'other' | null
  tail: string
  ms: number
}

// The end of a command's output: its last characters, with nothing in it that
// can move a terminal's cursor or close the block it is shown in.
export function tailOf(text: string): string {
  return text
    .slice(-MAX_TAIL)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/```/g, "'''")
}

const whyOf = (run: CheckRun): string | null => {
  if (run.failed === 'timeout') return `${run.line} timed out`
  if (run.failed === 'not-found') return `${run.line} was not found`

  return run.failed !== null || run.exitCode !== 0 ? `${run.line} failed` : null
}

export function gateReport(g: {
  which: 'fast' | 'full'
  round: number
  runs: CheckRun[]
  protectedHits: string[]
  testFiles: string[]
}): { pass: boolean; why: string | null; markdown: string } {
  const firstFailure = g.runs.map(whyOf).find(why => why !== null) ?? null
  const why =
    g.protectedHits.length > 0
      ? `protected path: ${g.protectedHits[0]}`
      : (firstFailure ?? (g.runs.length === 0 ? 'no command ran' : null))
  const pass = why === null
  const seconds = (ms: number) => `${Math.round(ms / 1000)} s`
  const ended = (run: CheckRun) => (run.exitCode === null ? (run.failed ?? 'failed') : `exit ${run.exitCode}`)

  const lines = [
    '## Summary',
    `- The ${g.which} gate of round ${g.round} ${pass ? 'passed' : `failed: ${why}`}.`,
    `- Commands run: ${g.runs.length === 0 ? 'none' : g.runs.map(run => run.line).join('; ')}.`,
    `- Protected paths changed: ${g.protectedHits.length === 0 ? 'none' : g.protectedHits.join(', ')}.`,
    `- Test and settings files changed: ${g.testFiles.length}.`,
    '',
  ]
  for (const run of g.runs) {
    lines.push(`## ${run.line} (${ended(run)}, ${seconds(run.ms)})`, '```text', tailOf(run.tail), '```', '')
  }
  if (g.testFiles.length > 0) {
    lines.push('## Test and settings files changed', ...g.testFiles.map(file => `- ${file}`), '')
  }

  return { pass, why, markdown: lines.join('\n') }
}
