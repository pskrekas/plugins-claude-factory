import { expect, test } from 'claude-code/testing'

import { azArgs, azPlaceOf, boardsPlaceOf, htmlToText, stateTag, tagsAfter, textToHtml } from '../core/azure'
import type { AzCall, AzPlace } from '../core/azure'

const PLACE: AzPlace = { org: 'https://dev.azure.com/acme', project: 'Shop', repo: 'web' }
const TAIL = '--org https://dev.azure.com/acme --detect false --output json'
const FILE = '/state/r-1/tmp/abc.txt'
const BODY = '/state/r-1/tmp/def.json'
const line = (call: AzCall) => azArgs(call)?.join(' ') ?? null

test('the place of an Azure DevOps remote: organization, project, repository', async () => {
  expect(azPlaceOf('https://dev.azure.com/acme/Shop/_git/web')).toEqual(PLACE)
  expect(azPlaceOf('https://acme@dev.azure.com/acme/Shop/_git/web')).toEqual(PLACE)
  expect(azPlaceOf('git@ssh.dev.azure.com:v3/acme/Shop/web')).toEqual(PLACE)
  expect(azPlaceOf('https://acme.visualstudio.com/Shop/_git/web')).toEqual(PLACE)
  expect(azPlaceOf('https://dev.azure.com/acme/My%20Shop/_git/web.api')).toEqual({ org: 'https://dev.azure.com/acme', project: 'My Shop', repo: 'web.api' })
  for (const remote of [
    null,
    'git@github.com:a/b.git',
    'https://dev.azure.com/acme/Shop/web',
    'https://dev.azure.com/acme/Shop/_git/web/extra',
    'https://dev.azure.com/acme/..%2Fx/_git/web',
    "https://dev.azure.com/acme/Sh'op/_git/web",
    'https://dev.azure.com/-x/Shop/_git/web',
    'https://dev.azure.com/acme/Shop/_git/--help',
    'https://dev.azure.com/acme/%E0%A4%A/_git/web',
    'https://evil.example/dev.azure.com/acme/Shop/_git/web',
  ]) {
    expect([remote, azPlaceOf(remote)]).toEqual([remote, null])
  }
})

const EVERY: AzCall[] = [
  { do: 'item', place: PLACE, id: '12' },
  { do: 'item-comments', place: PLACE, id: '12' },
  { do: 'query', place: PLACE, mark: 'factory' },
  { do: 'set-tags', place: PLACE, id: '12', tags: ['bug', 'factory', 'factory:in-progress'] },
  { do: 'discuss', place: PLACE, id: '12', file: FILE },
  { do: 'link-item', place: PLACE, pr: 7, id: '12' },
  { do: 'me' },
  { do: 'pr-open', place: PLACE, head: 'factory/12-add-dark-mode', base: 'main', titleFile: FILE, bodyFile: '/state/r-1/tmp/b.txt' },
  { do: 'pr-show', place: PLACE, pr: 7 },
  { do: 'pr-of-branch', place: PLACE, branch: 'feature/x' },
  { do: 'pr-policies', place: PLACE, pr: 7 },
  { do: 'pr-ready', place: PLACE, pr: 7 },
  { do: 'pr-abandon', place: PLACE, pr: 7 },
  { do: 'pr-thread', place: PLACE, pr: 7, file: BODY },
]

test('every az call of the factory, word for word', async () => {
  expect(EVERY.map(line)).toEqual([
    `az boards work-item show --id 12 --expand fields ${TAIL}`,
    `az devops invoke --area wit --resource comments --route-parameters project=Shop workItemId=12 --query-parameters $top=50 order=desc --api-version 7.1-preview ${TAIL}`,
    `az boards query --wiql SELECT [System.Id], [System.Title], [System.State], [System.Tags] FROM WorkItems WHERE [System.TeamProject] = 'Shop' AND [System.Tags] CONTAINS 'factory' AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') ORDER BY [System.Id] --project Shop ${TAIL}`,
    `az boards work-item update --id 12 --fields=System.Tags=bug; factory; factory:in-progress ${TAIL}`,
    `az boards work-item update --id 12 --discussion=@${FILE} ${TAIL}`,
    `az repos pr work-item add --id 7 --work-items 12 ${TAIL}`,
    'az account show --query user.name --output tsv',
    `az repos pr create --draft true --source-branch factory/12-add-dark-mode --target-branch main --title=@${FILE} --description=@/state/r-1/tmp/b.txt --project Shop --repository web ${TAIL}`,
    `az repos pr show --id 7 ${TAIL}`,
    `az repos pr list --source-branch feature/x --status all --top 1 --project Shop --repository web ${TAIL}`,
    `az repos pr policy list --id 7 ${TAIL}`,
    `az repos pr update --id 7 --draft false ${TAIL}`,
    `az repos pr update --id 7 --status abandoned ${TAIL}`,
    `az devops invoke --area git --resource pullRequestThreads --route-parameters project=Shop repositoryId=web pullRequestId=7 --http-method POST --in-file ${BODY} --api-version 7.1 ${TAIL}`,
  ])
  // The WIQL text is one argument, and so is the list of tags.
  expect(azArgs(EVERY[2] as AzCall)?.[4]?.startsWith('SELECT ')).toBe(true)
  expect(azArgs(EVERY[3] as AzCall)?.[6]).toBe('--fields=System.Tags=bug; factory; factory:in-progress')
  // No tag at all clears the field.
  expect(azArgs({ do: 'set-tags', place: PLACE, id: '12', tags: [] })?.[6]).toBe('--fields=System.Tags=')
})

