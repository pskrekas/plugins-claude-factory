// Azure DevOps through the `az` command: where a remote is, and every `az`
// call the factory makes, as a plain argument list. Pure.
//
// This is the whole list (docs/notes/az-check.md). The factory never
// completes (merges) a pull request: no call here holds `--status completed`,
// `--auto-complete` or `--bypass-policy`, and a test checks every list.
//
// `az` loads a word that starts with `@` from a file of the person's machine
// (also after `=`). So no word of outside text is ever an argument: a title,
// a description and a comment are written to a file of the plugin's own, and
// the argument is `--<name>=@<that file>`. Every other value is checked
// against a rule that leaves no `@` and no `-` at its start.
import type { TrackerState } from '../adapters/tracker'
import { isJobId } from './job'
import { isBranchName, isMark } from './settings'

// `org` is the organization's address, `https://dev.azure.com/<name>`.
export type AzPlace = { org: string; project: string; repo: string }

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/
// A project or a repository: no `'` (it goes into a query text), no `/`, never an option.
const PART = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const ORG_URL = /^https:\/\/dev\.azure\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,49})$/
const FORMS = [
  /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/?$/,
  /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)\/?$/,
  /^https:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)\/?$/,
]

function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

// The organization, the project and the repository a git remote names, or
// null when it is not an Azure DevOps remote this file can read.
export function azPlaceOf(remote: string | null): AzPlace | null {
  if (remote === null) return null
  for (const form of FORMS) {
    const found = form.exec(remote.trim())
    if (found === null) continue
    const [org, project, repo] = [found[1] ?? '', decoded(found[2] ?? ''), decoded(found[3] ?? '')]
    if (!ORG.test(org) || project === null || repo === null || !PART.test(project) || !PART.test(repo)) return null

    return { org: `https://dev.azure.com/${org}`, project, repo }
  }

  return null
}

// Where the work items of a repository are. With no `tracker.project`: the
// project of the remote. A plain name: that project, in the remote's
// organization. `<organization>/<project>`: that place, whatever the remote
// is (code on another host). Null when no organization can be found.
export function boardsPlaceOf(remote: string | null, project: string | null): AzPlace | null {
  const place = azPlaceOf(remote)
  if (project === null) return place
  const parts = project.split('/')
  if (parts.length === 1) return place !== null && PART.test(project) ? { ...place, project } : null
  const [org = '', name = ''] = parts
  if (parts.length !== 2 || !ORG.test(org) || !PART.test(name)) return null
  const url = `https://dev.azure.com/${org}`
  // An Azure DevOps remote says which organization the person works in: the
  // settings file cannot name another one.
  if (place !== null) return place.org === url ? { ...place, project: name } : null

  // The repository is not used for work items; a pull request elsewhere is linked by a comment.
  return { org: url, project: name, repo: name }
}

export type AzCall =
  | { do: 'item'; place: AzPlace; id: string }
  | { do: 'item-comments'; place: AzPlace; id: string }
  | { do: 'query'; place: AzPlace; mark: string }
  | { do: 'set-tags'; place: AzPlace; id: string; tags: string[] }
  | { do: 'discuss'; place: AzPlace; id: string; file: string }
  | { do: 'link-item'; place: AzPlace; pr: number; id: string }
  | { do: 'me' }
  | { do: 'pr-open'; place: AzPlace; head: string; base: string; titleFile: string; bodyFile: string }
  | { do: 'pr-show'; place: AzPlace; pr: number }
  | { do: 'pr-of-branch'; place: AzPlace; branch: string }
  | { do: 'pr-policies'; place: AzPlace; pr: number }
  | { do: 'pr-ready'; place: AzPlace; pr: number }
  | { do: 'pr-abandon'; place: AzPlace; pr: number }
  | { do: 'pr-thread'; place: AzPlace; pr: number; file: string }

