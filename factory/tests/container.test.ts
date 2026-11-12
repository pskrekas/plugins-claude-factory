import { expect, test } from 'claude-code/testing'

import { stateFolderOf } from '../core/state-path'
import { dockerState, ensureContainer, removeContainer, runArgv, runShell, sweepContainers } from '../hooks/container'
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

test("a job's container is made over its worktree, and used again while it runs", async () => {
  const io = world({ 'docker inspect': { exitCode: 1, stderr: 'No such object' }, 'docker rm': { exitCode: 0 }, 'docker run': { exitCode: 0, stdout: 'abc\n' } })
  expect(await ensureContainer(io, '/r', ID, 'job', SPEC)).toEqual({ ok: true, name: JOB, folder: WT })
  expect(docker(io)).toEqual([
    `docker inspect --format {{.State.Running}} ${JOB}`,
    `docker rm -f ${JOB}`,
    `docker run -d --name ${JOB} --label factory.state=${LABEL} --init --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g --cpus 2 --network bridge --user 501:20 -e HOME=/tmp -v ${WT}:${WT} -v ${WT}/.git:${WT}/.git:ro -w ${WT} node:22 sleep infinity`,
  ])
  const again = world({ 'docker inspect': { exitCode: 0, stdout: 'true\n' } })
  expect((await ensureContainer(again, '/r', ID, 'job', SPEC)).ok).toBe(true)
  expect(docker(again).length).toBe(1)
  // One that stopped is removed and made again.
  const stopped = world({ 'docker inspect': { exitCode: 0, stdout: 'false\n' }, 'docker rm': { exitCode: 0 }, 'docker run': { exitCode: 0 } })
  await ensureContainer(stopped, '/r', ID, 'job', SPEC)
  expect(docker(stopped).map(line => line.split(' ').slice(0, 2).join(' '))).toEqual(['docker inspect', 'docker rm', 'docker run'])
})

test("the gate's container is over the gate's clean copy; a container that cannot be made says why", async () => {
  const io = world({ 'docker inspect': { exitCode: 1 }, 'docker rm': { exitCode: 0 }, 'docker run': { exitCode: 0 } })
  expect(await ensureContainer(io, '/r', ID, 'gate', SPEC)).toEqual({ ok: true, name: GATE, folder: `${DIR}/gate/${ID}` })
  expect(docker(io).at(-1)).toContain(`-v ${DIR}/gate/${ID}:${DIR}/gate/${ID} -w ${DIR}/gate/${ID} node:22`)
  expect(docker(io).at(-1)?.includes('.git:')).toBe(false)
  // The copy's `.git` file (git made the copy) cannot be changed from inside either.
  const linked = world({ 'docker inspect': { exitCode: 1 }, 'docker rm': { exitCode: 0 }, 'docker run': { exitCode: 0 } }, { [`${DIR}/gate/${ID}/.git`]: 'gitdir: x\n' })
  await ensureContainer(linked, '/r', ID, 'gate', SPEC)
  expect(docker(linked).at(-1)).toContain(`-v ${DIR}/gate/${ID}:${DIR}/gate/${ID} -v ${DIR}/gate/${ID}/.git:${DIR}/gate/${ID}/.git:ro -w ${DIR}/gate/${ID} node:22`)

  const broken = world({ 'docker inspect': { exitCode: 1 }, 'docker rm': { exitCode: 0 }, 'docker run': { exitCode: 125, stderr: 'docker: invalid reference format.\nSee docker run --help' } })
  expect(await ensureContainer(broken, '/r', ID, 'job', SPEC)).toEqual({ ok: false, why: 'docker: docker: invalid reference format. See docker run --help' })
  // No folder, no container.
  expect(await ensureContainer(world({}), '/r', '99-no-such-job', 'job', SPEC)).toEqual({ ok: false, why: 'the job has no folder' })
  expect(await ensureContainer(world({}), '/r', '../x', 'job', SPEC)).toEqual({ ok: false, why: 'the job has no folder' })
})

test('a command runs inside the container, and its answer is its exit code and the end of what it printed', async () => {
  const io = world({ 'docker exec': { exitCode: 3, stdout: 'out line\n', stderr: 'err line\n' } })
  const command = 'npm test -- "a b"; echo $(id)'
  expect(await runShell(io, JOB, WT, command, 120_000)).toEqual({ text: 'exit 3\nout line\n[stderr]\nerr line\n', exitCode: 3 })
  expect(io.ran.at(-1)).toBe(`docker exec -w ${WT} ${JOB} sh -c ${command}`)
  expect(io.timeouts.at(-1)).toBe(120_000)

  const long = world({ 'docker exec': { exitCode: 0, stdout: 'x'.repeat(100_000) + 'THE-END' } })
  const cut = await runShell(long, JOB, WT, 'ls', 1000)
  expect([cut.text.length <= 30_200, cut.text.endsWith('THE-END'), cut.text.includes('[the start of the output is cut]')]).toEqual([true, true, true])
  const lost = world({ 'docker exec': { exitCode: 0, stdout: 'only the start', isCut: true } })
  expect((await runShell(lost, JOB, WT, 'ls', 1000)).text).toContain('[the end of the output is missing: the command printed more than is kept]')

  const slow = world({ 'docker exec': 'hang' })
  expect(await runShell(slow, JOB, WT, 'sleep 999', 5000)).toEqual({ text: 'The command did not end in 5 s. It was left; what it printed is lost.', exitCode: null })
  expect(await runShell(world({}), JOB, WT, '', 1000)).toEqual({ text: 'The command was not run: it is empty or too long.', exitCode: null })
  expect((await runShell(world({}), JOB, WT, 'ls', 1000)).text).toBe('The command could not start: docker is not on this machine.')
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
