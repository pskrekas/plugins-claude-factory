// Small checks the settings parsers share. Pure.

export const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''

// A path the plugin reads must stay in the repo: what it finds there is shown
// in the panel and told to the model, so a settings file must not be able to
// point it at a file elsewhere on the machine.
export function isInside(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('~') || path.includes('\\')) return false
  if (CONTROL_CHAR.test(path)) return false

  return !path.split('/').includes('..')
}
