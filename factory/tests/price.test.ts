import { expect, test } from 'claude-code/testing'

import { priceOf } from '../core/price'

const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const usage = (model: string) => ({
  model,
  input_tokens: 1_000_000,
  output_tokens: 500_000,
  cache_read_input_tokens: 2_000_000,
  cache_creation_input_tokens: 0,
})

test('the estimate of one agent turn: tokens times the price of its model, per million', async () => {
  // 1 M in at 3, 0.5 M out at 15, 2 M read from the cache at 0.3.
  const cents = (usd: number | null) => (usd === null ? null : Math.round(usd * 100) / 100)
  expect(cents(priceOf(usage('m'), { m: PRICE }))).toBe(11.1)
  expect(cents(priceOf({ ...usage('m'), cache_creation_input_tokens: 1_000_000 }, { m: PRICE }))).toBe(14.85)
})

test('no usage, or no price for the model, is no estimate', async () => {
  expect(priceOf(undefined, { m: PRICE })).toBe(null)
  expect(priceOf(null, { m: PRICE })).toBe(null)
  expect(priceOf(usage('other'), { m: PRICE })).toBe(null)
  expect(priceOf(usage('m'), {})).toBe(null)
  // Counts that are not numbers are no usage.
  expect(priceOf({ ...usage('m'), output_tokens: Number.NaN }, { m: PRICE })).toBe(null)
})
