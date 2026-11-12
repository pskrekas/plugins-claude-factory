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

// Writes `<base>/<relative>`, where `base` is the plugin's state folder.
//
// The plugin never writes into a folder an agent may write to; these checks
// are for the day that rule is broken, or the folder was changed from outside:
// - no part of the path under `base` is a symbolic link;
// - the folder the file goes into exists and really is where its path says
//   (it fails closed when it cannot tell);
// - what is at the name now, if anything, is a plain file;
// - the text is written to a fresh file in `<base>/tmp` and put in place by
//   one rename. A rename replaces the name: it never writes through a hard
//   link to whatever else that name is, and a reader never sees half a file;
// - after the rename the file is where it should be.
// `isGood`, when given, sees the text as it reads back before it is put in place.
export async function writeInside(
  io: Io,
  base: string,
  relative: string,
  text: string,
  isGood?: (back: string) => boolean,
): Promise<void> {
  const brief = relative.slice(0, 80)
  const outside = () => new Error(`not inside the state folder: ${brief}`)
  let path = base
  for (const part of relative.split('/')) {
    path = `${path}/${part}`
    if (await io.isLink(path)) throw new Error(`a link is in the way: ${brief}`)
  }
  const parent = path.slice(0, path.lastIndexOf('/'))
  await io.run(['mkdir', '-p', parent])
  const [top, folder] = await Promise.all([io.stat(base), io.stat(parent)])
  if (top === null || folder === null || folder.kind !== 'dir') throw outside()
  if (folder.realPath !== top.realPath + parent.slice(base.length)) throw outside()
  const there = await io.stat(path)
  if (there !== null && there.kind !== 'file') throw new Error(`not a file: ${brief}`)

  const fresh = () => Math.random().toString(36).slice(2)
  const temp = `${base}/tmp/${fresh()}${fresh()}.tmp`
  await io.writeFile(temp, text)
  if (isGood) {
    const back = await io.readFile(temp)
    if (back === null || !isGood(back)) throw new Error(`did not read back: ${brief}`)
  }
  const moved = await io.run(['mv', '-f', temp, path])
  if ('failed' in moved || moved.exitCode !== 0) throw new Error(`could not be put in place: ${brief}`)
  const after = await io.stat(path)
  if (after === null || after.kind !== 'file' || after.realPath !== top.realPath + path.slice(base.length)) {
    throw outside()
  }
}