const isPlace = (place: AzPlace) => ORG_URL.test(place.org) && PART.test(place.project) && PART.test(place.repo)
const isId = (id: string) => /^\d{1,10}$/.test(id)
const isPr = (n: number) => Number.isInteger(n) && n > 0 && n < 1e10
// A file of the plugin's own: a full path with no `..`, that ends as the plugin names its files.
const isFile = (path: string, ext: 'txt' | 'json') =>
  path.startsWith('/') && !path.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(path) && path.endsWith(`.${ext}`)
// A tag as Azure DevOps keeps it. It is always inside one argument that starts with the plugin's own words.
const isTag = (tag: string) => tag !== '' && tag === tag.trim() && tag.length <= 256 && !/[;\u0000-\u001f\u007f]/.test(tag)
const isJobBranch = (head: string) => head.startsWith('factory/') && isJobId(head.slice('factory/'.length))

// The work items of the project that carry the mark and are not closed. The
// project is in the text: `az` sends a query with no project around it.
const wiqlOf = (project: string, mark: string) =>
  'SELECT [System.Id], [System.Title], [System.State], [System.Tags] FROM WorkItems ' +
  `WHERE [System.TeamProject] = '${project}' AND [System.Tags] CONTAINS '${mark}' ` +
  "AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') ORDER BY [System.Id]"

// The argument list of a call, or null when one of its values breaks a rule.
export function azArgs(call: AzCall): string[] | null {
  if (call.do === 'me') return ['az', 'account', 'show', '--query', 'user.name', '--output', 'tsv']
  if (!isPlace(call.place)) return null
  if ('id' in call && !isId(call.id)) return null
  if ('pr' in call && !isPr(call.pr)) return null
  const { org, project, repo } = call.place
  // The place is named in full, and `az` is told to guess none of it.
  const tail = ['--org', org, '--detect', 'false', '--output', 'json']
  const inRepo = ['--project', project, '--repository', repo]

  switch (call.do) {
    case 'item':
      return ['az', 'boards', 'work-item', 'show', '--id', call.id, '--expand', 'fields', ...tail]
    case 'item-comments':
      // The newest fifty. The version has no number after `-preview`: the extension reads it as a number (az-check.md).
      return ['az', 'devops', 'invoke', '--area', 'wit', '--resource', 'comments', '--route-parameters', `project=${project}`, `workItemId=${call.id}`, '--query-parameters', '$top=50', 'order=desc', '--api-version', '7.1-preview', ...tail]
    case 'query':
      // The mark holds no `'` (a mark's own rule), nor does a project's name.
      return isMark(call.mark) ? ['az', 'boards', 'query', '--wiql', wiqlOf(project, call.mark), '--project', project, ...tail] : null
    case 'set-tags':
      // The whole list in one argument: a write replaces the field.
      return call.tags.every(isTag) ? ['az', 'boards', 'work-item', 'update', '--id', call.id, `--fields=System.Tags=${call.tags.join('; ')}`, ...tail] : null
    case 'discuss':
      return isFile(call.file, 'txt') ? ['az', 'boards', 'work-item', 'update', '--id', call.id, `--discussion=@${call.file}`, ...tail] : null
    case 'link-item':
      return ['az', 'repos', 'pr', 'work-item', 'add', '--id', String(call.pr), '--work-items', call.id, ...tail]
    case 'pr-open':
      // A draft, from a job's own branch. The title and the text are files.
      if (!isJobBranch(call.head) || !isBranchName(call.base) || !isFile(call.titleFile, 'txt') || !isFile(call.bodyFile, 'txt')) return null

      return ['az', 'repos', 'pr', 'create', '--draft', 'true', '--source-branch', call.head, '--target-branch', call.base, `--title=@${call.titleFile}`, `--description=@${call.bodyFile}`, ...inRepo, ...tail]
    case 'pr-show':
      return ['az', 'repos', 'pr', 'show', '--id', String(call.pr), ...tail]
    case 'pr-of-branch':
      return isBranchName(call.branch) ? ['az', 'repos', 'pr', 'list', '--source-branch', call.branch, '--status', 'all', '--top', '1', ...inRepo, ...tail] : null
    case 'pr-policies':
      return ['az', 'repos', 'pr', 'policy', 'list', '--id', String(call.pr), ...tail]
    case 'pr-ready':
      return ['az', 'repos', 'pr', 'update', '--id', String(call.pr), '--draft', 'false', ...tail]
    case 'pr-abandon':
      // The pull request of a job that a person dropped. Never `completed`: that is a merge.
      return ['az', 'repos', 'pr', 'update', '--id', String(call.pr), '--status', 'abandoned', ...tail]
    case 'pr-thread':
      return isFile(call.file, 'json')
        ? ['az', 'devops', 'invoke', '--area', 'git', '--resource', 'pullRequestThreads', '--route-parameters', `project=${project}`, `repositoryId=${repo}`, `pullRequestId=${call.pr}`, '--http-method', 'POST', '--in-file', call.file, '--api-version', '7.1', ...tail]
        : null
  }
}

