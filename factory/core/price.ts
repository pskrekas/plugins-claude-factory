// The estimate of what one agent turn cost: its token counts times the price
// of its model, from the settings' price table (US dollars per million
// tokens). An estimate at list prices; on a subscription it shows relative
// spend, not a bill. Pure.
import type { Price } from './factory-settings'

export type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const MILLION = 1_000_000
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

// Null when the session reported no counts, or the table has no price for
// the model: then the job is "cost unknown" and the time limits stand in.
export function priceOf(usage: Usage | null | undefined, prices: Record<string, Price>): number | null {
  if (usage === null || usage === undefined) return null
  const price = Object.hasOwn(prices, usage.model) ? prices[usage.model] : undefined
  if (price === undefined) return null
  const counts = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
  if (!counts.every(isCount)) return null

  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.cache_creation_input_tokens * price.cacheWrite) /
    MILLION
  )
}
