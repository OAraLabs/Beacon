// What changed the view, written when Settings opens (src/shared/view-trail.ts): one line per opening in <profile>/logs/view-trail.log,
// so a view that jumps (Settings opened from Chats, Mission Control behind it) explains itself next time.
//
//   npm run build && npm run smoke:view-trail
import { inputLabel, keepTail, pushStep, trailLine, VIEW_TRAIL_KEEP, type ViewStep } from '@shared/view-trail'

let failures = 0
function assert(cond: boolean, label: string, extra?: unknown): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`)
  if (!cond) failures++
}

const step = (o: Partial<ViewStep>): ViewStep => ({ at: 1_000, from: 'chat', to: 'mission', how: 'change', input: null, inputAgoMs: null, ...o })

console.log('\n[smoke] === the trail ===')
{
  let t: ViewStep[] = []
  for (let i = 0; i < VIEW_TRAIL_KEEP + 5; i++) t = pushStep(t, step({ at: i }))
  assert(t.length === VIEW_TRAIL_KEEP && t[0].at === 5, `only the last ${VIEW_TRAIL_KEEP} changes are kept, oldest dropped`, t.map((s) => s.at))
}

console.log('\n[smoke] === the line ===')
{
  const line = trailLine({
    at: Date.UTC(2026, 10, 4, 15, 0, 0),
    opener: 'menu',
    view: 'mission',
    rendererUpMs: 1_500,
    steps: [
      step({ at: Date.UTC(2026, 10, 4, 14, 59, 50), from: null, to: 'mission', how: 'mount' }),
      step({ at: Date.UTC(2026, 10, 4, 14, 59, 55), from: 'mission', to: 'chat', input: 'click Chats', inputAgoMs: 12 })
    ]
  })
  assert(!line.includes('\n'), 'one line', line)
  assert(line.startsWith('2026-11-04T15:00:00.000Z settings opened (menu) on mission'), 'when, how Settings opened, the view on screen', line)
  assert(line.includes('renderer up 1.5s'), "how long the page has been up: a reload says so (it's what resets the view)", line)
  assert(line.includes('mount → mission') && line.includes('mission → chat after click Chats (12 ms)'), 'each change, and the input just before it', line)
}

console.log('\n[smoke] === what an input is called (never what was typed) ===')
{
  assert(inputLabel({ kind: 'key', key: ',', meta: true }) === 'key ⌘,', 'a shortcut by its keys')
  assert(inputLabel({ kind: 'key', key: 'a' }) === 'key (typing)' && inputLabel({ kind: 'key', key: 'A', shift: true }) === 'key (typing)', 'typing is never recorded')
  assert(inputLabel({ kind: 'key', key: 'Escape' }) === 'key Escape', 'a named key by name')
  assert(inputLabel({ kind: 'click', label: 'Chats' }) === 'click Chats', 'a click by the control it hit')
  assert(inputLabel({ kind: 'click', label: 'x'.repeat(200) }).length <= 50, 'a long label is cut short')
}

console.log('\n[smoke] === the file stays small ===')
{
  const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n'
  const kept = keepTail(text, 200)
  assert(kept.length <= 200 && kept.endsWith('line 999\n') && kept.split('\n')[0].startsWith('line '), 'whole lines from the end, within the limit', kept.slice(0, 40))
  assert(keepTail('short\n', 200) === 'short\n', 'a short file is left as it is')
}

if (failures) {
  console.log(`\n[smoke] FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[smoke] ALL PASS')
