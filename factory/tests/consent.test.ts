import { expect, test } from 'claude-code/testing'

import { consentOf, storeKey } from '../core/consent'

test('consent states', async () => {
  expect(consentOf(false, [], undefined)).toBe('none')
  expect(consentOf(true, [], undefined)).toBe('approved')
  expect(consentOf(true, ['npm test'], undefined)).toBe('needed')
  expect(consentOf(true, ['npm test'], ['npm test'])).toBe('approved')
  expect(storeKey('/r')).toBe('consent:/r')
})

test('every command must be in the approved list, exactly', async () => {
  expect(consentOf(true, ['npm test', 'rm -rf x'], ['npm test'])).toBe('needed')
  expect(consentOf(true, ['npm test --force'], ['npm test'])).toBe('needed')
  // Fewer commands than were approved is still approved.
  expect(consentOf(true, ['npm test'], ['npm run build', 'npm test'])).toBe('approved')
})

test('a stored value that is not a list of strings approves nothing', async () => {
  expect(consentOf(true, ['npm test'], 42)).toBe('needed')
  expect(consentOf(true, ['npm test'], 'npm test')).toBe('needed')
  expect(consentOf(true, ['npm test'], [['npm test']])).toBe('needed')
  expect(consentOf(true, ['npm test'], { 0: 'npm test', length: 1 })).toBe('needed')
})
