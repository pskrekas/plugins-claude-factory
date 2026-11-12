// Where the factory keeps its state: in a folder of the person's own, never in
// the repo. A repo can be handed to someone with any files in it, also with job
// files that say whatever their author likes; a folder under the person's home
// cannot. Pure.

const NAME = 'claude-factory'
const MAX_SLUG = 48

const isAbsolute = (path: string | undefined): path is string => path !== undefined && path.startsWith('/')

// `$XDG_STATE_HOME/claude-factory` when that is set to an absolute path, else
// `$HOME/.local/state/claude-factory`; null when there is no home folder.
export function stateBaseOf(home: string | undefined, xdgStateHome: string | undefined): string | null {
  if (isAbsolute(xdgStateHome)) return `${xdgStateHome.replace(/\/+$/, '')}/${NAME}`
  if (isAbsolute(home)) return `${home.replace(/\/+$/, '')}/.local/state/${NAME}`

  return null
}

// FNV-1a, 32 bits, as 8 hex digits. It only tells two repos' folders apart; it
// guards nothing.
function hash8(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

// One folder name per repository: the end of its path in plain characters, so
// a person can tell which repo it is, and a hash of the whole path, so two
// repos never share one.
export function stateFolderOf(repoKey: string): string {
  const words = repoKey.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const slug = words.join('-').slice(-MAX_SLUG).replace(/^-+/, '')

  return (slug === '' ? '' : slug + '-') + hash8(repoKey)
}