test('a value that breaks a rule gives no call at all', async () => {
  const bad: AzCall[] = [
    { do: 'item', place: PLACE, id: '12; rm' },
    { do: 'item', place: PLACE, id: '' },
    { do: 'item', place: { ...PLACE, org: 'https://evil.example/acme' }, id: '12' },
    { do: 'item', place: { ...PLACE, org: '--help' }, id: '12' },
    { do: 'query', place: PLACE, mark: "x' OR 1=1 --" },
    { do: 'query', place: { ...PLACE, project: "Sh'op" }, mark: 'factory' },
    { do: 'set-tags', place: PLACE, id: '12', tags: ['a; b'] },
    { do: 'set-tags', place: PLACE, id: '12', tags: ['a\nb'] },
    { do: 'set-tags', place: PLACE, id: '12', tags: [''] },
    { do: 'discuss', place: PLACE, id: '12', file: 'relative.txt' },
    { do: 'discuss', place: PLACE, id: '12', file: '/state/../etc/hosts.txt' },
    { do: 'discuss', place: PLACE, id: '12', file: '/etc/hosts' },
    { do: 'link-item', place: PLACE, pr: 0, id: '12' },
    { do: 'pr-open', place: PLACE, head: 'main', base: 'main', titleFile: FILE, bodyFile: FILE },
    { do: 'pr-open', place: PLACE, head: 'factory/../x', base: 'main', titleFile: FILE, bodyFile: FILE },
    { do: 'pr-open', place: PLACE, head: 'factory/12-x', base: '--help', titleFile: FILE, bodyFile: FILE },
    { do: 'pr-open', place: { ...PLACE, repo: '--help' }, head: 'factory/12-x', base: 'main', titleFile: FILE, bodyFile: FILE },
    { do: 'pr-of-branch', place: PLACE, branch: '-x' },
    { do: 'pr-show', place: PLACE, pr: 1.5 },
    { do: 'pr-thread', place: PLACE, pr: 7, file: '/state/r-1/tmp/x.sh' },
  ]
  for (const call of bad) expect([JSON.stringify(call).slice(0, 100), azArgs(call)]).toEqual([JSON.stringify(call).slice(0, 100), null])
})

test('the factory cannot complete a pull request, and az reads no outside text as a file or an option', async () => {
  const lists = EVERY.map(call => azArgs(call) ?? [])
  expect(lists.every(list => list.length > 0)).toBe(true)
  const banned = ['completed', '--auto-complete', '--bypass-policy', '--bypass-policy-reason', '--delete-source-branch', '--squash', '--open', '--transition-work-items', '--merge-commit-message']
  for (const list of lists) {
    expect(list[0]).toBe('az')
    for (const word of list) {
      expect([word, banned.some(flag => word === flag || word.startsWith(flag + '='))]).toEqual([word, false])
      // `az` loads a word that starts with `@` from a file: no word starts with one.
      expect([word, word.startsWith('@')]).toEqual([word, false])
      // After `=`, only a file of the plugin's own.
      if (word.includes('=@')) expect(/^--(title|description|discussion)=@\/state\/r-1\/tmp\/[a-z]+\.txt$/.test(word)).toBe(true)
    }
    // Every call but "who am I" names its organization, and lets az detect none.
    if (list[1] !== 'account') {
      expect(list[list.indexOf('--org') + 1]).toBe('https://dev.azure.com/acme')
      expect(list[list.indexOf('--detect') + 1]).toBe('false')
    }
  }
  // The extension reads a version as a number, after it takes `-preview` out: `7.1-preview.4` stops the call.
  for (const version of lists.flatMap(list => list.filter((_, i) => list[i - 1] === '--api-version'))) {
    expect([version, Number.isFinite(Number(version.replace('-preview', '')))]).toEqual([version, true])
  }
  // The only words after `--status` are `abandoned` (a dropped job) and `all` (a list).
  expect(lists.flatMap(list => list.filter((_, i) => list[i - 1] === '--status'))).toEqual(['all', 'abandoned'])
  expect(lists.flatMap(list => list.filter((_, i) => list[i - 1] === '--draft'))).toEqual(['true', 'false'])
})

