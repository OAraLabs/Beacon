/**
 * Home activity timeline smoke (headless / ELECTRON_RUN_AS_NODE). Pins the logic of Integrations → Home →
 * Activity (docs/HA-UI-DATA-CONTRACT.md §3.3): every Home action newest first with who asked, what was asked for,
 * what really resulted and how it was approved; refused calls shown as refused, with the server's reason; filters
 * by device, room and tier; a bulk call collapsed past 5; and a screen that cannot change anything.
 * Made-up home only (src/shared/home-fixtures.json).
 */
import { readFileSync } from 'node:fs'
import {
  ACTIVITY_PAGE_SIZE,
  HOME_ACTIVITY_PATH,
  activityPath,
  approvalWords,
  coerceActivity,
  dayLabel,
  deviceOptions,
  entryView,
  initiatorWords,
  resultView,
  roomOptions,
  timelineRows
} from '@shared/home-activity'
import { coerceDevices } from '@shared/home-devices'

// Fixtures are DATA read from disk, never imported (see home-approval-smoke): a shared module becomes a shipped chunk.
const FIXTURES = JSON.parse(readFileSync(new URL('../../src/shared/home-fixtures.json', import.meta.url), 'utf8'))
const { ACTIVITY_PAGE_1, ACTIVITY_PAGE_2, DEVICES_LIST, MADE_UP_NAMES } = FIXTURES as Record<string, any>

const MIN_CHECKS = 107

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

const page1 = coerceActivity(ACTIVITY_PAGE_1)!
const page2 = coerceActivity(ACTIVITY_PAGE_2)!
const byId = (id: string) => [...page1.entries, ...page2.entries].find((e) => e.id === id)!

// ── 1. the route ─────────────────────────────────────────────────────────────
console.log('[smoke] === 1. the route ===')
assert(HOME_ACTIVITY_PATH === '/api/home/activity', 'activity route')
assert(ACTIVITY_PAGE_SIZE === 50, 'a page is 50')
assert(activityPath({ device: '', room: '', tier: 'all' }) === '/api/home/activity?limit=50', 'no filter: just the limit')
assert(activityPath({ device: 'dev-hall-light', room: '', tier: 'all' }) === '/api/home/activity?limit=50&device=dev-hall-light', 'device filter')
assert(activityPath({ device: '', room: 'Living room', tier: 'all' }) === '/api/home/activity?limit=50&room=Living%20room', 'room filter is encoded')
assert(activityPath({ device: '', room: '', tier: 'critical' }) === '/api/home/activity?limit=50&tier=critical', 'tier filter')
assert(activityPath({ device: 'a', room: 'b', tier: 'sensitive' }, { before: 'cursor-2' }) === '/api/home/activity?limit=50&before=cursor-2&device=a&room=b&tier=sensitive', 'all together, with a page cursor')
assert(activityPath({ device: 'a/b', room: '', tier: 'all' }).endsWith('device=a%2Fb'), 'a device id is encoded')
assert(activityPath({ device: '', room: '', tier: 'all' }, { before: 'x y' }).includes('before=x%20y'), 'a cursor is encoded')
assert(!/\b(POST|PUT|DELETE)\b/.test(activityPath({ device: '', room: '', tier: 'all' })), 'a route, not a verb')

