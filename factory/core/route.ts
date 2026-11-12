// Which reviewers a job gets, from the risk and surfaces Intake gave it and
// the settings (design 5.1, "Route"). Pure: code decides the routing, no agent.
import { RISKS } from './factory-settings'
import type { FactorySettings, Risk } from './factory-settings'

const SURFACES = ['ui', 'security'] as const

export function routeOf(
  risk: Risk,
  surfaces: string[],
  f: FactorySettings,
): { reviewers: string[]; isOverRisk: boolean } {
  const reviewers = [...f.reviewers[risk]]
  for (const surface of SURFACES) {
    if (surfaces.includes(surface)) reviewers.push(...f.reviewers[surface])
  }

  return {
    reviewers: [...new Set(reviewers)],
    isOverRisk: RISKS.indexOf(risk) > RISKS.indexOf(f.maxRisk),
  }
}