test("a work item's HTML becomes plain text, and the plugin's text becomes safe HTML", async () => {
  expect(htmlToText('<p>a &amp; b</p><script>alert(1)</script><br>c')).toBe('a & b\n\nc')
  expect(htmlToText('<div>one</div><div>two<br/>three</div><style>p{}</style><ul><li>x</li><li>y</li></ul>')).toBe('one\ntwo\nthree\nx\ny')
  expect(htmlToText('&lt;b&gt; &quot;q&quot; &#39;s&#39; &nbsp;&#x41;&#66; &unknown;')).toBe('<b> "q" \'s\'  AB &unknown;')
  expect(htmlToText('<a href="https://example.com/x">link</a> <img src=x onerror=alert(1)>')).toBe('link')
  expect(htmlToText('')).toBe('')
  expect(htmlToText('x'.repeat(30_000)).length).toBe(20_000)
  expect(htmlToText('<p>' + 'y'.repeat(50) + '</p>', 10)).toBe('y'.repeat(10))
  // No control character but a line end comes through.
  expect(htmlToText('a\u001b[2Jb\u0000c')).toBe('a[2Jbc')
  expect(textToHtml('<b>&\n')).toBe('&lt;b&gt;&amp;<br>')
  expect(textToHtml('The factory started on this.\n\n"quoted" <script>')).toBe('The factory started on this.<br><br>&quot;quoted&quot; &lt;script&gt;')
})

test("the state is one tag; a person's own tags are kept", async () => {
  expect(stateTag('factory', 'in-progress')).toBe('factory:in-progress')
  // Tags are the same tag whatever their case, on Azure DevOps.
  expect(tagsAfter(['bug', 'factory', 'factory:in-progress', 'Factory:x', 'factory-notes'], 'factory', 'needs-human')).toEqual(['bug', 'factory', 'factory-notes', 'factory:needs-human'])
  expect(tagsAfter(['factory'], 'factory', 'done')).toEqual(['factory', 'factory:done'])
  expect(tagsAfter(['factory', 'factory:needs-human'], 'factory', 'rejected')).toEqual(['factory', 'factory:rejected'])
  expect(tagsAfter([], 'factory', 'in-progress')).toEqual(['factory:in-progress'])
})

test('where the work items are: the remote says it, or the settings do', async () => {
  const azure = 'https://dev.azure.com/acme/Shop/_git/web'
  // The remote's own project.
  expect(boardsPlaceOf(azure, null)).toEqual(PLACE)
  // Another project of the same organization.
  expect(boardsPlaceOf(azure, 'Board Room')).toEqual({ ...PLACE, project: 'Board Room' })
  // Code on GitHub, work items on Azure DevOps: the settings name the organization and the project.
  expect(boardsPlaceOf('git@github.com:a/b.git', 'acme/Shop')).toEqual({ org: 'https://dev.azure.com/acme', project: 'Shop', repo: 'Shop' })
  // The same organization as the remote may be named in full. Another one is not taken: the remote says where the person works.
  expect(boardsPlaceOf(azure, 'acme/Board Room')).toEqual({ ...PLACE, project: 'Board Room' })
  expect(boardsPlaceOf(azure, 'other/Shop')).toBe(null)
  for (const [remote, project] of [['git@github.com:a/b.git', null], ['git@github.com:a/b.git', 'Shop'], [null, null], [azure, "Sh'op"], [azure, 'a/b/c'], [azure, '-x/Shop'], [azure, 'acme/--help']] as const) {
    expect([remote, project, boardsPlaceOf(remote, project)]).toEqual([remote, project, null])
  }
})

test('hostile HTML does not hold up the session: the text is made in one pass', async () => {
  const started = Date.now()
  // Many tags that never close, many scripts that never end, a script inside a script.
  expect(htmlToText('<'.repeat(200_000))).toBe('<'.repeat(20_000))
  expect(htmlToText('<script>'.repeat(25_000))).toBe('')
  expect(htmlToText('a<style>b'.repeat(20_000))).toBe('a')
  expect(htmlToText('x<SCRIPT type="a">one</script>y<script>two</SCRIPT >z<script>never ends')).toBe('xyz')
  expect(htmlToText('a < b and c > d <e>f')).toBe('a < b and c > d f')
  expect(Date.now() - started).toBeLessThan(2_000)
})
