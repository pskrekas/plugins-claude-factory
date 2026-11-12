import { expect, test } from 'claude-code/testing'

import { stateFolderOf } from '../core/state-path'
import { dockerState, makeGate, removeContainer, runArgv, runOnce, sweepContainers } from '../hooks/container'
import { fakeIo } from './kit'

const LABEL = stateFolderOf('/r/.git')
const DIR = '/state/' + LABEL
const ID = '12-add-dark-mode'
const WT = `${DIR}/worktrees/${ID}`
const JOB = `factory-job-${ID}.${LABEL}`
const GATE = `factory-gate-${ID}.${LABEL}`
const SPEC = { image: 'node:22', network: 'on' as const, memory: '4g', cpus: 2 }
type Answer = { exitCode: number; stdout?: string; stderr?: string; isCut?: boolean }
function world(answers: Record<string, Answer | 'missing' | 'hang'>, files: Record<string, string> = {}) {
  const io = fakeIo({ files: { '/r/.git/HEAD': 'x', [`${WT}/README.md`]: 'x', [`${WT}/.git`]: 'gitdir: x\n', [`${DIR}/gate/${ID}/README.md`]: 'x', ...files } })
  io.answer = argv => {
    const line = argv.join(' ')
    if (line === 'id -u') return { exitCode: 0, stdout: '501\n' }
    if (line === 'id -g') return { exitCode: 0, stdout: '20\n' }
    const key = Object.keys(answers).find(start => line.startsWith(start))
    const hit = key === undefined ? undefined : answers[key]
    if (hit === undefined || hit === 'missing') return undefined
    if (hit === 'hang') return { exitCode: 0, stdout: '', failed: 'timeout' } as never

    return { exitCode: hit.exitCode, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '', isCut: hit.isCut }
  }

  return io
}
const docker = (io: { ran: string[] }) => io.ran.filter(line => line.startsWith('docker '))

