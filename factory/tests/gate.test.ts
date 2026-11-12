import { expect, test } from 'claude-code/testing'

import { storeKey } from '../core/consent'
import { FACTORY_DEFAULTS } from '../core/factory-settings'
import { gateReport, protectedHits, testFilesOf } from '../core/gate'
import type { CheckRun } from '../core/gate'
import { newJob } from '../core/job'
import { stateFolderOf } from '../core/state-path'
import { runGate } from '../hooks/gate'
import { fakeIo } from './kit'

test('which changed files are protected', async () => {
  const protectedPaths = ['.claude/factory.json', '.github/']
  expect(protectedHits(['.claude/factory.json', 'src/a.ts', '.github/workflows/ci.yml'], protectedPaths)).toEqual([
    '.claude/factory.json',
    '.github/workflows/ci.yml',
  ])
  expect(protectedHits(['.github-notes.md', 'src/.claude/factory.json', '.github'], protectedPaths)).toEqual([])
  expect(protectedHits(['a'], [])).toEqual([])
})

test('which changed files are tests or test and build settings', async () => {
  const changed = ['src/a.ts', 'src/a.test.ts', 'tests/x.py', 'package.json', 'docs/spec.md', 'spec/y.rb', 'app/__tests__/z.js', 'tsconfig.build.json', 'jest.config.ts', 'Makefile', 'src/latest.ts']
  expect(testFilesOf(changed)).toEqual([
    'Makefile',
    'app/__tests__/z.js',
    'jest.config.ts',
    'package.json',
    'spec/y.rb',
    'src/a.test.ts',
    'tests/x.py',
    'tsconfig.build.json',
  ])
  expect(testFilesOf(Array.from({ length: 80 }, (_, i) => `tests/t${i}.py`)).length).toBe(50)
})

const run = (line: string, over: Partial<CheckRun> = {}): CheckRun => ({ line, exitCode: 0, failed: null, tail: 'ok', ms: 1200, ...over })
const report = (runs: CheckRun[], hits: string[] = [], files: string[] = []) =>
  gateReport({ which: 'fast', round: 2, runs, protectedHits: hits, testFiles: files })

test('the gate passes only when every command exits 0 and no protected path changed', async () => {
  expect(report([run('npm run lint'), run('npm test')])).toEqual(expect.objectContaining({ pass: true, why: null }))
  expect(report([run('npm run lint'), run('npm test', { exitCode: 1 })]).why).toBe('npm test failed')
  expect(report([run('npm test', { exitCode: null, failed: 'timeout' })]).why).toBe('npm test timed out')
  expect(report([run('npm test', { exitCode: null, failed: 'not-found' })]).why).toBe('npm test was not found')
  expect(report([run('npm test', { exitCode: null, failed: 'other' })]).why).toBe('npm test failed')
  const hit = report([run('npm test')], ['.claude/factory.json'])
  expect([hit.pass, hit.why]).toEqual([false, 'protected path: .claude/factory.json'])
  expect(report([]).pass).toBe(false)
})

test('the report: a short summary first, then each run with its last output', async () => {
  const noisy = 'x'.repeat(50_000) + '\u001b[2J```end'
  const { markdown } = report([run('npm run lint'), run('npm test', { exitCode: 1, tail: noisy })], [], ['src/a.test.ts'])
  const lines = markdown.split('\n')
  expect(lines[0]).toBe('## Summary')
  expect(lines[1]).toBe('- The fast gate of round 2 failed: npm test failed.')
  const summary = lines.slice(1, lines.indexOf('', 1))
  expect(summary.length).toBeGreaterThanOrEqual(3)
  expect(summary.length).toBeLessThanOrEqual(5)
  expect(markdown).toContain('## npm test (exit 1, 1 s)')
  expect(markdown).toContain('- src/a.test.ts')
  expect(/[\u0000-\u0008\u000b-\u001f]/.test(markdown)).toBe(false)
  // The run's output is cut to its last 4,000 characters and cannot close its own block.
  const block = markdown.slice(markdown.indexOf('## npm test'))
  expect(block.length).toBeLessThan(4400)
  expect(block.split('```').length).toBe(3)
  expect(report([run('npm test')]).markdown.split('\n')[1]).toBe('- The fast gate of round 2 passed.')
})

const SETTINGS = JSON.stringify({ gate: { fast: [['npm', 'run', 'lint'], ['npm', 'test']], full: [['npm', 'run', 'build']] } })
const APPROVED = ['[gate] npm run build', '[gate] npm run lint', '[gate] npm test']
const job = { ...newJob({ id: '12', title: 'Add dark mode' }, 1000), stage: 'gate' as const, branch: 'factory/12-add-dark-mode' }
const DIR = '/state/' + stateFolderOf('/r')
const WT = `${DIR}/worktrees/${job.id}`

