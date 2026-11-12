// The five agent types of the line: which tools each has, which model, and
// the text a station's agent is started with. Pure.
import { PROMPTS } from '../agents/prompts'
import { ROLES } from './factory-settings'
import type { FactorySettings, Role, Tier } from './factory-settings'

// The one place where a tier becomes a model.
export const MODEL_OF: Record<Tier, string> = { strongest: 'opus', strong: 'sonnet', fast: 'haiku' }

// Every role reads files and writes its one file. Only the builder has a
// shell and can edit code (design 8.1).
const READS = ['Read', 'Glob', 'Grep', 'Write'] as const
export const TOOLS: Record<Role, readonly string[]> = {
  intake: READS,
  spec: READS,
  builder: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
  reviewer: READS,
  approver: READS,
}

const DESCRIPTIONS: Record<Role, string> = {
  intake: 'Factory line: decides if a tracker item can be built',
  spec: 'Factory line: writes what to build and how it is checked',
  builder: "Factory line: builds a job's change in its own worktree",
  reviewer: 'Factory line: reviews the change of one round',
  approver: 'Factory line: decides if a job is ready for a person',
}

// The name the engine gives a type the plugin registered.
export const typeOf = (role: Role): string => `factory:${role}`

export type AgentSpecOf = {
  name: Role
  description: string
  prompt: string
  tools: string[]
  model: string
  omitClaudeMd: true
}

export function agentSpecs(f: FactorySettings): AgentSpecOf[] {
  return ROLES.map(role => ({
    name: role,
    description: DESCRIPTIONS[role],
    prompt: PROMPTS[role],
    tools: [...TOOLS[role]],
    model: MODEL_OF[f.models[role]],
    // A repo's own instruction file is text of the repo: an agent of the line
    // does not take it as instructions.
    omitClaudeMd: true,
  }))
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
