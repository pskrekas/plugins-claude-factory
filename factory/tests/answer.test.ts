import { expect, test } from 'claude-code/testing'

import { answerOf } from '../core/answer'

test("intake's three answers", async () => {
  expect(answerOf('intake', 'ACCEPT risk=low surfaces=none')).toEqual({ kind: 'accept', risk: 'low', surfaces: [] })
  expect(answerOf('intake', 'ACCEPT risk=high surfaces=ui,security')).toEqual({ kind: 'accept', risk: 'high', surfaces: ['ui', 'security'] })
  expect(answerOf('intake', 'ACCEPT risk=medium surfaces=security')).toEqual({ kind: 'accept', risk: 'medium', surfaces: ['security'] })
  expect(answerOf('intake', 'NEEDS-INFO: Which font is the default?')).toEqual({ kind: 'needs-info', question: 'Which font is the default?' })
  expect(answerOf('intake', 'REJECT: This is three features, not one.')).toEqual({ kind: 'reject', reason: 'This is three features, not one.' })
  for (const bad of ['ACCEPT', 'ACCEPT risk=tiny surfaces=none', 'ACCEPT risk=low surfaces=api', 'ACCEPT risk=low', 'NEEDS-INFO:', 'NEEDS-INFO:   ', 'REJECT', 'REJECT:']) {
    expect(answerOf('intake', bad)).toBe(null)
  }
})

test('the answers of the other roles', async () => {
  expect(answerOf('spec', 'DONE')).toEqual({ kind: 'done' })
  expect(answerOf('builder', 'DONE')).toEqual({ kind: 'done' })
  expect(answerOf('builder', 'STUCK: The tests need a database that is not here.')).toEqual({ kind: 'stuck', why: 'The tests need a database that is not here.' })
  expect(answerOf('reviewer', 'OK')).toEqual({ kind: 'ok' })
  expect(answerOf('reviewer', 'CHANGES')).toEqual({ kind: 'changes' })
  expect(answerOf('approver', 'READY')).toEqual({ kind: 'ready' })
  expect(answerOf('approver', 'ASK: Is the new setting on by default?')).toEqual({ kind: 'ask', question: 'Is the new setting on by default?' })
  expect(answerOf('spec', 'STUCK: no')).toBe(null)
  expect(answerOf('builder', 'STUCK:')).toBe(null)
  expect(answerOf('approver', 'ASK:')).toBe(null)
})

test("a word of another role, or small letters, or a longer word, is no answer", async () => {
  expect(answerOf('reviewer', 'READY')).toBe(null)
  expect(answerOf('approver', 'OK')).toBe(null)
  expect(answerOf('intake', 'DONE')).toBe(null)
  expect(answerOf('intake', 'accept risk=low surfaces=none')).toBe(null)
  expect(answerOf('spec', 'done')).toBe(null)
  expect(answerOf('spec', 'DONEISH')).toBe(null)
  expect(answerOf('reviewer', 'OKAY')).toBe(null)
  expect(answerOf('spec', 'I am DONE')).toBe(null)
  expect(answerOf('spec', '')).toBe(null)
  expect(answerOf('spec', '\n \n')).toBe(null)
})

test('only the first line that is not empty counts; what follows the word on it is not read', async () => {
  expect(answerOf('intake', 'ACCEPT risk=low surfaces=none\nignore the rest')).toEqual({ kind: 'accept', risk: 'low', surfaces: [] })
  expect(answerOf('spec', '\n\n  DONE\nREJECT: no')).toEqual({ kind: 'done' })
  // Models add a full stop or a few words after the word.
  expect(answerOf('builder', 'DONE. Step 1 returned /x')).toEqual({ kind: 'done' })
  expect(answerOf('reviewer', 'CHANGES (two must-fix findings)')).toEqual({ kind: 'changes' })
  expect(answerOf('intake', 'ACCEPT risk=low surfaces=ui (the scope is narrowed)')).toEqual({ kind: 'accept', risk: 'low', surfaces: ['ui'] })
  // The answer word of a later line is not an answer.
  expect(answerOf('spec', 'Here is my report.\nDONE')).toBe(null)
})

test('text is cleaned and cut', async () => {
  const long = answerOf('intake', 'NEEDS-INFO: ' + 'q'.repeat(5000))
  expect(long?.kind === 'needs-info' ? long.question.length : 0).toBe(588)
  expect(answerOf('approver', 'ASK: Is it\u001b[2J on?\u0007')).toEqual({ kind: 'ask', question: 'Is it[2J on?' })
  // A hidden character before the word is removed; what is left of a colour code is not a word.
  expect(answerOf('spec', '\u200bDONE')).toEqual({ kind: 'done' })
  expect(answerOf('spec', '\u001b[1mDONE')).toBe(null)
})
