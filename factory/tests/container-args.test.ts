import { expect, test } from 'claude-code/testing'

import { containerName, dockerArgs } from '../core/container-args'

const ID = '12-add-dark-mode'
const WT = '/state/r-1/worktrees/' + ID
const SPEC = { image: 'node:22', network: 'on' as const, memory: '4g', cpus: 2 }
const NAME = 'factory-job-12-add-dark-mode.r-1'
const GATE = 'factory-gate-12-add-dark-mode.r-1'
const line = (call: Parameters<typeof dockerArgs>[0]) => dockerArgs(call)?.join(' ') ?? null
const make = { do: 'make' as const, name: NAME, spec: SPEC, folder: WT, user: '501:20', label: 'r-1' }
const once = { ...make, do: 'once' as const, command: 'npm test' }

test('every docker call of the factory, word for word', async () => {
  expect([containerName('job', ID, 'r-1'), containerName('gate', ID, 'r-1')]).toEqual([NAME, GATE])
  // A job whose id starts like the other kind, and the same job id in another repository, get other names.
  expect(containerName('job', 'gate-12-add-dark-mode', 'r-1')).toBe('factory-job-gate-12-add-dark-mode.r-1')
  expect(containerName('job', ID, 'other-9')).toBe('factory-job-12-add-dark-mode.other-9')
  expect(containerName('job', '../x', 'r-1')).toBe(null)
  expect(containerName('job', ID, 'a b')).toBe(null)
  expect(line({ do: 'image', image: 'node:22' })).toBe('docker image inspect --format {{.Id}} node:22')
  // One command of a builder: a container of its own, gone when the command ends (`--rm`).
  // The image's own start program is not used: the shell is.
  expect(line(once)).toBe(
    `docker run --pull never --rm --name ${NAME} --label factory.state=r-1 --init --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g --cpus 2 --network bridge --user 501:20 -e HOME=/tmp -v ${WT}:${WT} -w ${WT} --entrypoint sh node:22 -c npm test`,
  )
  // The gate's container stays for the gate's commands (`-d`), and does nothing by itself.
  expect(line({ ...make, name: GATE })).toBe(
    `docker run --pull never -d --name ${GATE} --label factory.state=r-1 --init --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g --cpus 2 --network bridge --user 501:20 -e HOME=/tmp -v ${WT}:${WT} -w ${WT} --entrypoint sleep node:22 infinity`,
  )
  // With no network.
  expect(line({ ...make, spec: { ...SPEC, network: 'none' } })).toBe(
    `docker run --pull never -d --name ${NAME} --label factory.state=r-1 --init --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g --cpus 2 --network none --user 501:20 -e HOME=/tmp -v ${WT}:${WT} -w ${WT} --entrypoint sleep node:22 infinity`,
  )
  expect(line({ do: 'remove', name: NAME })).toBe(`docker rm -f ${NAME}`)
  expect(line({ do: 'list', label: 'r-1' })).toBe('docker ps -a --filter label=factory.state=r-1 --format {{.Names}}')
  expect(dockerArgs({ do: 'argv', name: NAME, cwd: WT, argv: ['npm', 'test', '--', '--changed'] })).toEqual(['docker', 'exec', '-w', WT, NAME, 'npm', 'test', '--', '--changed'])
})

test('a command of the builder is one argument of the shell inside the container', async () => {
  const command = '--help; echo "$(cat /etc/passwd)"\n`id` && docker run --privileged x'
  const list = dockerArgs({ ...once, command }) ?? []
  // It is the last argument, whole, after the shell's own `-c`: docker reads no word of it.
  expect(list.slice(-5)).toEqual(['--entrypoint', 'sh', 'node:22', '-c', command])
  expect(list.filter(word => word === command).length).toBe(1)
  expect(dockerArgs({ ...once, command: '' })).toBe(null)
  expect(dockerArgs({ ...once, command: 'x'.repeat(100_001) })).toBe(null)
})

