// Every docker call the factory makes, as a plain argument list. Pure.
//
// This is the whole list. A container of the factory sees one folder (a job's
// worktree, or the gate's clean copy), at its own path; it gets no right that
// a plain process does not have; and no word of an agent is an option of
// `docker`: a builder's command is one argument of `sh -c` inside the
// container. A test checks every list this file can answer against those rules.
//
// A builder's command gets a container of its own, which is gone when the
// command ends (`once`): no program of a builder stays alive between two
// commands, so nothing can change the job's folder while the plugin, git or
// an agent's file tool reads it on the person's machine. The gate's container
// (`make`) stays for the gate's commands, and holds the gate's own copy.
import { isImage } from './factory-settings'
import type { ContainerSpec } from './factory-settings'
import { isJobId } from './job'

const MAX_COMMAND = 100_000

const isLabel = (label: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(label)

// `factory-job-<job id>.<label>` or `factory-gate-<job id>.<label>`; the label
// is the name of the repository's state folder. A job id holds no `.`, and the
// two starts differ, so a name reads one way only: two jobs, a job and a gate
// run, or two repositories never get one name. Null when a part breaks a rule.
export const containerName = (kind: 'job' | 'gate', jobId: string, label: string): string | null =>
  isJobId(jobId) && isLabel(label) ? `factory-${kind}-${jobId}.${label}` : null

export type DockerCall =
  | { do: 'image'; image: string }
  | { do: 'make'; name: string; spec: ContainerSpec; folder: string; user: string; label: string }
  | { do: 'once'; name: string; spec: ContainerSpec; folder: string; user: string; label: string; command: string }
  | { do: 'argv'; name: string; cwd: string; argv: string[] }
  | { do: 'remove'; name: string }
  | { do: 'list'; label: string }

// The label in a name of the factory, or null: the factory touches no other container.
const labelIn = (name: string): string | null => {
  const rest = name.startsWith('factory-job-') ? name.slice('factory-job-'.length) : name.startsWith('factory-gate-') ? name.slice('factory-gate-'.length) : ''
  const dot = rest.indexOf('.')
  if (dot < 1) return null
  const label = rest.slice(dot + 1)

  return isJobId(rest.slice(0, dot)) && isLabel(label) ? label : null
}
// An absolute path with no `..`, no `:` (the mount's own separator) and no control character.
const isFolder = (path: string) => path.startsWith('/') && !path.split('/').includes('..') && !/[:\u0000-\u001f\u007f]/.test(path)
const isSpec = (spec: ContainerSpec) =>
  isImage(spec.image) && (spec.network === 'on' || spec.network === 'none') && /^[1-9][0-9]{0,5}[mg]$/.test(spec.memory) && spec.cpus >= 0.5 && spec.cpus <= 16

// The argument list of a call, or null when one of its values breaks a rule.
export function dockerArgs(call: DockerCall): string[] | null {
  if ('label' in call && !isLabel(call.label)) return null
  if ('name' in call) {
    const label = labelIn(call.name)
    // A container is made under its own repository's label only.
    if (label === null || ('label' in call && label !== call.label)) return null
  }
  if ('cwd' in call && !isFolder(call.cwd)) return null

  switch (call.do) {
    case 'image':
      return isImage(call.image) ? ['docker', 'image', 'inspect', '--format', '{{.Id}}', call.image] : null
    case 'make':
    case 'once': {
      if (!isSpec(call.spec) || !isFolder(call.folder) || !/^\d{1,10}:\d{1,10}$/.test(call.user)) return null
      if (call.do === 'once' && (call.command === '' || call.command.length > MAX_COMMAND)) return null
      const { folder, spec } = call

      return [
        'docker', 'run',
        // Docker fetches no image by itself: the person does.
        '--pull', 'never',
        // A builder's container is gone when its one command ends; the gate's stays for the gate's commands.
        call.do === 'once' ? '--rm' : '-d',
        '--name', call.name,
        '--label', `factory.state=${call.label}`,
        '--init',
        // No right that a plain process does not have, and none to gain.
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', '512',
        '--memory', spec.memory,
        '--cpus', String(spec.cpus),
        '--network', spec.network === 'on' ? 'bridge' : 'none',
        // The person's own user id, so files in the mounted folder stay the person's.
        '--user', call.user,
        '-e', 'HOME=/tmp',
        // The one folder it sees, at its own path. Nothing inside that folder
        // is ever the source of a mount: a builder writes there, and docker
        // follows a link that it finds in a mount's source.
        '-v', `${folder}:${folder}`,
        '-w', folder,
        // The image's own start program is not used. The command is one
        // argument, the last: only the shell inside the container reads it.
        ...(call.do === 'once' ? ['--entrypoint', 'sh', spec.image, '-c', call.command] : ['--entrypoint', 'sleep', spec.image, 'infinity']),
      ]
    }
    case 'argv':
      return call.argv.length === 0 ? null : ['docker', 'exec', '-w', call.cwd, call.name, ...call.argv]
    case 'remove':
      return ['docker', 'rm', '-f', call.name]
    case 'list':
      return ['docker', 'ps', '-a', '--filter', `label=factory.state=${call.label}`, '--format', '{{.Names}}']
  }
}
