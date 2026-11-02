// The sidebar list of Prometheus (docs/MULTI-PROMETHEUS.md §5), decided without a window: hidden with one, each row's dot and
// words, which AI, the "can't prove who it is" note, and the name in the window title, the composer and the unreachable banner.
//
//   npm run build && npm run smoke:instance-rows
import { ADD_PROMETHEUS, UNPROVED_NOTE, activeName, composerPlaceholder, instanceRows, unreachableLine, windowTitle } from '@shared/instance-rows'
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

if (failures) {
  console.log(`\n[smoke] FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[smoke] ALL PASS')
