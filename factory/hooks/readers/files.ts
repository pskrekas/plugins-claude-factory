// The one way the plugin reads a file a settings file names.
import type { Io } from '../io'

// The text of the repo file at `relative`, or null. The file is looked at
// before it is read: it must be a regular file, no larger than `maxBytes`, and
// really inside the repo once every symbolic link is followed. A link in the
// repo that leads elsewhere on the machine is not read.
export async function readInside(
  io: Io,
  root: string,
  relative: string,
  maxBytes: number,
): Promise<string | null> {
  const [base, file] = await Promise.all([io.stat(root), io.stat(`${root}/${relative}`)])
  if (base === null || file === null) return null
  if (file.kind !== 'file' || file.size > maxBytes) return null
  const inside = base.realPath.endsWith('/') ? base.realPath : base.realPath + '/'
  if (!file.realPath.startsWith(inside)) return null

  return io.readFile(file.realPath)
}

// Writes `<base>/<relative>`. No part of the path under `base` may be a
// symbolic link, and the folder the file goes into must really be where its
// path says. Agents can write in a job's `files/` folder: a link one of them
// left there must never make the plugin write somewhere else.
export async function writeInside(io: Io, base: string, relative: string, text: string): Promise<void> {
  let path = base
  for (const part of relative.split('/')) {
    path = `${path}/${part}`
    if (await io.isLink(path)) throw new Error(`a link is in the way: ${relative.slice(0, 80)}`)
  }
  const parent = path.slice(0, path.lastIndexOf('/'))
  const [top, folder] = await Promise.all([io.stat(base), io.stat(parent)])
  if (top !== null && folder !== null && folder.realPath !== top.realPath + parent.slice(base.length)) {
    throw new Error(`not inside the state folder: ${relative.slice(0, 80)}`)
  }
  await io.writeFile(path, text)
}
