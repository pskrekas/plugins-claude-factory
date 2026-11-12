// What the factory may send to a tracker as a comment. Pure.

export const MAX_COMMENT = 60_000
const CUT = '\n(cut)'

// Control and format characters, but a comment keeps its line breaks and tabs.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

// The text as it will be sent, or why it is not sent at all. A comment that
// holds a forbidden word (a repo's settings list them; compared without case)
// is refused whole: nothing of it is sent.
export function commentOf(text: string, forbidden: string[]): { ok: string } | { no: string } {
  const clean = text.replace(HIDDEN, char => (char === '\n' || char === '\t' ? char : ''))
  if (clean.trim() === '') return { no: 'empty' }
  const lower = clean.toLowerCase()
  if (forbidden.some(word => word !== '' && lower.includes(word.toLowerCase()))) return { no: 'a forbidden word' }

  return { ok: clean.length <= MAX_COMMENT ? clean : clean.slice(0, MAX_COMMENT - CUT.length) + CUT }
}

// One line a person can read about why a command failed.
export function failureText(tool: string, result: { failed: string } | { exitCode: number; stderr: string }): string {
  if ('failed' in result) return `${tool}: could not start`
  const said = result.stderr.replace(/\s+/g, ' ').replace(HIDDEN, '').trim().slice(0, 200)

  return `${tool}: ${said || 'exit ' + result.exitCode}`
}
