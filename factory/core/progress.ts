// Parsers for progress files and the owed list. Pure.

const MAX_BLOCKED = 80

// The marks are plain text from the settings file, never patterns: a line is
// done or open when it starts with the mark (after its indent), and blocked
// when it holds the blocked mark.
export function parseProgress(
  text: string,
  marks: { done: string; open: string; blocked: string },
): { done: number; open: number; percent: number | null; blocked: string | null } {
  let done = 0
  let open = 0
  let blocked: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trimStart()
    if (line.startsWith(marks.done)) done++
    else if (line.startsWith(marks.open)) open++
    // "UNBLOCKED" holds the word "BLOCKED": a resume is looked for first.
    if (line.includes('UNBLOCKED') || line.includes('RESUMED')) blocked = null
    else if (line.includes(marks.blocked)) blocked = reasonOf(line, marks.blocked)
  }
  const total = done + open

  return { done, open, percent: total === 0 ? null : Math.round((100 * done) / total), blocked }
}

// The reason in a blocked line: its markdown marks and a leading "BLOCKED:" removed.
function reasonOf(line: string, mark: string): string {
  let text = line.trim().replace(/^[#\-*\s]+/, '')
  if (text.startsWith(mark)) text = text.slice(mark.length).replace(/^\s*:\s*/, '')

  return text.slice(0, MAX_BLOCKED) || 'blocked'
}

export function parseOwed(text: string): { open: number } {
  return { open: text.split('\n').filter(line => /^\s*- \[ \]/.test(line)).length }
}

// The first markdown heading's text, else the file's parent folder, else the path.
export function nameOf(text: string, path: string): string {
  const heading = /^#+\s+(.+?)\s*$/m.exec(text.slice(0, 4000))
  if (heading?.[1]) return heading[1].slice(0, 60)
  const parts = path.split('/')

  return parts.length > 1 ? (parts[parts.length - 2] ?? path) : path
}

// True when `name` matches one path segment of a glob, where `*` is any run
// of characters. No regular expression: the pattern comes from a settings file
// nobody approved yet, and this takes time in proportion to the name's length
// however many stars it has.
export function matchSegment(pattern: string, name: string): boolean {
  const parts = pattern.split('*')
  const first = parts[0] ?? ''
  const last = parts[parts.length - 1] ?? ''
  if (parts.length === 1) return pattern === name
  if (name.length < first.length + last.length) return false
  if (!name.startsWith(first) || !name.endsWith(last)) return false
  const end = name.length - last.length
  let at = first.length
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at)
    if (found < 0 || found + part.length > end) return false
    at = found + part.length
  }

  return true
}

// Supports `*` inside one path segment only.
export function matchGlob(pattern: string, paths: string[]): string[] {
  const segments = pattern.split('/')

  return paths.filter(path => {
    const parts = path.split('/')

    return (
      parts.length === segments.length &&
      parts.every((part, i) => matchSegment(segments[i] ?? '', part))
    )
  })
}