// ── 2. the wire → entries ────────────────────────────────────────────────────
console.log('[smoke] === 2. coerceActivity ===')
assert(page1.entries.length === 15 && page2.entries.length === 3, 'every entry maps')
assert(page1.nextBefore === 'cursor-2' && page2.nextBefore === null, 'next_before → nextBefore, null when there is no more')
{
  const e = byId('a-01')
  assert(e.at === 1_790_000_000 && e.device.name === 'Hall light' && e.device.room === 'Hall' && e.device.id === 'dev-hall-light', 'an entry maps')
  assert(e.tier === 'ordinary' && e.tool === 'ha_control_ordinary' && e.action === 'turn_on', 'tier, tool, action')
  assert(e.initiator.kind === 'chat' && e.initiator.label === null, 'initiator')
  assert(e.requested === 'on, 60%' && e.resulting === 'off' && e.result === 'unconfirmed' && e.approval === 'approved_once', 'requested, resulting, result, approval')
  assert(e.refusalReason === null && e.batchId === null, 'no reason, no batch')
  assert(byId('a-02').refusalReason === 'Front door lock is a Critical device, and Critical devices cannot be controlled from Prometheus.', "the server's reason, verbatim")
  assert(byId('a-05').batchId === 'b-01', 'batch_id → batchId')
  assert(byId('a-03').initiator.label === 'Evening routine', 'a schedule keeps its label')
}
assert(page1.entries.every((e, i, a) => i === 0 || a[i - 1].at >= e.at), 'newest first')
{
  const shuffled = coerceActivity({ entries: [{ ...ACTIVITY_PAGE_1.entries[3] }, { ...ACTIVITY_PAGE_1.entries[0] }, { ...ACTIVITY_PAGE_1.entries[2] }] })!
  assert(shuffled.entries.map((e) => e.id).join() === 'a-01,a-03,a-04', 'an out-of-order page is put newest first')
}
assert(coerceActivity(null) === undefined && coerceActivity('x') === undefined && coerceActivity([]) === undefined && coerceActivity({}) === undefined, 'junk → undefined')
assert(coerceActivity({ entries: [] })!.entries.length === 0, 'an empty list is an empty list')
{
  const bad = coerceActivity({
    entries: [
      { id: 'x', at: 1, device: { name: 'Hall light' }, tier: 'banana', result: 'great', approval: 'maybe', initiator: { kind: 'robot' } },
      { at: 1, device: { name: 'Hall light' } },
      { id: 'y', device: { name: 'Hall light' } },
      { id: 'z', at: 1, device: {} },
      { id: 'w', at: 1 },
      7
    ]
  })!
  assert(bad.entries.length === 1, 'entries without an id, a time or a device name are dropped')
  const x = bad.entries[0]
  assert(x.tier === 'sensitive', 'an unknown tier is Sensitive')
  assert(x.result === 'unconfirmed', 'an unknown result is never shown as success')
  assert(x.approval === 'unknown', 'an unknown approval is unknown, not invented')
  assert(x.initiator.kind === 'unknown', 'an unknown asker is unknown')
  assert(x.device.id === '' && x.device.room === null, 'a device with no id or room maps')
  assert(x.requested === null && x.resulting === null && x.refusalReason === null && x.batchId === null, 'absent fields are null')
}
assert(coerceActivity({ entries: [], next_before: 7 })!.nextBefore === '7', 'a numeric cursor is carried as text')
assert(coerceActivity({ entries: [], next_before: '' })!.nextBefore === null, 'an empty cursor means no more')

// ── 3. the words ─────────────────────────────────────────────────────────────
console.log('[smoke] === 3. words ===')
assert(initiatorWords({ kind: 'chat', label: null }) === 'Your chat', 'chat')
assert(initiatorWords({ kind: 'schedule', label: null }) === 'A schedule', 'a schedule')
assert(initiatorWords({ kind: 'schedule', label: 'Evening routine' }) === 'A schedule · Evening routine', 'a schedule, named')
assert(initiatorWords({ kind: 'background_task', label: null }) === 'A background task', 'a background task')
assert(initiatorWords({ kind: 'unknown', label: null }) === 'Unknown', 'unknown')
{
  const all = (['confirmed', 'unconfirmed', 'failed', 'refused'] as const).map((r) => resultView({ ...byId('a-01'), result: r }))
  assert(new Set(all.map((v) => v.word)).size === 4, 'each result has its own word')
  assert(new Set(all.map((v) => v.glyph)).size === 4, 'and its own glyph')
  assert(all.map((v) => v.word).join() === 'Confirmed,Not confirmed,Failed,Refused', 'Confirmed / Not confirmed / Failed / Refused')
  assert(all[3].glyph === 'refused' && all[0].glyph === 'check' && all[1].glyph === 'warn' && all[2].glyph === 'cross', 'check, warning, cross, refused')
}
{
  const words = (['approved_once', 'approved_always', 'auto_allowed', 'denied', 'expired', 'not_asked', 'unknown'] as const).map(approvalWords)
  assert(new Set(words).size === 7, 'each approval outcome has its own words')
  assert(approvalWords('approved_once') === 'You approved it once', 'approved once')
  assert(approvalWords('approved_always') === 'You chose Always allow', 'approved always')
  assert(approvalWords('auto_allowed') === 'Allowed by a saved permission', 'ran under a saved permission')
  assert(approvalWords('denied') === 'You denied it', 'denied')
  assert(approvalWords('expired') === 'Approval expired', 'expired')
  assert(approvalWords('not_asked') === 'No approval was asked for', 'not asked')
  assert(approvalWords('unknown') === 'Approval not reported', 'unknown')
}