const MAX_HTML = 200_000
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

// The HTML with every `<script>…</script>` and `<style>…</style>` taken out,
// in one pass: text from outside must not make the plugin wait. A block that
// never ends takes the rest with it.
function withoutBlocks(html: string): string {
  const lower = html.toLowerCase()
  const next = { script: lower.indexOf('<script'), style: lower.indexOf('<style') }
  let out = ''
  let at = 0
  for (;;) {
    // Each name is looked for again only from where the last one was found.
    for (const name of ['script', 'style'] as const) if (next[name] >= 0 && next[name] < at) next[name] = lower.indexOf(`<${name}`, at)
    const name = next.script >= 0 && (next.style < 0 || next.script < next.style) ? 'script' : 'style'
    const open = next[name]
    if (open < 0) return out + html.slice(at)
    out += html.slice(at, open)
    const close = lower.indexOf(`</${name}`, open)
    const end = close < 0 ? -1 : lower.indexOf('>', close)
    if (end < 0) return out
    at = end + 1
  }
}

// The text of a work item's HTML, for an agent to read as data: no tag, no
// script, no control character but a line end. Cut at `max` characters.
// Every step is one pass over the text.
export function htmlToText(html: string, max = 20_000): string {
  const text = withoutBlocks(html.slice(0, MAX_HTML))
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    // A tag starts with a letter, `/` or `!`. A `<` that starts none is text.
    .replace(/<[A-Za-z/!][^<>]*>/g, '')
    .replace(/&#x([0-9a-f]{1,6});|&#([0-9]{1,7});|&([a-z]{2,6});/gi, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (name !== undefined) return name.toLowerCase() === 'amp' ? whole : (ENTITIES[name.toLowerCase()] ?? whole)
      const code = hex !== undefined ? parseInt(hex, 16) : Number(dec)

      return code > 0x1f && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
    })
    // Last, so that `&amp;lt;` stays the text `&lt;`.
    .replace(/&amp;/gi, '&')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text.slice(0, max)
}

// The plugin's own text as HTML that shows the same text: a work item's
// discussion is HTML, and nothing in the text may be read as markup.
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n?|\n/g, '<br>')
}

// A state is one tag beside the mark: `<mark>:<state>`. An item with such a
// tag is not in the queue.
export const stateTag = (mark: string, state: TrackerState): string => `${mark}:${state}`

// The tags of a work item after the line set `state`: every tag that is not
// one of the line's state tags is kept, in its order; then the one state tag.
// Azure DevOps takes `Factory:x` and `factory:x` as one tag.
export function tagsAfter(tags: string[], mark: string, state: TrackerState): string[] {
  const own = `${mark.toLowerCase()}:`

  return [...tags.filter(tag => !tag.toLowerCase().startsWith(own)), stateTag(mark, state)]
}
