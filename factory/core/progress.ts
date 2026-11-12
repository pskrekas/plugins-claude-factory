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

// One path segment of a glob as a pattern: `*` is any run of characters but `/`.
export function segmentPattern(segment: string): RegExp {
  const escaped = segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')

  return new RegExp(`^${escaped}$`)
}

// Supports `*` inside one path segment only.
export function matchGlob(pattern: string, paths: string[]): string[] {
  const segments = pattern.split('/').map(segmentPattern)

  return paths.filter(path => {
    const parts = path.split('/')

    return parts.length === segments.length && parts.every((part, i) => segments[i]?.test(part))
  })
}
