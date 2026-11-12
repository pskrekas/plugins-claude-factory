// The factory line as rows of the pane (design 4.2): the stations with a count
// under each, the loops back to Build, one row of cells per job, the jobs that
// wait for the person, the queue and the day's totals. Pure.
import type { FactoryView, JobStage, JobView } from './model'
import { clean, fit } from './rows'
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

// How many jobs run, and how many wait for the person.
export function jobCounts(view: FactoryView): { run: number; need: number } {
  const run = view.jobs.filter(isRunning).length

  return { run, need: view.jobs.filter(isWaitingForYou).length }
}

export function countsOf(view: FactoryView): number[] {
  const counts = STATIONS.map(() => 0)
  counts[0] = view.queue ?? 0
  for (const job of view.jobs) {
    const at = STATION[job.stage]
    counts[at] = (counts[at] ?? 0) + 1
  }

  return counts
}

const countTone = (count: number, station: number): Tone =>
  count === 0 ? 'dim' : station === YOU ? 'bad' : 'plain'

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
  let cells = cellsFor('You', true)
  if (widthOf(cells) > columns) cells = cellsFor('Y', true)
  if (widthOf(cells) > columns) cells = cellsFor('Y', false)
  while (cells.length > 1 && widthOf(cells) > columns) cells.pop()

  const loops = [gate ? 'gate' : null, review ? 'review' : null].filter(Boolean).join(', ')
  const rows = [row(cells)]
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
  const meta =
    `${job.round > 1 ? '↺ ' : ''}round ${job.round} of ${job.maxRounds}${sender}` +
    ` · ${job.minutes} m · ${money(job.costUsd)}`
  const second = plain(meta, '', 'dim', 'plain', columns)

  if (columns < CELLS_SHORT) return [plain(id, job.stage, 'plain', 'dim', columns), second]

  const width = columns >= CELLS_WIDE ? 7 : 4
  const cells: { text: string; tone: Tone }[] = [
    { text: id.slice(0, ID_WIDTH).padEnd(ID_WIDTH), tone: 'plain' },
    ...stationCells(job, width === 4).map(cell => ({ text: cell.text.padEnd(width), tone: cell.tone })),
  ]

  return [{ left: '', right: '', tone: 'plain', rightTone: 'plain', cells }, second]
}

function waitingRow(job: JobView, columns: number): Row {
  const id = clean(job.itemId)
  if (job.stage === 'ready') {
    const pr = job.prNumber === null ? 'The pull request' : `PR ${job.prNumber}`

    return plain(`${id}  ${pr} is ready. You merge.`, '', 'plain', 'plain', columns)
  }

  return plain(`${id}  ${job.question ?? 'needs you'}`, '', 'plain', 'plain', columns)
}

export function factoryRows(view: FactoryView, columns: number): Row[] {
  const { jobs, today } = view
  const isEmpty =
    jobs.length === 0 && view.more === 0 && view.queue === null && today.finished === 0 && view.note === null
  if (isEmpty) return []

  const running = jobs.filter(isRunning)
  const waiting = jobs.filter(isWaitingForYou)
  const rows: Row[] = [
    plain('FACTORY', `${running.length} of ${view.slots} slots busy`, 'head', 'dim', columns),
    ...lineRows(view, columns),
    ...running.flatMap(job => jobRows(job, columns)),
  ]
  if (view.more > 0) rows.push(plain(`+ ${view.more} more`, '', 'dim', 'plain', columns))
  if (waiting.length > 0) {
    rows.push(plain(`NEEDS YOU (${waiting.length})`, '', 'bad', 'plain', columns))
    rows.push(...waiting.map(job => waitingRow(job, columns)))
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
  if (view.note !== null) rows.push(plain(view.note, '', 'dim', 'plain', columns))

  return rows
}
