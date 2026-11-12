// A container for a job, and one for a gate run (design 8.3). Every docker
// call comes from core/container-args.ts. What an agent wrote runs only
// inside a container: a builder's command as the one argument of `sh -c`
// there, a gate's command as an argument list there.
import { failureText } from '../core/comment'
import { containerName, dockerArgs } from '../core/container-args'
import type { DockerCall } from '../core/container-args'
import type { ContainerSpec } from '../core/factory-settings'
import { isJobId } from '../core/job'
import type { RunResult } from '../core/run'
import type { Io } from './io'
import { stateDirOf } from './jobs'

const DOCKER_MS = 60_000
const MAX_TEXT = 30_000
const NOT_HERE = 'docker is not on this machine'
const NO_ANSWER = 'docker does not answer. Start Docker, then run the command again.'

// Runs one call. Null when the call itself breaks a rule: nothing ran.
async function docker(io: Io, call: DockerCall, timeoutMs = DOCKER_MS): Promise<RunResult | null> {
  const argv = dockerArgs(call)

  return argv === null ? null : io.run(argv, { timeoutMs })
}

const passed = (result: RunResult | null): result is { exitCode: number; stdout: string; stderr: string } =>
  result !== null && !('failed' in result) && result.exitCode === 0

// Whether docker answers and holds the image. The plugin fetches no image:
// the one line says what the person does.
export async function dockerState(io: Io, image: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const result = await docker(io, { do: 'image', image })
  if (result === null) return { ok: false, why: 'not an image name' }
  if ('failed' in result) return { ok: false, why: result.failed === 'not-found' ? NOT_HERE : NO_ANSWER }
  if (result.exitCode === 0) return { ok: true }

  return { ok: false, why: /no such image/i.test(result.stderr) ? `the image ${image} is not on this machine. Run: docker pull ${image}` : NO_ANSWER }
}

// The person's user id and group id, so files in the mounted folder stay the person's.
async function userOf(io: Io): Promise<string | null> {
  const [uid, gid] = await Promise.all([io.run(['id', '-u'], { timeoutMs: 5_000 }), io.run(['id', '-g'], { timeoutMs: 5_000 })])
  if (!passed(uid) || !passed(gid)) return null
  const user = `${uid.stdout.trim()}:${gid.stdout.trim()}`

  return /^\d{1,10}:\d{1,10}$/.test(user) ? user : null
}

// The container of a job (over its worktree) or of a gate run (over the
// gate's clean copy). One that runs is used again; one that does not is
// removed and made again.
export async function ensureContainer(
  io: Io,
  root: string,
  jobId: string,
  kind: 'job' | 'gate',
  spec: ContainerSpec,
): Promise<{ ok: true; name: string; folder: string } | { ok: false; why: string }> {
  const dir = await stateDirOf(io, root)
  const there = dir === null || !isJobId(jobId) ? null : await io.stat(`${dir}/${kind === 'job' ? 'worktrees' : 'gate'}/${jobId}`)
  if (dir === null || there === null || there.kind !== 'dir') return { ok: false, why: 'the job has no folder' }
  const folder = there.realPath
  // The label is the name of this repository's state folder: it is in the
  // container's name, and a sweep finds its own containers by it.
  const label = dir.slice(dir.lastIndexOf('/') + 1)
  const name = containerName(kind, jobId, label)
  if (name === null) return { ok: false, why: 'the job has no folder' }
  const running = await docker(io, { do: 'running', name })
  if (passed(running) && running.stdout.trim() === 'true') return { ok: true, name, folder }
  if (running !== null && 'failed' in running) return { ok: false, why: running.failed === 'not-found' ? NOT_HERE : NO_ANSWER }
  await docker(io, { do: 'remove', name })
  const user = await userOf(io)
  if (user === null) return { ok: false, why: 'the user id could not be read' }
  // The folder's `.git` file is git's own (a job's worktree, the gate's copy): it is read-only inside.
  const gitFile = await io.stat(`${folder}/.git`)
  const made = await docker(io, { do: 'make', name, spec, folder, user, label, hasGitFile: gitFile !== null && gitFile.kind === 'file' })
  if (passed(made)) return { ok: true, name, folder }

  return { ok: false, why: made === null ? 'the container settings are not usable' : failureText('docker', made) }
}

// The end of a stream, with nothing in it that moves a terminal's cursor.
const tail = (text: string, max: number) => text.slice(-max).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

// Runs one command of the builder inside the job's container. The answer is
// text for the agent: the exit code, then the end of what the command printed.
export async function runShell(
  io: Io,
  name: string,
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<{ text: string; exitCode: number | null }> {
  const result = await docker(io, { do: 'shell', name, cwd, command }, timeoutMs)
  if (result === null) return { text: 'The command was not run: it is empty or too long.', exitCode: null }
  if ('failed' in result) {
    if (result.failed === 'timeout') return { text: `The command did not end in ${Math.round(timeoutMs / 1000)} s. It was left; what it printed is lost.`, exitCode: null }

    return { text: `The command could not start: ${result.failed === 'not-found' ? NOT_HERE : 'docker does not answer'}.`, exitCode: null }
  }
  const { stdout, stderr } = result
  const isLong = stdout.length + stderr.length > MAX_TEXT
  const body = stderr === '' ? tail(stdout, MAX_TEXT) : stdout === '' ? tail(stderr, MAX_TEXT) : `${tail(stdout, (MAX_TEXT * 2) / 3)}[stderr]\n${tail(stderr, MAX_TEXT / 3)}`
  const notes = [isLong ? '[the start of the output is cut]\n' : '', result.isCut === true ? '[the end of the output is missing: the command printed more than is kept]\n' : ''].join('')

  return { text: `exit ${result.exitCode}\n${notes}${body}`, exitCode: result.exitCode }
}

// Runs one command of the gate inside the gate's container, as an argument list.
export async function runArgv(io: Io, name: string, cwd: string, argv: string[], timeoutMs: number): Promise<RunResult> {
  return (await docker(io, { do: 'argv', name, cwd, argv }, timeoutMs)) ?? { failed: 'other' }
}

export async function removeContainer(io: Io, name: string): Promise<void> {
  await docker(io, { do: 'remove', name })
}

// Removes every container of this repository's factory whose name is not in
// `keep`: the ones a crash, a closed session or a job that ended left behind.
export async function sweepContainers(io: Io, root: string, keep: string[]): Promise<number> {
  const dir = await stateDirOf(io, root)
  const label = dir === null ? '' : dir.slice(dir.lastIndexOf('/') + 1)
  const listed = dir === null ? null : await docker(io, { do: 'list', label })
  if (!passed(listed)) return 0
  let removed = 0
  for (const name of listed.stdout.split('\n').map(line => line.trim())) {
    // Only a name of this repository's factory; `dockerArgs` refuses a name that is not one of the factory's.
    if (name === '' || keep.includes(name) || !name.endsWith(`.${label}`) || dockerArgs({ do: 'remove', name }) === null) continue
    await removeContainer(io, name)
    removed += 1
  }

  return removed
}