test('docker and the image are there, or one line says what is missing', async () => {
  expect(await dockerState(world({ 'docker image inspect': { exitCode: 0, stdout: 'sha256:abc\n' } }), 'node:22')).toEqual({ ok: true })
  expect(await dockerState(world({}), 'node:22')).toEqual({ ok: false, why: 'docker is not on this machine' })
  expect(await dockerState(world({ 'docker image inspect': { exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?' } }), 'node:22')).toEqual({ ok: false, why: 'docker does not answer. Start Docker, then run the command again.' })
  expect(await dockerState(world({ 'docker image inspect': { exitCode: 1, stderr: 'Error response from daemon: No such image: node:22' } }), 'node:22')).toEqual({
    ok: false,
    why: 'the image node:22 is not on this machine. Run: docker pull node:22',
  })
  expect(await dockerState(world({}), '--privileged')).toEqual({ ok: false, why: 'not an image name' })
})

test("a builder's command runs in a container of its own over the job's worktree, and the container is gone when the command ends", async () => {
  const io = world({ 'docker run': { exitCode: 3, stdout: 'out line\n', stderr: 'err line\n' }, 'docker rm': { exitCode: 1, stderr: 'No such container' } })
  const command = 'npm test -- "a b"; echo $(id) &'
  expect(await runOnce(io, '/r', ID, SPEC, command, 120_000)).toEqual({ ok: true, text: 'exit 3\nout line\n[stderr]\nerr line\n', exitCode: 3 })
  // One run, then the container is removed by name: also one that a time limit or a lost docker left alive.
  expect(docker(io)).toEqual([`docker run --rm --name ${JOB} --label factory.state=${LABEL} --init --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g --cpus 2 --network bridge --user 501:20 -e HOME=/tmp -v ${WT}:${WT} -v ${WT}/.git:${WT}/.git:ro -w ${WT} --entrypoint sh node:22 -c ${command}`, `docker rm -f ${JOB}`])
  expect(io.timeouts[io.ran.findIndex(line => line.startsWith('docker run'))]).toBe(120_000)

  const long = world({ 'docker run': { exitCode: 0, stdout: 'x'.repeat(100_000) + 'THE-END' } })
  const cut = await runOnce(long, '/r', ID, SPEC, 'ls', 1000)
  expect(cut.ok && [cut.text.length <= 30_200, cut.text.endsWith('THE-END'), cut.text.includes('[the start of the output is cut]')]).toEqual([true, true, true])
  const lost = world({ 'docker run': { exitCode: 0, stdout: 'only the start', isCut: true } })
  const kept = await runOnce(lost, '/r', ID, SPEC, 'ls', 1000)
  expect(kept.ok && kept.text).toContain('[the end of the output is missing: the command printed more than is kept]')
})

test('a command that does not end in time is stopped: its container is removed', async () => {
  const slow = world({ 'docker run': 'hang', 'docker rm': { exitCode: 0 } })
  expect(await runOnce(slow, '/r', ID, SPEC, 'sleep 999', 5000)).toEqual({ ok: true, text: 'The command did not end in 5 s. It was stopped; what it printed is lost.', exitCode: null })
  expect(docker(slow).at(-1)).toBe(`docker rm -f ${JOB}`)
})

test('a command that cannot run says why, and nothing runs', async () => {
  expect(await runOnce(world({}), '/r', ID, SPEC, '', 1000)).toEqual({ ok: false, why: 'the command is empty or too long' })
  expect(await runOnce(world({}), '/r', ID, SPEC, 'ls', 1000)).toEqual({ ok: false, why: 'docker is not on this machine' })
  // No folder, no container.
  const none = world({ docker: { exitCode: 0 } })
  expect(await runOnce(none, '/r', '99-no-such-job', SPEC, 'ls', 1000)).toEqual({ ok: false, why: 'the job has no folder' })
  expect(await runOnce(none, '/r', '../x', SPEC, 'ls', 1000)).toEqual({ ok: false, why: 'the job has no folder' })
  expect(docker(none)).toEqual([])
  // A container of the same name is still there (a run that was lost): it is removed, and the command runs once more.
  let tries = 0
  const taken = world({ 'docker rm': { exitCode: 0 } })
  const answer = taken.answer
  taken.answer = argv => {
    if (argv[1] !== 'run') return answer?.(argv)
    tries += 1

    return tries === 1 ? { exitCode: 125, stdout: '', stderr: `docker: Error response from daemon: Conflict. The container name "/${JOB}" is already in use by container "abc".` } : { exitCode: 0, stdout: 'ok\n' }
  }
  expect(await runOnce(taken, '/r', ID, SPEC, 'ls', 1000)).toEqual({ ok: true, text: 'exit 0\nok\n', exitCode: 0 })
  expect(docker(taken).map(line => line.split(' ').slice(0, 2).join(' '))).toEqual(['docker run', 'docker rm', 'docker run', 'docker rm'])
  // Docker itself refuses (not the command): the reason is told, with no exit code of a command.
  const refused = world({ 'docker run': { exitCode: 125, stderr: 'docker: invalid reference format.\nSee docker run --help' }, 'docker rm': { exitCode: 0 } })
  expect(await runOnce(refused, '/r', ID, SPEC, 'ls', 1000)).toEqual({ ok: false, why: 'docker: docker: invalid reference format. See docker run --help' })
})

test("the gate's container is made new over the gate's clean copy; one that cannot be made says why", async () => {
  const io = world({ 'docker rm': { exitCode: 0 }, 'docker run': { exitCode: 0 } })
  expect(await makeGate(io, '/r', ID, SPEC)).toEqual({ ok: true, name: GATE, folder: `${DIR}/gate/${ID}` })
  // A container an earlier gate run left is never used again.
  expect(docker(io).map(line => line.split(' ').slice(0, 3).join(' '))).toEqual(['docker rm -f', 'docker run -d'])
  expect(docker(io).at(-1)).toContain(`-v ${DIR}/gate/${ID}:${DIR}/gate/${ID} -w ${DIR}/gate/${ID} --entrypoint sleep node:22 infinity`)
  expect(docker(io).at(-1)?.includes('.git:')).toBe(false)
  // The copy's `.git` file (git made the copy) cannot be changed from inside.
  const linked = world({ 'docker rm': { exitCode: 0 }, 'docker run': { exitCode: 0 } }, { [`${DIR}/gate/${ID}/.git`]: 'gitdir: x\n' })
  await makeGate(linked, '/r', ID, SPEC)
  expect(docker(linked).at(-1)).toContain(`-v ${DIR}/gate/${ID}:${DIR}/gate/${ID} -v ${DIR}/gate/${ID}/.git:${DIR}/gate/${ID}/.git:ro -w ${DIR}/gate/${ID} --entrypoint sleep node:22`)

  const broken = world({ 'docker rm': { exitCode: 0 }, 'docker run': { exitCode: 125, stderr: 'docker: invalid reference format.\nSee docker run --help' } })
  expect(await makeGate(broken, '/r', ID, SPEC)).toEqual({ ok: false, why: 'docker: docker: invalid reference format. See docker run --help' })
  expect(await makeGate(world({}), '/r', ID, SPEC)).toEqual({ ok: false, why: 'docker is not on this machine' })
  expect(await makeGate(world({ docker: { exitCode: 0 } }), '/r', '99-no-such-job', SPEC)).toEqual({ ok: false, why: 'the job has no folder' })
})

test("the gate's commands run in the container as argument lists", async () => {
  const io = world({ 'docker exec': { exitCode: 0, stdout: 'ok' } })
  expect(await runArgv(io, GATE, `${DIR}/gate/${ID}`, ['npm', 'test'], 600_000)).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' })
  expect(io.ran.at(-1)).toBe(`docker exec -w ${DIR}/gate/${ID} ${GATE} npm test`)
  expect(await runArgv(io, 'postgres', '/x', ['ls'], 1000)).toEqual({ failed: 'other' })
})

test('containers of jobs that are gone are removed; the others stay', async () => {
  const io = world({ 'docker ps': { exitCode: 0, stdout: `${JOB}\n${GATE}\nfactory-job-7-old.${LABEL}\nfactory-7-old\nnot-ours\n` }, 'docker rm': { exitCode: 0 } })
  expect(await sweepContainers(io, '/r', [JOB])).toBe(2)
  expect(docker(io)).toEqual([`docker ps -a --filter label=factory.state=${LABEL} --format {{.Names}}`, `docker rm -f ${GATE}`, `docker rm -f factory-job-7-old.${LABEL}`])
  await removeContainer(io, JOB)
  expect(docker(io).at(-1)).toBe(`docker rm -f ${JOB}`)
  // With no docker there is nothing to sweep.
  expect(await sweepContainers(world({}), '/r', [])).toBe(0)
})
