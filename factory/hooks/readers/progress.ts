// Reads the progress files and the owed list the settings name. These are
// plain files of the repo: reading them runs nothing, so no approval is needed.
import type { ProgressState } from '../../core/model'
import { nameOf, parseOwed, parseProgress, segmentPattern } from '../../core/progress'
import { readInside } from './files'
import type { Io } from '../io'
import type { Reader } from '../refresh'

const MAX_FILES = 8
const MAX_CANDIDATES = 50
const MAX_BYTES = 1024 * 1024

const join = (base: string, name: string) => (base === '' ? name : `${base}/${name}`)

// The repo-relative paths a glob names, found by listing one folder per `*`.
async function expand(io: Io, root: string, pattern: string): Promise<string[]> {
  let found = ['']
  const segments = pattern.split('/')
  for (const [i, segment] of segments.entries()) {
    const isLast = i === segments.length - 1
    const next: string[] = []
    for (const base of found) {
      if (!segment.includes('*')) {
        next.push(join(base, segment))
        continue
      }
      const wanted = segmentPattern(segment)
      for (const entry of await io.listDir(`${root}/${base}`)) {
        const isDir = entry.endsWith('/')
        const name = isDir ? entry.slice(0, -1) : entry
        // A folder in the middle of the path, a file at its end.
        if (isDir !== isLast && wanted.test(name)) next.push(join(base, name))
      }
    }
    found = next.slice(0, MAX_CANDIDATES)
  }

  return found.sort().slice(0, MAX_FILES)
}

export const progressReader: Reader = {
  name: 'progress',
  read: async (io, ctx) => {
    const { progress, owed } = ctx.settings
    const items: ProgressState[] = []
    if (progress) {
      for (const path of await expand(io, ctx.root, progress.files)) {
        const text = await readInside(io, ctx.root, path, MAX_BYTES)
        if (text === null) continue
        items.push({ name: nameOf(text, path), path, ...parseProgress(text, progress) })
      }
    }
    const owedText = owed ? await readInside(io, ctx.root, owed, MAX_BYTES) : null

    return { progress: items, owed: owedText === null ? null : parseOwed(owedText) }
  },
}
