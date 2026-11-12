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
