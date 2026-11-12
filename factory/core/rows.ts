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

// Splits `text` into pieces of at most `columns`, losing nothing.
export function wrap(text: string, columns: number): string[] {
  const width = Math.max(1, columns)
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += width) pieces.push(text.slice(i, i + width))

  return pieces.length > 0 ? pieces : ['']
}

// Cuts `left` (then `right`) so that `left + ' ' + right` fits in `columns`.
export function fit(left: string, right: string, columns: number): { left: string; right: string } {
  const cut = (text: string, room: number): string => {
    if (text.length <= room) return text
    if (room <= 0) return ''

    return text.slice(0, room - 1) + '…'
  }
  // The right side never takes more than half the row from a name on the left.
  const r = cut(right, left === '' ? columns : Math.max(1, Math.floor(columns / 2)))
  const room = r ? columns - r.length - 1 : columns

  return { left: cut(left, Math.max(0, room)), right: r }
}
