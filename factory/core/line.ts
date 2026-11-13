// The factory line as rows of the pane (design 4.2): the stations with a count
// under each, the loops back to Build, one row of cells per job, the jobs that
// wait for the person, the queue and the day's totals. Pure.
import type { FactoryView, JobStage, JobView } from './model'
import { clean, cutTo, displayWidth, fit, padTo, wrap } from './rows'
import type { Row, Tone } from './rows'

export const STATIONS: readonly string[] = [
  'Queue',
  'Intake',
  'Spec',
  'Build',
  'Gate',
  'Review',
  'Approve',
  'You',
]

// The station a stage is at: 1 Intake … 6 Approve. A job that waits is at You.
const STATION: Record<JobStage, number> = {
  intake: 1,
  spec: 2,
  build: 3,
  gate: 4,
  review: 5,
  approve: 6,
  'needs-info': 7,
  'needs-human': 7,
  ready: 7,
  done: 7,
  rejected: 7,
}
const YOU = 7

const WIDE = 69 // the full line needs this many columns
const LINE = ' Queue -> Intake -> Spec -> Build -> Gate -> Review -> Approve -> You'
// Where each station's count starts, under its name.
const COUNT_AT = [3, 12, 21, 30, 38, 47, 58, 67]
const LOOPS = [
  '                              ^       │        │',
  '                              ├─fail──┘        │',
  '                              └─── changes ────┘',
]

const CELLS_WIDE = 60 // seven cells of 9 and 6 x 7
const CELLS_SHORT = 40 // seven cells of 9 and 6 x 4
const ID_WIDTH = 9

const isRunning = (job: JobView) => STATION[job.stage] < YOU
export const isWaitingForYou = (job: JobView) =>
  job.stage === 'needs-info' || job.stage === 'needs-human' || job.stage === 'ready'
const isOnLoop = (view: FactoryView, by: 'gate' | 'review') =>
  view.jobs.some(job => job.stage === 'build' && job.sentBack?.by === by)

const plain = (left: string, right: string, tone: Tone, rightTone: Tone, columns: number): Row => ({
  ...fit(clean(left), clean(right), columns),
  tone,
  rightTone,
})
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const money = (usd: number | null) => (usd === null ? 'cost unknown' : `$${usd.toFixed(2)}`)

// How many jobs run, and how many wait for the person: of all jobs, not only
// of those the view holds.
export function jobCounts(view: FactoryView): { run: number; need: number } {
  return { run: view.running, need: view.waiting }
}

// The number of jobs at each station, for any list of jobs.
export function countsFor(jobs: { stage: JobStage }[], queue: number | null): number[] {
  const counts = STATIONS.map(() => 0)
  counts[0] = queue ?? 0
  for (const job of jobs) {
    if (job.stage === 'done' || job.stage === 'rejected') continue
    const at = STATION[job.stage]
    counts[at] = (counts[at] ?? 0) + 1
  }

  return counts
}

export function countsOf(view: FactoryView): number[] {
  return STATIONS.map((_, station) => view.counts[station] ?? 0)
}

const countTone = (count: number, station: number): Tone =>
  count === 0 ? 'dim' : station === YOU ? 'bad' : 'plain'

type Models = NonNullable<FactoryView['models']>
// Where each station's name starts in LINE: Intake, Spec, Build, Gate, Review, Approve.
const NAME_AT = [10, 20, 28, 37, 45, 55]
// The model of each station under its name. The gate is the plugin's code.
function modelsWide(models: Models): string {
  const words = [models.intake, models.spec, models.builder, 'code', models.reviewer, models.approver]

  return words.reduce((line, word, i) => line.padEnd(NAME_AT[i] ?? line.length + 1) + clean(word).slice(0, 7), '').trimEnd()
}
// The short form: each model once, with the first letters of its stations.
function modelsShort(models: Models): string {
  const by = new Map<string, string[]>()
  for (const [letter, model] of [['I', models.intake], ['S', models.spec], ['B', models.builder], ['R', models.reviewer], ['A', models.approver]] as const) {
    by.set(model, [...(by.get(model) ?? []), letter])
  }

  return [...by].map(([model, letters]) => `${clean(model).slice(0, 7)} ${letters.join(' ')}`).join(' · ')
}