test('a value that breaks a rule gives no call at all', async () => {
  const bad = [
    { ...make, name: 'other' },
    { ...make, name: 'factory-job-../x.r-1' },
    { ...make, name: 'factory-12-add-dark-mode' },
    { ...make, name: 'factory-job-12-add-dark-mode.other' },
    { ...make, name: 'factory-job-12-add-dark-mode' },
    { ...make, name: 'factory-job-12-add-dark-mode.' },
    { ...make, name: 'factory-job-12-add-dark-mode.r 1' },
    { ...make, name: '--privileged' },
    { ...make, folder: 'relative/x' },
    { ...make, folder: '/a/../b' },
    { ...make, folder: '/a:b' },
    { ...make, folder: '/a b\n' },
    { ...make, folder: '/a\tb' },
    { ...make, user: 'root' },
    { ...make, user: '0:0 --privileged' },
    { ...make, label: 'a b' },
    { ...make, spec: { ...SPEC, image: '--privileged' } },
    { ...make, spec: { ...SPEC, memory: '4g --privileged' } },
    { ...make, spec: { ...SPEC, cpus: 99 } },
    { ...make, spec: { ...SPEC, network: 'host' as 'on' } },
  ]
  for (const call of bad) expect([JSON.stringify(call).slice(0, 90), dockerArgs(call)]).toEqual([JSON.stringify(call).slice(0, 90), null])
  // A space in a folder's name is not a rule broken (a home folder can hold one).
  expect(dockerArgs({ ...make, folder: '/Users/a b/state/r-1/worktrees/' + ID })?.includes('/Users/a b/state/r-1/worktrees/' + ID)).toBe(true)
  expect(dockerArgs({ do: 'image', image: '-x' })).toBe(null)
  expect(dockerArgs({ do: 'remove', name: 'postgres' })).toBe(null)
  expect(dockerArgs({ do: 'remove', name: 'factory-' })).toBe(null)
  expect(dockerArgs({ do: 'remove', name: 'factory-job-.r-1' })).toBe(null)
  expect(dockerArgs({ ...once, name: 'x' })).toBe(null)
  expect(dockerArgs({ ...once, name: 'factory-job-12-add-dark-mode.other' })).toBe(null)
  expect(dockerArgs({ ...once, folder: '/a:b' })).toBe(null)
  expect(dockerArgs({ ...once, spec: { ...SPEC, image: '--privileged' } })).toBe(null)
  expect(dockerArgs({ do: 'argv', name: NAME, cwd: WT, argv: [] })).toBe(null)
  expect(dockerArgs({ do: 'argv', name: NAME, cwd: 'x', argv: ['ls'] })).toBe(null)
  expect(dockerArgs({ do: 'list', label: '--all' })).toBe(null)
})

test('a container sees one folder and gets no added right', async () => {
  const every = [
    dockerArgs({ do: 'image', image: 'node:22' }),
    dockerArgs(make),
    dockerArgs({ ...make, name: GATE }),
    dockerArgs({ ...once, command: '--privileged -v /:/host docker.sock' }),
    dockerArgs({ do: 'argv', name: NAME, cwd: WT, argv: ['npm', 'test'] }),
    dockerArgs({ do: 'remove', name: NAME }),
    dockerArgs({ do: 'list', label: 'r-1' }),
  ].map(list => list ?? [])
  const banned = ['--privileged', '--pid', '--ipc', '--cap-add', '--device', '--volumes-from', '--mount', '--network=host', '--userns', '--add-host', '-p', '--publish', '--env-file']
  for (const list of every) {
    expect(list[0]).toBe('docker')
    // The plugin's own words only: what an agent wrote is the last argument of a builder's run.
    const own = list.includes('--rm') ? list.slice(0, -1) : list
    for (const word of own) {
      expect(banned.some(flag => word === flag || word.startsWith(flag + '='))).toBe(false)
      expect(word.includes('docker.sock')).toBe(false)
    }
  }
  for (const list of every.filter(one => one[1] === 'run')) {
    expect(list.includes('--cap-drop') && list[list.indexOf('--cap-drop') + 1] === 'ALL').toBe(true)
    expect(list[list.indexOf('--security-opt') + 1]).toBe('no-new-privileges')
    // Exactly the job's folder is mounted (and its git file, read-only, over it).
    const mounts = list.filter((_, i) => list[i - 1] === '-v')
    // Exactly the job's folder is mounted. Nothing inside the folder is ever a mount's source: the builder writes there.
    expect(mounts).toEqual([`${WT}:${WT}`])
    // Docker fetches no image by itself.
    expect(list[list.indexOf('--pull') + 1]).toBe('never')
    // A container that stays is the gate's; a builder's is gone with its one command.
    expect(list.includes('--rm') !== list.includes('-d')).toBe(true)
  }
})