// ── 4. one entry as the timeline shows it ────────────────────────────────────
console.log('[smoke] === 4. entryView ===')
const NOW = new Date(2026, 8, 21, 15, 30).getTime() // a made-up "now", local time
{
  const v = entryView(byId('a-01'), NOW)
  assert(v.deviceName === 'Hall light' && v.room === 'Hall' && v.tierWord === 'Ordinary' && v.tier === 'ordinary', 'device, room, tier')
  assert(v.askedBy === 'Your chat' && v.approval === 'You approved it once', 'asked by, approval')
  assert(v.requested === 'on, 60%' && v.resulting === 'off', 'requested and the real resulting state')
  assert(v.resultWord === 'Not confirmed' && v.resultGlyph === 'warn', 'the warning is shown as the warning')
  assert(v.reason === null && v.when.length > 0 && typeof v.day === 'string', 'a time and a day')
  const r = entryView(byId('a-02'), NOW)
  assert(r.resultWord === 'Refused' && r.resultGlyph === 'refused' && r.tierWord === 'Critical', 'a refused call is marked refused')
  assert(r.reason === 'Front door lock is a Critical device, and Critical devices cannot be controlled from Prometheus.', "with the server's reason, verbatim")
  assert(r.resulting === null, 'nothing resulted from a refused call, so no resulting state is claimed')
  assert(r.requested === 'unlocked', 'but what was asked for is shown')
  const bg = entryView(byId('a-04'), NOW)
  assert(bg.askedBy === 'A background task' && bg.reason === 'Scheduled and background runs never use the sensitive tool.', 'a background refusal says who and why')
  const sch = entryView(byId('a-03'), NOW)
  assert(sch.askedBy === 'A schedule · Evening routine' && sch.approval === 'Allowed by a saved permission', 'a schedule that ran under a saved permission')
  const den = entryView(byId('a-14'), NOW)
  assert(den.approval === 'You denied it' && den.resultWord === 'Refused' && den.reason === 'You denied this request.', 'a denied approval is on the timeline too')
  const un = entryView({ ...byId('a-01'), resulting: null }, NOW)
  assert(un.resulting === 'could not be read', 'an unreadable result says so, never blank')
  const nr = entryView({ ...byId('a-02'), refusalReason: null }, NOW)
  assert(nr.reason === 'No reason was given.', 'a refused call with no reason says so')
  const nreq = entryView({ ...byId('a-01'), requested: null }, NOW)
  assert(nreq.requested === 'not stated', 'a missing request says so')
  const ok = entryView(byId('a-03'), NOW)
  assert(ok.reason === null && ok.resultWord === 'Confirmed' && ok.resultGlyph === 'check', 'a confirmed action has no reason line')
  const f = entryView(byId('a-11'), NOW)
  assert(f.resultWord === 'Failed' && f.reason === 'Home Assistant did not answer for this one', 'a failed action keeps the server reason')
}

// ── 5. days ──────────────────────────────────────────────────────────────────
console.log('[smoke] === 5. days ===')
{
  const at = (d: Date) => d.getTime() / 1000
  assert(dayLabel(at(new Date(2026, 8, 21, 9, 5)), NOW) === 'Today', 'earlier today')
  assert(dayLabel(at(new Date(2026, 8, 20, 23, 59)), NOW) === 'Yesterday', 'late yesterday')
  assert(dayLabel(at(new Date(2026, 8, 20, 0, 1)), NOW) === 'Yesterday', 'just after midnight yesterday')
  const old = dayLabel(at(new Date(2026, 8, 18, 12, 0)), NOW)
  assert(old !== 'Today' && old !== 'Yesterday' && old.length > 2, `an older day is a date (got ${old})`)
  assert(dayLabel(at(new Date(2026, 8, 21, 23, 59)), NOW) === 'Today', 'later today is today')
}

// ── 6. rows: bulk calls collapse past 5 ──────────────────────────────────────
console.log('[smoke] === 6. timelineRows ===')
{
  const rows = timelineRows(page1.entries, new Set(), NOW)
  assert(rows.length === 8, `15 entries are 7 singles and 1 batch (got ${rows.length} rows)`)
  const batch = rows.find((r) => r.kind === 'batch')!
  assert(batch.kind === 'batch' && batch.batchId === 'b-01' && batch.entries.length === 8, 'the eight lights are one batch')
  assert(batch.kind === 'batch' && batch.shown.length === 5, 'collapsed to 5')
  assert(batch.kind === 'batch' && batch.hiddenCount === 3 && batch.moreLabel === 'and 3 more', '"and 3 more"')
  assert(batch.kind === 'batch' && batch.summary === '8 devices · turn_off', `a summary line (got ${batch.kind === 'batch' ? batch.summary : ''})`)
  assert(batch.kind === 'batch' && batch.tone === 'failed', 'one failure makes the batch read as failed')
  const open = timelineRows(page1.entries, new Set(['b-01']), NOW).find((r) => r.kind === 'batch')!
  assert(open.kind === 'batch' && open.shown.length === 8 && open.hiddenCount === 0 && open.moreLabel === null, 'expanded: all 8, nothing hidden')
  assert(rows[0].kind === 'entry' && rows[0].view.deviceName === 'Hall light', 'the newest is first')
  assert(rows.filter((r) => r.kind === 'entry').length === 7, 'the singles stay singles')
  const days = rows.map((r) => r.day)
  assert(days[0] === 'Today' || days[0].length > 0, 'every row knows its day')
  assert(rows.every((r) => typeof r.day === 'string' && r.day.length > 0), 'every row has a day label')
}
{
  const mk = (n: number) => page1.entries.filter((e) => e.batchId === 'b-01').slice(0, n)
  const five = timelineRows(mk(5), new Set(), NOW)[0]
  assert(five.kind === 'batch' && five.shown.length === 5 && five.moreLabel === null, 'exactly 5: not collapsed')
  const six = timelineRows(mk(6), new Set(), NOW)[0]
  assert(six.kind === 'batch' && six.shown.length === 5 && six.moreLabel === 'and 1 more', 'six: "and 1 more"')
  const one = timelineRows(mk(1), new Set(), NOW)[0]
  assert(one.kind === 'entry', 'a lone member of a batch (the others filtered away) is a plain entry')
  const sep = timelineRows([...mk(2), page1.entries[0], ...mk(2).map((e) => ({ ...e, id: e.id + 'x' }))], new Set(), NOW)
  assert(sep.filter((r) => r.kind === 'batch').length === 2, 'the same batch id split by another entry is two groups, in time order')
  assert(timelineRows([], new Set(), NOW).length === 0, 'no entries, no rows')
}