export function lineRows(view: FactoryView, columns: number): Row[] {
  const counts = countsOf(view)
  const gate = isOnLoop(view, 'gate')
  const review = isOnLoop(view, 'review')
  const row = (cells: { text: string; tone: Tone }[]): Row => ({
    left: '',
    right: '',
    tone: 'plain',
    rightTone: 'plain',
    cells,
  })

  if (columns >= WIDE) {
    // Each count is a cell, padded so that it starts under its station.
    let at = 0
    const cells = counts.map((count, station) => {
      const text = ' '.repeat(Math.max(0, (COUNT_AT[station] ?? 0) - at)) + count
      at += text.length + 1

      return { text, tone: countTone(count, station) }
    })
    const lit = [gate || review, gate || review, review]

    return [
      { left: LINE, right: '', tone: 'head', rightTone: 'plain' },
      ...(view.models ? [{ left: modelsWide(view.models), right: '', tone: 'dim' as Tone, rightTone: 'plain' as Tone }] : []),
      row(cells),
      ...LOOPS.map((left, i): Row => ({ left, right: '', tone: lit[i] ? 'warn' : 'dim', rightTone: 'plain' })),
    ]
  }

  // The short form: the first letter of each station and its count.
  const cellsFor = (you: string, withZeros: boolean) =>
    counts
      .map((count, station) => ({
        text: (station === YOU ? you : (STATIONS[station] ?? '').charAt(0)) + count,
        tone: countTone(count, station),
        count,
      }))
      .filter(cell => withZeros || cell.count > 0)
      .map(({ text, tone }) => ({ text, tone }))
  const widthOf = (cells: { text: string }[]) => cells.map(cell => cell.text).join(' ').length
  // Too narrow: a shorter word for You, then without the empty stations, then
  // without the stations at the start. The jobs that wait for the person are
  // the last cell, and the last to go.
  let cells = cellsFor('You', true)
  if (widthOf(cells) > columns) cells = cellsFor('Y', true)
  if (widthOf(cells) > columns) {
    const you = cells.at(-1)
    cells = [...cellsFor('Y', false).filter(cell => cell !== you && !cell.text.startsWith('Y')), ...(you ? [you] : [])]
  }
  while (cells.length > 1 && widthOf(cells) > columns) cells.shift()

  const loops = [gate ? 'gate' : null, review ? 'review' : null].filter(Boolean).join(', ')
  const rows = [row(cells)]
  if (view.models) rows.push(plain(modelsShort(view.models), '', 'dim', 'plain', columns))
  if (loops !== '') rows.push(plain(`↺ ${loops}`, '', 'warn', 'plain', columns))

  return rows
}

// The six station cells of a job: what happened at Intake … Approve.
function stationCells(job: JobView, isShort: boolean): { text: string; tone: Tone }[] {
  const words = isShort
    ? { done: 'ok', now: 'now', none: '-', fail: 'fail', changes: 'chg', you: 'you' }
    : { done: 'done', now: 'now', none: '-', fail: 'fail', changes: 'changes', you: 'you' }
  const isAsking = job.stage === 'needs-info' || job.stage === 'needs-human'
  const at = isAsking ? STATION[job.stoppedIn ?? 'intake'] : STATION[job.stage]
  const isBack = job.stage === 'build' && job.sentBack !== null

  return [1, 2, 3, 4, 5, 6].map(station => {
    if (isBack && station === 4 && job.sentBack?.by === 'gate') return { text: words.fail, tone: 'warn' }
    if (isBack && station === 5 && job.sentBack?.by === 'review') return { text: words.changes, tone: 'warn' }
    if (station < at) return { text: words.done, tone: 'good' }
    if (station === at) return isAsking ? { text: words.you, tone: 'bad' } : { text: words.now, tone: 'head' }

    return { text: words.none, tone: 'dim' }
  })
}

export function jobRows(job: JobView, columns: number): Row[] {
  const id = clean(job.itemId)
  const sender = job.sentBack ? ` · ${job.sentBack.by} sent it back: ${job.sentBack.why}` : ''
  // What runs now comes first: it is what a person looks for.
  const now =
    job.work === null
      ? ''
      : `${job.work.count === 1 ? `${job.work.text} runs` : `${job.work.count} ${job.work.text} run`} · ${job.work.minutes} m · `
  const meta =
    `${now}${job.tries > 0 ? 'second try · ' : ''}${job.round > 1 ? '↺ ' : ''}round ${job.round} of ${job.maxRounds}${sender}` +
    ` · ${job.minutes} m · ${money(job.costUsd)}`
  const second = plain(meta, '', 'dim', 'plain', columns)

  if (columns < CELLS_SHORT) return [plain(id, job.stage, 'plain', 'dim', columns), second]


  const width = columns >= CELLS_WIDE ? 7 : 4
  const cells: { text: string; tone: Tone }[] = [
    { text: idCell(id), tone: 'plain' },
    ...stationCells(job, width === 4).map(cell => ({ text: cell.text.padEnd(width), tone: cell.tone })),
  ]

  return [{ left: '', right: '', tone: 'plain', rightTone: 'plain', cells }, second]
}

// An item id in its cell. A long id keeps its end: ids of one project differ there.
function idCell(id: string): string {
  if (displayWidth(id) <= ID_WIDTH) return padTo(id, ID_WIDTH)
  const chars = [...id]
  let tail = ''
  while (chars.length > 0 && displayWidth((chars.at(-1) ?? '') + tail) <= ID_WIDTH - 1) tail = chars.pop() + tail

  return padTo('…' + tail, ID_WIDTH)
}

