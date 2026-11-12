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

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

// SHA-256 of a text (as UTF-8), in hex. Written out here because a hooks
// module has no synchronous digest, and the folder name must be a pure value.
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 0x100000000))
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!
      const y = w[i - 2]!
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!]
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, hh].forEach((value, i) => {
      h[i] = (h[i]! + value) >>> 0
    })
  }

  return [...h].map(word => word.toString(16).padStart(8, '0')).join('')
}

const HASH_CHARS = 16

// One folder name per repository: the end of its path in plain characters, so
// a person can tell which repo it is, and the start of the SHA-256 of the whole
// path, so two repos do not share one. The store also writes the path into the
// folder and checks it (hooks/jobs.ts): a name is never the only proof.
export function stateFolderOf(repoKey: string): string {
  const words = repoKey.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const slug = words.join('-').slice(-MAX_SLUG).replace(/^-+/, '')

  return (slug === '' ? '' : slug + '-') + sha256Hex(repoKey).slice(0, HASH_CHARS)
}
