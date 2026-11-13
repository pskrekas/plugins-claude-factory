// The agent types of the line: which tools each has, which model, and the
// text a station's agent is started with. Pure.
//
// There are two builders (design 8.3). The builder of a job that builds in a
// container has no shell of the person's machine: its shell is a tool of the
// plugin, which runs each command inside the job's container. The host
// builder has `Bash`; a job gets it only when the settings say that commands
// run on this machine.
import { HOST_BUILDER, PROMPTS } from '../agents/prompts'
import { ROLES } from './factory-settings'
import type { FactorySettings, Role, Tier } from './factory-settings'

// The one place where a tier becomes a model.
export const MODEL_OF: Record<Tier, string> = { strongest: 'opus', strong: 'sonnet', fast: 'haiku' }
// The model of a role's choice in the settings: a tier's model, or the model the choice names.
export const modelOf = (choice: string): string => (Object.hasOwn(MODEL_OF, choice) ? MODEL_OF[choice as Tier] : choice)
export const modelsOf = (f: FactorySettings): Record<Role, string> => ({
  intake: modelOf(f.models.intake),
  spec: modelOf(f.models.spec),
  builder: modelOf(f.models.builder),
  reviewer: modelOf(f.models.reviewer),
  approver: modelOf(f.models.approver),
})

// Where a job's builder runs its commands.
export type Shell = 'container' | 'host'
// The plugin's own shell tool, as the engine names it (`mcp__<plugin>__<tool>`).
export const SHELL_TOOL = 'mcp__factory__sh'

// Every role reads files and writes its one file. Only a builder has a shell
// and can edit code (design 8.1).
const READS: readonly string[] = ['Read', 'Glob', 'Grep', 'Write']
const EDITS: readonly string[] = ['Read', 'Glob', 'Grep', 'Write', 'Edit']
export const toolsOf = (role: Role, shell: Shell): readonly string[] =>
  role !== 'builder' ? READS : [...EDITS, shell === 'container' ? SHELL_TOOL : 'Bash']

const DESCRIPTIONS: Record<Role, string> = {
  intake: 'Factory line: decides if a tracker item can be built',
  spec: 'Factory line: writes what to build and how it is checked',
  builder: "Factory line: builds a job's change in its own worktree",
  reviewer: 'Factory line: reviews the change of one round',
  approver: 'Factory line: decides if a job is ready for a person',
}

// The name the engine gives a type the plugin registered. Only the builder
// has two types; the job's shell says which one.
export const typeOf = (role: Role, shell: Shell): string => `factory:${role === 'builder' && shell === 'host' ? 'builder-host' : role}`
// Every type of the line.
export const AGENT_TYPES: readonly string[] = [...ROLES.map(role => typeOf(role, 'container')), typeOf('builder', 'host')]

export type AgentSpecOf = {
  name: Role | 'builder-host'
  description: string
  prompt: string
  tools: string[]
  model: string
  omitClaudeMd: true
}

export function agentSpecs(f: FactorySettings): AgentSpecOf[] {
  const spec = (role: Role, shell: Shell): AgentSpecOf => ({
    name: role === 'builder' && shell === 'host' ? 'builder-host' : role,
    description: DESCRIPTIONS[role] + (role === 'builder' && shell === 'host' ? ' (commands run on this machine)' : ''),
    prompt: role === 'builder' && shell === 'host' ? HOST_BUILDER : PROMPTS[role],
    tools: [...toolsOf(role, shell)],
    model: modelOf(f.models[role]),
    // A repo's own instruction file is text of the repo: an agent of the line
    // does not take it as instructions.
    omitClaudeMd: true,
  })

  return ROLES.flatMap(role => (role === 'builder' ? [spec(role, 'container'), spec(role, 'host')] : [spec(role, 'container')]))
}

// Which reviewer: `code`, `ui`, … A part of a file name, so it is plain.
export const isFocus = (text: string): boolean => /^[a-z0-9-]{1,20}$/.test(text)

// The one file each role writes, in the job's `out/` folder.
export const OUT_FILE: Record<Role, (focus: string) => string> = {
  intake: () => 'intake.md',
  spec: () => 'spec.md',
  builder: () => 'build.md',
  reviewer: focus => `review-${focus}.md`,
  approver: () => 'decision.md',
}

// The text a station's agent is started with: the places, and nothing of the
// item. What the item says reaches the agent only as a file of quoted data.
export function briefOf(
  role: Role,
  facts: { jobId: string; itemId: string; round: number; focus: string; files: string; out: string; worktree: string },
): string {
  const lines = [
    `Job ${facts.jobId}, item ${facts.itemId}, round ${facts.round}.`,
    `The job's files folder (read only): ${facts.files}`,
    `The newest round folder: ${facts.files}/round-${facts.round}`,
    `The code folder: ${facts.worktree}`,
    `The one file you write: ${facts.out}/${OUT_FILE[role](facts.focus)}`,
  ]
  if (role === 'reviewer') lines.push(`Your focus: ${facts.focus}.`)
  lines.push('Do your one job as your instructions say, then answer.')

  return lines.join('\n')
}