// The names of the stations over the job cells, each over its column.
function headerRow(columns: number): Row | null {
  if (columns < CELLS_SHORT) return null
  const names =
    columns >= CELLS_WIDE
      ? ['INTAKE', 'SPEC', 'BUILD', 'GATE', 'REVIEW', 'APPROVE']
      : ['INT', 'SPEC', 'BLD', 'GATE', 'REV', 'APR']
  const width = columns >= CELLS_WIDE ? 7 : 4

  return {
    left: '',
    right: '',
    tone: 'dim',
    rightTone: 'plain',
    cells: [' '.repeat(ID_WIDTH), ...names.map(name => name.padEnd(width))].map(text => ({ text, tone: 'dim' as Tone })),
  }
}

function waitingRow(job: JobView, columns: number): Row {
  const id = clean(job.itemId)
  if (job.stage === 'ready') {
    const pr = job.prNumber === null ? 'The pull request' : `PR ${job.prNumber}`

    return plain(`${id}  ${pr} is ready. You merge.`, '', 'plain', 'plain', columns)
  }

  return plain(`${id}  ${job.question ?? 'needs you'}`, '', 'plain', 'plain', columns)
}

// A claimed item with no job here: its state folder was lost, or another
// machine runs it. Only the person can say which.
const claimedRow = (id: string, columns: number): Row =>
  plain(`${id}  claimed in the tracker, no job here. /factory reject ${id} <reason>, or run it again.`, '', 'plain', 'plain', columns)

// The right side of the head row: who runs the line, and that it is stopped.
function headRight(view: FactoryView): string {
  const who =
    view.lock === 'mine'
      ? `${view.running} of ${view.slots} slots busy`
      : view.lock === 'theirs'
        ? 'another session runs the line'
        : view.running > 0
          ? 'no session runs the line'
          : ''
  if (!view.isStopped) return who

  return who === '' ? 'stopped' : `${who} · stopped`
}

// One row of a dry run: what Intake said of an item.
function planText(row: FactoryView['plan'][number]): string {
  const id = clean(row.itemId)
  if (row.verdict === 'accept') return `${id}  accept · risk ${row.risk ?? 'unknown'}${row.note === '' ? '' : ` · ${row.note}`}`
  if (row.verdict === 'needs-info') return `${id}  asks: ${row.note}`
  if (row.verdict === 'reject') return `${id}  reject: ${row.note}`

  return row.verdict === 'running' ? `${id}  Intake runs` : `${id}  failed: ${row.note}`
}

export function factoryRows(view: FactoryView, columns: number): Row[] {
  const { jobs, today } = view
  const isEmpty =
    view.running === 0 &&
    view.waiting === 0 &&
    (view.queue ?? 0) === 0 &&
    today.finished === 0 &&
    view.plan.length === 0 &&
    view.note === null
  if (isEmpty) return []

  const running = jobs.filter(isRunning)
  const waiting = jobs.filter(isWaitingForYou)
  const header = running.length > 0 ? headerRow(columns) : null
  const rows: Row[] = [
    plain('FACTORY', headRight(view), 'head', 'dim', columns),
    ...lineRows(view, columns),
    ...(header ? [header] : []),
    ...running.flatMap(job => jobRows(job, columns)),
  ]
  // Each "more" line sits under the list it cuts short.
  if (view.moreRunning > 0) rows.push(plain(`+ ${view.moreRunning} more running`, '', 'dim', 'plain', columns))
  if (view.waiting > 0) {
    rows.push(plain(`NEEDS YOU (${view.waiting})`, '', 'bad', 'plain', columns))
    rows.push(...waiting.map(job => waitingRow(job, columns)))
    if (view.moreWaiting > 0) rows.push(plain(`+ ${view.moreWaiting} more wait`, '', 'dim', 'plain', columns))
    rows.push(...view.claimed.map(id => claimedRow(clean(id), columns)))
  }
  if (view.plan.length > 0) {
    rows.push(plain('PLAN', '', 'head', 'plain', columns))
    rows.push(...view.plan.map(row => plain(planText(row), '', row.verdict === 'accept' && row.note === '' ? 'good' : 'plain', 'plain', columns)))
    if (view.plan.every(row => row.verdict !== 'running')) {
      const go = view.plan.filter(row => row.verdict === 'accept' && row.note === '').length
      rows.push(plain(`${plural(go, 'item')} would run now. /factory run starts the line.`, '', 'dim', 'plain', columns))
    }
  }
  if (view.queue !== null) {
    rows.push(plain(`QUEUE  ${plural(view.queue, 'item')} with the mark`, '', 'dim', 'plain', columns))
  }
  if (today.finished > 0) {
    const score = today.done > 0 ? ` · ${today.firstRound} of ${today.done} passed in round 1` : ''
    rows.push(
      plain(`TODAY  ${today.done} done · ${today.minutes} m · ${money(today.costUsd)}${score}`, '', 'dim', 'plain', columns),
    )
  }
  // The note says how to fix what went wrong: wrapped, never cut, as a line to approve.
  if (view.note !== null) rows.push(...wrap(clean(view.note), columns).map(piece => plain(piece, '', 'dim', 'plain', columns)))

  return rows
}
