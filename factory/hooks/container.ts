// A container for each command of a builder, and one for a gate run (design
// 8.3). Every docker call comes from core/container-args.ts. What an agent
// wrote runs only inside a container: a builder's command as the one argument
// of `sh -c` there, a gate's command as an argument list there.
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
const MAX_COMMAND = 100_000
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

// What a docker call needs to know of a job's folder (its worktree, or the
// gate's clean copy): the real folder, the container's name, the person's
// user id, and whether the folder holds git's own `.git` file.
async function placeOf(
  io: Io,
  root: string,
  jobId: string,
  kind: 'job' | 'gate',
): Promise<{ ok: true; name: string; folder: string; user: string; label: string; hasGitFile: boolean } | { ok: false; why: string }> {
  const dir = await stateDirOf(io, root)
  const there = dir === null || !isJobId(jobId) ? null : await io.stat(`${dir}/${kind === 'job' ? 'worktrees' : 'gate'}/${jobId}`)
  if (dir === null || there === null || there.kind !== 'dir') return { ok: false, why: 'the job has no folder' }
  const folder = there.realPath
  // The label is the name of this repository's state folder: it is in the
  // container's name, and a sweep finds its own containers by it.
  const label = dir.slice(dir.lastIndexOf('/') + 1)
  const name = containerName(kind, jobId, label)
  if (name === null) return { ok: false, why: 'the job has no folder' }
  const user = await userOf(io)
  if (user === null) return { ok: false, why: 'the user id could not be read' }
  // The folder's `.git` file is git's own (a job's worktree, the gate's copy): it is read-only inside.
  const gitFile = await io.stat(`${folder}/.git`)

  return { ok: true, name, folder, user, label, hasGitFile: gitFile !== null && gitFile.kind === 'file' }
}

const whyNot = (result: RunResult | null): string =>
  result === null ? 'the container settings are not usable' : 'failed' in result ? (result.failed === 'not-found' ? NOT_HERE : NO_ANSWER) : failureText('docker', result)

// The gate's container, over the gate's clean copy. It is always made new: a
// container that an earlier gate run left is removed, never used again.
export async function makeGate(io: Io, root: string, jobId: string, spec: ContainerSpec): Promise<{ ok: true; name: string; folder: string } | { ok: false; why: string }> {
  const place = await placeOf(io, root, jobId, 'gate')
  if (!place.ok) return place
  const { name, folder } = place
  const gone = await docker(io, { do: 'remove', name })
  if (gone !== null && 'failed' in gone) return { ok: false, why: whyNot(gone) }
  const made = await docker(io, { do: 'make', ...place, spec })

  return passed(made) ? { ok: true, name, folder } : { ok: false, why: whyNot(made) }
}

// The end of a stream, with nothing in it that moves a terminal's cursor.
const tail = (text: string, max: number) => text.slice(-max).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

// Docker itself could not run the container (its exit code 125, with its own words).
const isDockersOwn = (result: { exitCode: number; stderr: string }) => result.exitCode === 125 && /^docker: /m.test(result.stderr)

// Runs one command of a builder in a container of its own, over the job's
// worktree. The container is gone when the command ends, with every program
// the command started: it is removed by name afterwards too, so one that a
// time limit or a lost docker left alive is stopped. The answer is text for
// the agent: the exit code, then the end of what the command printed.
export async function runOnce(
  io: Io,
  root: string,
  jobId: string,
  spec: ContainerSpec,
  command: string,
  timeoutMs: number,
): Promise<{ ok: true; text: string; exitCode: number | null } | { ok: false; why: string }> {
  if (command === '' || command.length > MAX_COMMAND) return { ok: false, why: 'the command is empty or too long' }
  const place = await placeOf(io, root, jobId, 'job')
  if (!place.ok) return place
  const call: DockerCall = { do: 'once', ...place, spec, command }
  let result = await docker(io, call, timeoutMs)
  if (result !== null && 'failed' in result && result.failed === 'not-found') return { ok: false, why: NOT_HERE }
  // Nothing of the command stays alive, however the call ended.
  await docker(io, { do: 'remove', name: place.name })
  if (result !== null && !('failed' in result) && isDockersOwn(result) && /already in use/i.test(result.stderr)) {
    // A container of this name was there (a run that was lost). It is removed now: once more.
    result = await docker(io, call, timeoutMs)
    await docker(io, { do: 'remove', name: place.name })
  }
  if (result === null) return { ok: false, why: 'the container settings are not usable' }
  if ('failed' in result) {
    if (result.failed === 'timeout') return { ok: true, text: `The command did not end in ${Math.round(timeoutMs / 1000)} s. It was stopped; what it printed is lost.`, exitCode: null }

    return { ok: false, why: whyNot(result) }
  }
  if (isDockersOwn(result)) return { ok: false, why: failureText('docker', result) }
  const { stdout, stderr } = result
  const isLong = stdout.length + stderr.length > MAX_TEXT
  const body = stderr === '' ? tail(stdout, MAX_TEXT) : stdout === '' ? tail(stderr, MAX_TEXT) : `${tail(stdout, (MAX_TEXT * 2) / 3)}[stderr]\n${tail(stderr, MAX_TEXT / 3)}`
  const notes = [isLong ? '[the start of the output is cut]\n' : '', result.isCut === true ? '[the end of the output is missing: the command printed more than is kept]\n' : ''].join('')

  return { ok: true, text: `exit ${result.exitCode}\n${notes}${body}`, exitCode: result.exitCode }
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
