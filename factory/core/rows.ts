// The rows the pane draws, and the helpers that keep a row clean and inside
// the pane's width. Pure.

export type Tone = 'plain' | 'dim' | 'good' | 'warn' | 'bad' | 'head'

// A row of the pane: a left text and a right text, or `cells` drawn one after
// the other, each in its own tone (then `left` and `right` are empty).
export type Row = {
  left: string
  right: string
  tone: Tone
  rightTone: Tone
  cells?: { text: string; tone: Tone }[]
}

// Text from a settings file, a tracker or a command's output can hold terminal
// control sequences and characters that reorder or hide text. No control
// character (Cc), format character (Cf: bidi marks, zero-width) or line or
// paragraph separator (Zl, Zp) reaches a row.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

export function clean(text: string): string {
  return text.replace(CONTROL, '')
}

const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)
const ZERO_WIDTH = /[\p{Mn}\p{Me}]/u

// The columns one character takes on a terminal: two for CJK and emoji, none
// for a combining mark, one for the rest.
function widthOfChar(char: string): number {
  if (ZERO_WIDTH.test(char)) return 0

  return isWide(char.codePointAt(0) ?? 0) ? 2 : 1
}

// The columns a text takes on screen. Text is counted by character, never by
// UTF-16 unit, so an emoji is one thing and is never cut in half.
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += widthOfChar(char)

  return width
}

// `text` cut to at most `width` columns, with `…` in its last column when cut.
export function cutTo(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  if (width <= 0) return ''
  let out = ''
  let used = 0
  for (const char of text) {
    const w = widthOfChar(char)
    if (used + w > width - 1) break
    out += char
    used += w
  }

  return out + '…'
}

// `text` padded with spaces to `width` columns.
export function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

// Splits `text` into pieces of at most `columns` on screen, losing nothing.
export function wrap(text: string, columns: number): string[] {
  const width = Math.max(1, columns)
  const pieces: string[] = []
  let piece = ''
  let used = 0
  for (const char of text) {
    const w = widthOfChar(char)
    if (used + w > width && piece !== '') {
      pieces.push(piece)
      piece = ''
      used = 0
    }
    piece += char
    used += w
  }
  pieces.push(piece)

  return pieces
}

// Cuts `left` (then `right`) so that `left + ' ' + right` fits in `columns`.
export function fit(left: string, right: string, columns: number): { left: string; right: string } {
  // The right side never takes more than half the row from a name on the left.
  const r = cutTo(right, left === '' ? columns : Math.max(1, Math.floor(columns / 2)))
  const room = r ? columns - displayWidth(r) - 1 : columns

  return { left: cutTo(left, Math.max(0, room)), right: r }
}
