// What changed for the worse between two reads of the model. Pure.
import { clean } from './layout'
import { isWaitingForYou } from './line'
import type { PanelModel } from './model'

const MAX_ALERT = 160

// An alert is raised on a change only: never on the first read, and never
// between two models that were read for different repos.
export function alertsFor(prev: PanelModel, next: PanelModel): string[] {
  if (prev.readAt === null || prev.root !== next.root) return []
  const alerts: string[] = []
  for (const item of next.progress) {
    const before = prev.progress.find(old => old.path === item.path)
    if (item.blocked && before && !before.blocked) alerts.push(`${item.name} is BLOCKED: ${item.blocked}`)
  }
  for (const check of next.checks) {
    const before = prev.checks.find(old => old.name === check.name)
    if (before?.state === 'ok' && (check.state === 'wrong' || check.state === 'error')) {
      alerts.push(`Check "${check.name}" is wrong: ${check.got ?? check.state}`)
    }
  }
  for (const port of next.ports) {
    const before = prev.ports.find(old => old.name === port.name && old.port === port.port)
    if (before?.state === 'up' && port.state === 'down') alerts.push(`${port.name} :${port.port} is DOWN`)
  }

  // A factory job that waits for the person now and did not before.
  const waitedBefore = new Set((prev.factory?.jobs ?? []).filter(isWaitingForYou).map(job => job.itemId))
  for (const job of next.factory?.jobs ?? []) {
    if (!isWaitingForYou(job) || waitedBefore.has(job.itemId)) continue
    if (job.stage === 'ready') {
      const pr = job.prNumber === null ? 'The pull request' : `PR ${job.prNumber}`
      alerts.push(`${job.itemId}: ${pr} is ready. You merge.`)
    } else {
      alerts.push(`${job.itemId} needs you: ${job.question ?? 'see the panel'}`)
    }
  }

  return alerts.map(text => clean(text).slice(0, MAX_ALERT))
}
