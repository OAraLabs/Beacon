// The sidebar list of Prometheus (docs/MULTI-PROMETHEUS.md §5), decided without a window: hidden with one, each row's dot and
// words, which AI, the "can't prove who it is" note, and the name in the window title, the composer and the unreachable banner.
//
//   npm run build && npm run smoke:instance-rows
import { ADD_PROMETHEUS, UNPROVED_NOTE, activeName, composerPlaceholder, instanceRows, switcherKey, switcherRows, titleSwitches, unreachableLine, windowTitle } from '@shared/instance-rows'
import type { InstanceSummary } from '@shared/ipc'

let failures = 0
function assert(cond: boolean, label: string, extra?: unknown): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`)
  if (!cond) failures++
}

const row = (o: Partial<InstanceSummary> & { id: string }): InstanceSummary => ({
  label: o.id,
  host: `${o.id}.example:8005`,
  pinned: false,
  proved: true,
  active: false,
  lastActive: 0,
  state: 'connected',
  ai: null,
  since: null,
  ...o
})
const clock = (ms: number): string => `T${ms}`

console.log('\n[smoke] === one Prometheus: nothing new anywhere ===')
{
  const one = [row({ id: 'home', label: 'Home mini', active: true })]
  assert(instanceRows(one, clock) === null, 'the list is hidden')
  assert(instanceRows([], clock) === null, 'and with none')
  assert(activeName(one) === null, 'no name to show')
  assert(windowTitle(one) === 'Beacon', 'the window title stays "Beacon"', windowTitle(one))
  assert(composerPlaceholder(one) === 'Message Prometheus…', 'the composer stays "Message Prometheus…"', composerPlaceholder(one))
  assert(unreachableLine(one, 'home.example') === "Can't reach Prometheus at home.example.", 'the banner stays as it was', unreachableLine(one, 'home.example'))
}

console.log('\n[smoke] === two or more: the name everywhere ===')
{
  const two = [row({ id: 'home', label: 'Home mini', active: true }), row({ id: 'office', label: 'Office' })]
  assert(activeName(two) === 'Home mini', 'the name of the one Beacon is on', activeName(two))
  assert(windowTitle(two) === 'Home mini — Beacon', 'window title "Home mini — Beacon"', windowTitle(two))
  assert(composerPlaceholder(two) === 'Message Home mini…', 'composer "Message Home mini…"', composerPlaceholder(two))
  assert(unreachableLine(two, 'home.example') === "Can't reach Home mini.", 'banner "Can\'t reach Home mini."', unreachableLine(two, 'home.example'))
  const none = [row({ id: 'home' }), row({ id: 'office' })]
  assert(activeName(none) === null && windowTitle(none) === 'Beacon', 'none active (Set up again): no name', windowTitle(none))
}

console.log('\n[smoke] === the rows ===')
{
  const list = [
    row({ id: 'z', label: 'Zeta', state: 'connected', ai: 'Anthropic (Claude) · claude-sonnet', active: true }),
    row({ id: 'a', label: 'Attic', state: 'unreachable', since: 42 }),
    row({ id: 'u', label: 'Upstairs', state: 'unreachable', since: null }),
    row({ id: 'k', label: 'Kitchen', state: 'key-refused' }),
    row({ id: 'd', label: 'Den', state: 'different' }),
    row({ id: 'n', label: 'Nook', state: 'no-proof' }),
    row({ id: 'p', label: 'Porch', state: 'refused' }),
    row({ id: 'c', label: 'Cellar', state: 'unknown' })
  ]
  const rows = instanceRows(list, clock)
  assert(rows !== null && rows.length === list.length, 'one row per Prometheus', rows?.length)
  const by = (id: string) => rows?.find((r) => r.id === id)
  const want: Array<[string, string, string]> = [
    ['z', 'green', 'Connected'],
    ['a', 'grey', "Can't reach it since T42"],
    ['u', 'grey', "Can't reach it"],
    ['k', 'red', 'No longer accepts this Beacon'],
    ['d', 'red', 'A different Prometheus answered'],
    ['n', 'red', 'No longer proves who it is'],
    ['p', 'red', 'Not encrypted'],
    ['c', 'grey', 'Checking…']
  ]
  for (const [id, dot, words] of want) {
    const r = by(id)
    assert(r?.dot === dot && r.words === words, `${r?.name ?? id}: ${dot} dot, "${words}"`, r)
  }
  assert(rows?.every((r) => r.words.length > 0) ?? false, 'every state is said in words, never in colour alone')
  assert(by('z')?.current === true && rows?.filter((r) => r.current).length === 1, 'the one Beacon is on is marked, and only it')
  assert(by('z')?.ai === 'Anthropic (Claude) · claude-sonnet' && by('a')?.ai === null, 'which AI it is on, when it said')
  assert(rows?.map((r) => r.name).join(',') === 'Attic,Cellar,Den,Kitchen,Nook,Porch,Upstairs,Zeta', 'in name order, so a switch never moves a row', rows?.map((r) => r.name))
  const connecting = instanceRows([row({ id: 'z', active: true, state: 'unknown' }), row({ id: 'y' })], clock)
  assert(connecting?.find((r) => r.id === 'z')?.dot === 'amber' && connecting?.find((r) => r.id === 'z')?.words === 'Connecting…', 'the one Beacon is on, not answered yet: amber "Connecting…"', connecting)
}

console.log("\n[smoke] === can't prove who it is ===")
{
  const rows = instanceRows([row({ id: 'old', proved: false, state: 'connected' }), row({ id: 'new', proved: true }), row({ id: 'gone', proved: false, state: 'unreachable' })], clock)
  const by = (id: string) => rows?.find((r) => r.id === id)
  assert(by('old')?.note === UNPROVED_NOTE, 'an older Prometheus that answered without proving who it is: the note in its row', by('old'))
  assert(by('new')?.note === null, 'one that proved it: no note')
  assert(by('gone')?.note === null, "one that hasn't answered: no note yet (it may still prove it)")
  assert(/can't prove who it is/i.test(UNPROVED_NOTE), 'the note says so in words', UNPROVED_NOTE)
}

console.log('\n[smoke] === names ===')
{
  const same = instanceRows([row({ id: 'a', label: 'mini', host: 'one.example:8005' }), row({ id: 'b', label: 'mini', host: 'two.example:8005' })], clock)
  assert(same?.[0].name === 'mini (one.example:8005)' && same?.[1].name === 'mini (two.example:8005)', 'two with the same name are told apart by address', same?.map((r) => r.name))
  const blank = instanceRows([row({ id: 'a', label: '  ', host: 'one.example:8005' }), row({ id: 'b' })], clock)
  assert(blank?.find((r) => r.id === 'a')?.name === 'one.example:8005', 'no name: its address', blank)
  assert(ADD_PROMETHEUS === 'Add a Prometheus…', 'the footer row')
}

console.log('\n[smoke] === the switcher in the title bar ===')
{
  const one = [row({ id: 'home', active: true })]
  const two = [row({ id: 'home', active: true }), row({ id: 'office' })]
  assert(titleSwitches(one) && !titleSwitches([]), 'with one, the title bar opens the switcher too: "Add a Prometheus…" is there (with none, nothing)')
  assert(titleSwitches(two), 'with two or more, the name in the title bar opens the switcher')
  assert(switcherRows(one, clock)?.length === 1 && switcherRows(one, clock)?.[0].current === true, "the switcher with one: its row, marked, above Add (the sidebar's list stays hidden)", switcherRows(one, clock))
  assert(instanceRows(one, clock) === null, 'the sidebar list is still hidden with one')
  assert(switcherRows([], clock) === null && switcherRows(two, clock)?.length === 2, 'none: nothing; two: both')
  // Five items in the menu: rows 0..3 and "Add a Prometheus…" at 4.
  const k = (key: string, at: number): string => JSON.stringify(switcherKey(key, at, 5))
  assert(k('ArrowDown', 0) === '{"focus":1}' && k('ArrowDown', 4) === '{"focus":0}', 'ArrowDown moves to the next, and wraps', [k('ArrowDown', 0), k('ArrowDown', 4)])
  assert(k('ArrowUp', 1) === '{"focus":0}' && k('ArrowUp', 0) === '{"focus":4}', 'ArrowUp moves to the one before, and wraps', [k('ArrowUp', 1), k('ArrowUp', 0)])
  assert(k('ArrowDown', -1) === '{"focus":0}' && k('ArrowUp', -1) === '{"focus":4}', 'with nothing focused, down is the first and up the last')
  assert(k('Home', 3) === '{"focus":0}' && k('End', 1) === '{"focus":4}', 'Home and End')
  assert(k('Escape', 2) === '"close"' && k('Tab', 2) === '"close"', 'Escape closes it, and so does Tabbing out')
  assert(k('a', 2) === 'null' && k('Enter', 2) === 'null', 'other keys are the focused button\'s (Enter and Space press it)')
}

console.log('\n[smoke] === one line per Prometheus in the sidebar: the short detail and the full words ===')
{
  const rows = instanceRows(
    [
      row({ id: 'mbp', label: 'MacBook Pro', state: 'connected', ai: 'Z.ai (GLM) · glm-5.3', active: true }),
      row({ id: 'mini', label: 'mini', state: 'connected', ai: 'your own hardware · /home/someone/.prometheus/models/saluki/Underdog-Saluki-27B-1.0-IQ2-mix.gguf', proved: false }),
      row({ id: 'cloud', label: 'Cloud', state: 'connected', ai: 'Anthropic (Claude)' }),
      row({ id: 'quiet', label: 'Quiet', state: 'connected', ai: null }),
      row({ id: 'gone', label: 'Gone', state: 'unreachable', since: 42, ai: 'Z.ai (GLM) · glm-5.3' }),
      row({ id: 'odd', label: 'Odd', state: 'different' })
    ],
    clock
  )
  const by = (id: string) => rows?.find((r) => r.id === id)
  assert(by('mbp')?.detail === 'glm-5.3', 'connected: the model, as the daemon names it', by('mbp'))
  assert(by('mini')?.detail === 'Underdog-Saluki-27B-1.0-IQ2-mix', 'a model given as a file path: its file name, without the extension', by('mini'))
  assert(by('cloud')?.detail === 'Anthropic (Claude)' && by('quiet')?.detail === 'Connected', 'no model: the AI, or else the state', [by('cloud'), by('quiet')])
  assert(by('gone')?.detail === "Can't reach it since T42" && by('odd')?.detail === 'A different Prometheus answered', 'any other state: its words, never only a colour', [by('gone'), by('odd')])
  assert(by('mbp')?.full === 'Connected · Z.ai (GLM) · glm-5.3' && by('gone')?.full === "Can't reach it since T42 · Z.ai (GLM) · glm-5.3", 'the full words, for the tooltip', [by('mbp')?.full, by('gone')?.full])
  assert(by('mini')?.note === UNPROVED_NOTE, 'the note is still there, for the warning icon')
}

if (failures) {
  console.log(`\n[smoke] FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[smoke] ALL PASS')
