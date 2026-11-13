// Turns a PanelModel into the rows the pane draws, and into the status line.
// Pure: no `$`. A section with nothing to show adds no row.
import { factoryRows, jobCounts } from './line'
import type { PanelModel } from './model'
import { clean, fit, wrap } from './rows'
import type { Row, Tone } from './rows'

export { clean, cutTo, displayWidth, fit, wrap } from './rows'
export type { Row, Tone } from './rows'

const MAX_AGENTS = 6

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function rowsOf(model: PanelModel, columns: number, now: number): Row[] {
  const rows: Row[] = []
  const add = (left: string, right = '', tone: Tone = 'plain', rightTone: Tone = 'plain') => {
    rows.push({ ...fit(clean(left), clean(right), columns), tone, rightTone })
  }
  const head = (name: string) => add(name, '', 'head')
  // Checks and ports run commands from the settings file: shown only once approved.
  const isApproved = model.consent === 'approved'

  if (model.consent === 'none') add('No settings file. Run /factory init.', '', 'dim')
  if (model.consent === 'needed') {
    // The count is on the first row: a long list can run below the pane's edge.
    head(`SETTINGS NOT APPROVED · ${plural(model.pendingCommands.length, 'command')}`)
    // The person approves what is shown: a command is wrapped, never cut.
    for (const command of model.pendingCommands) {
      for (const piece of wrap(clean(command), columns)) add(piece, '', 'dim')
    }
    add('Run /factory approve to allow these commands.')
  }
  // Why the settings were refused: wrapped, never cut, as the commands above.
  if (model.settingsError) {
    for (const piece of wrap(clean(`settings: ${model.settingsError}`), columns)) add(piece, '', 'bad')
  }

  const task = model.task
  if (task) {
    head('TASK')
    const name = task.id ? [task.id, task.title].filter(Boolean).join(' ') : task.branch
    add(name, task.state ?? '', 'plain', 'warn')
    const pr = task.pr
    if (pr) {
      const left = `PR ${pr.number} · build ${pr.build} · ${plural(pr.approvals, 'approval')}`
      if (pr.isDraft) add(left, 'draft', 'dim', 'dim')
      else add(left, pr.build === 'green' ? 'ok' : '', 'dim', 'good')
    }
    if (task.note) add(task.note, '', 'dim')
  }

  if (model.factory) rows.push(...factoryRows(model.factory, columns))

  if (model.progress.length > 0) {
    head('PROGRESS')
    for (const item of model.progress) {
      add(item.name, item.percent === null ? '-' : `${item.percent}%`)
      if (item.blocked) add(`BLOCKED: ${item.blocked}`, '', 'bad')
    }
    if (model.progressMore > 0) add(`+ ${model.progressMore} more`, '', 'dim')
  }

  const running = model.agents.filter(agent => agent.isRunning)
  if (running.length > 0) {
    head('AGENTS')
    for (const agent of running.slice(0, MAX_AGENTS)) {
      const minutes =
        agent.startedAt === null ? '' : `${Math.max(0, Math.floor((now - agent.startedAt) / 60_000))} m`
      add([agent.label, agent.kind].filter(Boolean).join(' '), minutes, 'plain', 'dim')
    }
    if (running.length > MAX_AGENTS) add(`+ ${running.length - MAX_AGENTS} more`, '', 'dim')
  }

  if (isApproved && model.checks.length > 0) {
    head('CHECKS')
    for (const check of model.checks) {
      if (check.state === 'ok') add(check.name, 'ok', 'plain', 'good')
      else if (check.state === 'wrong') add(check.name, check.got ?? 'wrong', 'plain', 'bad')
      else if (check.state === 'error') add(check.name, check.got ?? 'error', 'plain', 'bad')
      else add(check.name, '?', 'plain', 'dim')
    }
  }

  if (isApproved && model.ports.length > 0) {
    head('PORTS')
    for (const port of model.ports) {
      const left = `${port.name} :${port.port}`
      if (port.state === 'up') add(left, 'up', 'plain', 'good')
      else if (port.state === 'down') add(left, 'DOWN', 'plain', 'bad')
      else add(left, '?', 'plain', 'dim')
    }
  }

  const more: string[] = []
  if (model.worktrees.length > 1) {
    const merged = model.worktrees.filter(tree => tree.isMerged).length
    more.push(`WORKTREES ${model.worktrees.length}` + (merged > 0 ? ` · ${merged} merged, remove?` : ''))
  }
  if (model.owed && model.owed.open > 0) more.push(`OWED BY YOU ${model.owed.open}`)
  if (more.length > 0) {
    head('MORE')
    for (const line of more) add(line, '', 'dim')
  }

  for (const note of model.notes) add(note, '', 'dim')
  if (model.readAt !== null) {
    add(`read ${Math.max(0, Math.round((now - model.readAt) / 1000))} s ago`, '', 'dim')
  }

  return rows
}

export function statusText(model: PanelModel): string | undefined {
  const parts: string[] = []
  if (model.task?.id) parts.push(model.task.id)
  if (model.factory) {
    const { run, need } = jobCounts(model.factory)
    const needs = need === 0 ? '' : `, ${need} need${need === 1 ? 's' : ''} you`
    if (run + need > 0) parts.push(`factory ${run} run${needs}`)
  }
  const first = model.progress[0]
  if (first && first.percent !== null) parts.push(`${first.percent}%`)
  if (model.checks.length > 0) {
    const wrong = model.checks.filter(c => c.state === 'wrong' || c.state === 'error').length
    parts.push(wrong === 0 ? 'checks ok' : `${plural(wrong, 'check')} wrong`)
  }
  if (model.progress.some(item => item.blocked)) parts.push('blocked')

  return parts.length > 0 ? parts.join(' · ') : undefined
}
