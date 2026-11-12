// An agent's answer: the first line of its last message, matched against the
// fixed list of its role. An agent judges; code decides where the job goes, so
// the line is read as one of a few words and nothing else in the message is
// read at all. Pure.
import type { Risk, Role } from './factory-settings'
import { clean } from './rows'

export type Answer =
  | { kind: 'accept'; risk: Risk; surfaces: string[] }
  | { kind: 'needs-info'; question: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'done' }
  | { kind: 'stuck'; why: string }
  | { kind: 'ok' }
  | { kind: 'changes' }
  | { kind: 'ready' }
  | { kind: 'ask'; question: string }

const MAX_LINE = 600
const RISKS: readonly string[] = ['low', 'medium', 'high']
const SURFACES: readonly string[] = ['ui', 'security']
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_LINE

// An answer as it reads back from a job file, or null when the value is not one.
export function parseAnswer(v: unknown): Answer | null {
  if (typeof v !== 'object' || v === null) return null
  const a = v as Record<string, unknown>
  switch (a.kind) {
    case 'accept': {
      const surfaces = a.surfaces
      if (!RISKS.includes(a.risk as string) || !Array.isArray(surfaces) || !surfaces.every(name => SURFACES.includes(name as string))) return null

      return { kind: 'accept', risk: a.risk as Risk, surfaces: [...new Set(surfaces as string[])] }
    }
    case 'needs-info':
      return isText(a.question) ? { kind: 'needs-info', question: a.question } : null
    case 'reject':
      return isText(a.reason) ? { kind: 'reject', reason: a.reason } : null
    case 'stuck':
      return isText(a.why) ? { kind: 'stuck', why: a.why } : null
    case 'ask':
      return isText(a.question) ? { kind: 'ask', question: a.question } : null
    case 'done':
    case 'ok':
    case 'changes':
    case 'ready':
      return { kind: a.kind }
    default:
      return null
  }
}
const ACCEPT = /^ACCEPT risk=(low|medium|high) surfaces=(none|ui|security|ui,security|security,ui)(?:\s|$)/

// The first line that is not empty, cleaned and cut.
function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = clean(raw).trim()
    if (line !== '') return line.slice(0, MAX_LINE)
  }

  return ''
}

// `WORD` alone, or `WORD` and then something that is not part of a word.
const isWord = (line: string, word: string) => line === word || (line.startsWith(word) && !/[A-Za-z0-9_-]/.test(line.charAt(word.length)))

// The text after `WORD:`, or null when there is none.
function after(line: string, word: string): string | null {
  if (!line.startsWith(word + ':')) return null
  const rest = line.slice(word.length + 1).trim()

  return rest === '' ? null : rest
}

export function answerOf(role: Role, text: string): Answer | null {
  const line = firstLine(text)
  if (line === '') return null

  switch (role) {
    case 'intake': {
      const accept = ACCEPT.exec(line)
      if (accept !== null) {
        const surfaces = accept[2] === 'none' ? [] : ['ui', 'security'].filter(name => (accept[2] ?? '').split(',').includes(name))

        return { kind: 'accept', risk: accept[1] as Risk, surfaces }
      }
      const question = after(line, 'NEEDS-INFO')
      if (question !== null) return { kind: 'needs-info', question }
      const reason = after(line, 'REJECT')

      return reason === null ? null : { kind: 'reject', reason }
    }
    case 'spec':
      return isWord(line, 'DONE') ? { kind: 'done' } : null
    case 'builder': {
      if (isWord(line, 'DONE')) return { kind: 'done' }
      const why = after(line, 'STUCK')

      return why === null ? null : { kind: 'stuck', why }
    }
    case 'reviewer':
      return isWord(line, 'CHANGES') ? { kind: 'changes' } : isWord(line, 'OK') ? { kind: 'ok' } : null
    case 'approver': {
      if (isWord(line, 'READY')) return { kind: 'ready' }
      const question = after(line, 'ASK')

      return question === null ? null : { kind: 'ask', question }
    }
  }
}