function gateIo(answers: Record<string, { exitCode: number; stdout?: string; stderr?: string }>, approved = APPROVED) {
  const io = fakeIo({ files: { '/r/x': '' } })
  io.store.set(storeKey('/r'), approved)
  io.answer = argv => {
    const line = argv.join(' ')
    if (line.startsWith('git show')) return { exitCode: 0, stdout: SETTINGS }
    const key = Object.keys(answers).find(start => line.startsWith(start))
    const hit = key === undefined ? undefined : answers[key]

    return hit === undefined ? undefined : { exitCode: hit.exitCode, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
  }

  return io
}

test('a gate that passes: both commands run in the worktree and the report is written', async () => {
  const io = gateIo({ 'git diff': { exitCode: 0, stdout: 'src/a.ts\0' }, 'npm run lint': { exitCode: 0 }, 'npm test': { exitCode: 0, stdout: '412 passed' } })

  expect(await runGate(io, '/r', job, 'main', FACTORY_DEFAULTS, 'fast')).toEqual({ pass: true, why: null, needsPerson: false })
  const commands = io.ran.filter(line => line.startsWith('npm'))
  expect(commands).toEqual(['npm run lint', 'npm test'])
  expect(io.cwds[io.ran.indexOf('npm test')]).toBe(WT)
  const text = io.files[`${DIR}/jobs/${job.id}/files/round-1/checks.md`] ?? ''
  expect(text.startsWith('## Summary\n- The fast gate of round 1 passed.')).toBe(true)
  expect(text).toContain('412 passed')
})

test('the first command that fails stops the gate', async () => {
  const io = gateIo({ 'git diff': { exitCode: 0, stdout: 'src/a.ts\0' }, 'npm run lint': { exitCode: 2, stderr: 'lint error' }, 'npm test': { exitCode: 0 } })

  expect(await runGate(io, '/r', job, 'main', FACTORY_DEFAULTS, 'fast')).toEqual({ pass: false, why: 'npm run lint failed', needsPerson: false })
  expect(io.ran.filter(line => line.startsWith('npm'))).toEqual(['npm run lint'])
  expect(io.files[`${DIR}/jobs/${job.id}/files/round-1/checks.md`]).toContain('lint error')
})

test('a branch that changed a protected path runs no command and needs a person', async () => {
  const io = gateIo({ 'git diff': { exitCode: 0, stdout: 'src/a.ts\0.claude/factory.json\0' }, 'npm': { exitCode: 0 } })

  expect(await runGate(io, '/r', job, 'main', FACTORY_DEFAULTS, 'fast')).toEqual({
    pass: false,
    why: 'protected path: .claude/factory.json',
    needsPerson: true,
  })
  expect(io.ran.some(line => line.startsWith('npm'))).toBe(false)
  expect(io.files[`${DIR}/jobs/${job.id}/files/round-1/checks.md`]).toContain('.claude/factory.json')
})

test('gate commands that are not approved run nothing and need a person', async () => {
  const io = gateIo({ 'git diff': { exitCode: 0, stdout: '' }, 'npm': { exitCode: 0 } }, ['npm test'])

  expect(await runGate(io, '/r', job, 'main', FACTORY_DEFAULTS, 'fast')).toEqual({
    pass: false,
    why: 'gate commands are not approved',
    needsPerson: true,
  })
  expect(io.ran.some(line => line.startsWith('npm'))).toBe(false)
})

test('the full gate writes its own report; a git that cannot list the changes needs a person', async () => {
  const io = gateIo({ 'git diff': { exitCode: 0, stdout: 'src/a.ts\0' }, 'npm run build': { exitCode: 0 } })
  expect((await runGate(io, '/r', { ...job, round: 2 }, 'main', FACTORY_DEFAULTS, 'full')).pass).toBe(true)
  expect(io.files[`${DIR}/jobs/${job.id}/files/round-2/merge-checks.md`]).toContain('The full gate of round 2 passed.')

  const blind = gateIo({ 'git diff': { exitCode: 128, stderr: 'bad revision' } })
  expect(await runGate(blind, '/r', job, 'main', FACTORY_DEFAULTS, 'fast')).toEqual({
    pass: false,
    why: 'the changed files could not be listed',
    needsPerson: true,
  })
})

test('a command that hangs or cannot start is a failure, not a hang of the job', async () => {
  const io = gateIo({ 'git diff': { exitCode: 0, stdout: 'src/a.ts\0' } })
  // No answer for `npm`: the fake says the program was not found.
  expect(await runGate(io, '/r', job, 'main', FACTORY_DEFAULTS, 'fast')).toEqual({
    pass: false,
    why: 'npm run lint was not found',
    needsPerson: false,
  })
})