// ── 7. filter options ────────────────────────────────────────────────────────
console.log('[smoke] === 7. filter options ===')
{
  const devs = coerceDevices(DEVICES_LIST)!.devices
  const dev = deviceOptions(devs)
  assert(dev.length === 13, 'every device is an option')
  assert(dev[0].label === 'Bedroom lamp · Bedroom', `labelled with its room, alphabetical (got ${dev[0].label})`)
  assert(dev.find((o) => o.id === 'dev-spare-switch')?.label === 'Spare switch', 'a device with no room is just its name')
  assert(roomOptions(devs).join() === 'Bedroom,Garage,Hall,Kitchen,Living room', 'rooms, alphabetical, no "No room"')
  assert(deviceOptions([]).length === 0 && roomOptions([]).length === 0, 'no devices, no options')
}

// ── 8. fixtures are made up ──────────────────────────────────────────────────
console.log('[smoke] === 8. fixtures ===')
{
  const all = [...page1.entries, ...page2.entries]
  assert(all.every((e) => MADE_UP_NAMES.includes(e.device.name)), 'every device name is on the made-up list')
  assert(new Set(all.map((e) => e.result)).size === 4, 'the fixtures cover every result')
  assert(new Set(all.map((e) => e.approval)).size === 6, 'and every approval outcome')
  assert(new Set(all.map((e) => e.initiator.kind)).size === 4, 'and every asker')
  assert(new Set(all.map((e) => e.tier)).size === 3, 'and every tier')
  const text = JSON.stringify([ACTIVITY_PAGE_1, ACTIVITY_PAGE_2])
  assert(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(text) && !/https?:\/\/|@|\.ts\.net|\.local\b/.test(text), 'no address, host or email')
}

// ── 9. wiring: source checks (a smoke cannot paint; home-activity-probe does) ─
console.log('[smoke] === 9. wiring ===')
const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const view = read('../../src/renderer/src/components/HomeActivity.tsx')
const panel = read('../../src/renderer/src/components/HomePanel.tsx')
assert(!/daemon\.write|\bfetch\(|XMLHttpRequest|WebSocket/.test(view), 'the timeline never writes and never calls anything itself')
assert(/daemon\.get\(/.test(view) && /activityPath\(/.test(view), 'it reads through the daemon bridge, by the route builder')
assert(!/Delete|Clear|Remove|Export|Revoke/.test(view), 'nothing on it can delete, clear, remove or export')
assert(!/method=|<form|type="checkbox"|role="switch"/.test(view), 'no form, no switch')
assert(/aria-label="Device"/.test(view) && /aria-label="Room"/.test(view) && /aria-label="Tier"/.test(view), 'the three filters are labelled')
assert(/HomeTierBadge/.test(view), 'tiers are the shared chip: a word and a glyph')
assert(/aria-expanded/.test(view), 'and "and N more" says whether it is open')
assert(/HomeActivity/.test(panel) && /role="tablist"/.test(panel) && /role="tab"/.test(panel) && /aria-selected/.test(panel), 'Home has Devices and Activity tabs, and says which is open')

console.log(`[smoke] ${checks} checks, ${failures} failures`)
if (checks < MIN_CHECKS) {
  console.log(`[smoke] FAIL  only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
  failures++
}
process.exit(failures === 0 ? 0 : 1)
