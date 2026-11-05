/**
 * "What it can touch" smoke (headless / ELECTRON_RUN_AS_NODE). Pins the logic of Integrations → Home
 * (docs/HA-UI-DATA-CONTRACT.md §3.2): the connection line, devices grouped by room with search and a
 * tier filter, what each row offers (Critical is read only, an unclassified device is shown Sensitive,
 * Sensitive can be relaxed to "Ask once"), the "Always allowed" list and its Revoke, and the words
 * each failure is shown in. Made-up home only (@shared/home-fixtures).
 *
 * The screen renders the daemon's words verbatim and decides nothing, except that an unknown tier is
 * Sensitive, and that Beacon never offers a control the contract does not give it.
 */
import {
  GRANTS_PATH,
  HOME_DEVICES_PATH,
  HOME_STATUS_PATH,
  askOnceBody,
  askOncePath,
  askOnceDialog,
  coerceDevices,
  coerceGrants,
  coerceStatus,
  deviceRowView,
  filterDevices,
  groupByRoom,
  grantRowView,
  revokeDialog,
  revokePath,
  statusLine,
  statusTone,
  unavailableLine
} from '@shared/home-devices'
import {
  DEVICES_LIST,
  GRANTS_LIST,
  MADE_UP_NAMES,
  STATUS_AUTH_FAILED,
  STATUS_CONNECTED,
  STATUS_UNREACHABLE
} from '@shared/home-fixtures'
import { readFileSync } from 'node:fs'

const MIN_CHECKS = 110

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

const list = coerceDevices(DEVICES_LIST)!
const byName = (n: string) => list.devices.find((d) => d.name === n)!

// ── 1. routes ────────────────────────────────────────────────────────────────
console.log('[smoke] === 1. routes ===')
assert(HOME_STATUS_PATH === '/api/home/status', 'status route')
assert(HOME_DEVICES_PATH === '/api/home/devices', 'devices route')
assert(GRANTS_PATH === '/api/approvals/grants', 'grants route is the existing one')
assert(askOncePath('dev-hall-light') === '/api/home/devices/dev-hall-light/ask-once', 'ask-once route')
assert(askOncePath('a/b c') === '/api/home/devices/a%2Fb%20c/ask-once', 'the device id is encoded into the path')
assert(JSON.stringify(askOnceBody(true)) === '{"enabled":true}' && JSON.stringify(askOnceBody(false)) === '{"enabled":false}', 'ask-once body')
assert(revokePath('grant-hall') === '/api/approvals/grants/grant-hall', 'revoke route is the existing one')
assert(revokePath('a/b') === '/api/approvals/grants/a%2Fb', 'the grant id is encoded into the path')

// ── 2. the connection line ───────────────────────────────────────────────────
console.log('[smoke] === 2. the connection line ===')
{
  const s = coerceStatus(STATUS_CONNECTED)!
  assert(s.state === 'connected' && s.deviceCount === 13 && s.openUrl === 'https://home.example.test', 'connected status maps')
  assert(statusLine(s) === 'Connected to Home Assistant · 13 devices', `the count is appended when connected (got "${statusLine(s)}")`)
  assert(statusTone(s) === 'ok', 'connected is ok')
  assert(statusLine({ ...s, deviceCount: 1 }) === 'Connected to Home Assistant · 1 device', 'one device is singular')
  assert(statusLine({ ...s, deviceCount: null }) === 'Connected to Home Assistant', 'no count, no count shown')
  const u = coerceStatus(STATUS_UNREACHABLE)!
  assert(statusLine(u) === 'Home Assistant did not answer (timed out after 8 seconds)', "a failure is the daemon's own words, verbatim")
  assert(statusTone(u) === 'error', 'unreachable is an error')
  const a = coerceStatus(STATUS_AUTH_FAILED)!
  assert(a.state === 'auth_failed' && /refused the saved access/.test(statusLine(a)) && a.openUrl === null, 'auth failure says so and has no link')
  assert(statusTone(coerceStatus({ state: 'degraded', detail: 'Slow' })!) === 'warn', 'degraded is a warning')
}
{
  const empty = (state: string) => statusLine(coerceStatus({ state })!)
  assert(empty('unreachable') === 'Home Assistant did not answer', 'no detail: a plain sentence by state (unreachable)')
  assert(empty('auth_failed') === 'Home Assistant refused the saved access', 'no detail: auth_failed')
  assert(empty('not_configured') === 'Home Assistant is not set up on this Prometheus yet', 'no detail: not_configured')
  assert(empty('degraded') === 'Home Assistant is answering with problems', 'no detail: degraded')
  assert(empty('connected') === 'Connected to Home Assistant', 'no detail: connected')
  assert(coerceStatus({ state: 'weird', detail: 'Odd' })?.state === 'unreachable', 'an unknown state is not shown as connected')
  assert(statusTone(coerceStatus({ state: 'weird' })!) === 'error', 'and reads as an error')
}
assert(coerceStatus(null) === undefined && coerceStatus('x') === undefined && coerceStatus([]) === undefined, 'junk status → undefined')
assert(coerceStatus({ state: 'connected', device_count: 'many' })?.deviceCount === null, 'a non-number count is unknown')
assert(coerceStatus({ state: 'connected', open_url: 'javascript:alert(1)' })?.openUrl === null, 'a non-web link is dropped')
assert(coerceStatus({ state: 'connected', open_url: 'file:///etc/passwd' })?.openUrl === null, 'a file link is dropped')

// ── 3. when the screen cannot load ───────────────────────────────────────────
console.log('[smoke] === 3. failure words ===')
{
  const nf = unavailableLine(new Error('Error invoking remote method \'daemon:get\': Error: HTTP 404: GET /api/home/status — {}'))
  assert(nf.kind === 'unsupported' && nf.text === 'This Prometheus has no Home Assistant support.', '404: no Home support')
  const fb = unavailableLine(new Error('HTTP 403: GET /api/home/status — {"error":"operator_only"}'))
  assert(fb.kind === 'forbidden' && fb.text === 'Only an owner device can see this.', '403: owner only')
  const au = unavailableLine(new Error('HTTP 401: GET /api/home/status'))
  assert(au.kind === 'error' && /did not accept/.test(au.text), '401 says the key was refused')
  const other = unavailableLine(new Error('fetch failed'))
  assert(other.kind === 'error' && other.text.startsWith("Couldn't read Home: fetch failed"), 'anything else is said, not hidden')
  assert(unavailableLine('x'.repeat(500)).text.length < 200, 'a long error is cut')
  assert(unavailableLine(undefined).text.length > 10, 'even nothing at all gets a sentence')
}

// ── 4. devices ───────────────────────────────────────────────────────────────
console.log('[smoke] === 4. coerceDevices ===')
assert(list.devices.length === 13, 'every device maps')
assert(list.updatedAt === 1_790_000_000, 'updated_at → updatedAt')
{
  const h = byName('Hall light')
  assert(h.id === 'dev-hall-light' && h.room === 'Hall' && h.kind === 'Light' && h.state === 'on' && h.tier === 'ordinary', 'a device maps')
  assert(h.openUrl === 'https://home.example.test/device/dev-hall-light', 'open_url → openUrl')
  assert(byName('Spare switch').state === null && byName('Spare switch').room === null && byName('Spare switch').openUrl === null, 'missing state, room and link are null')
  assert(byName('Movie scene').relaxed === true && byName('Evening scene').relaxed === false, 'relaxed carried')
  assert(byName('Spare switch').unclassified === true && byName('Hall light').unclassified === false, 'unclassified from tier_source')
}
assert(coerceDevices(null) === undefined && coerceDevices('x') === undefined && coerceDevices({}) === undefined, 'junk → undefined')
assert(coerceDevices({ devices: [] })?.devices.length === 0, 'an empty list is an empty list, not an error')
{
  const d = coerceDevices({ devices: [{ id: 'a', name: 'Hall light', tier: 'banana' }, { id: 'b' }, { name: 'x' }, 7, { id: 'c', name: 'Study lamp' }] })!
  assert(d.devices.length === 2, 'devices without an id or a name are dropped')
  assert(d.devices[0].tier === 'sensitive' && d.devices[0].unclassified === true, 'an unknown tier is Sensitive, and says it is unclassified')
  assert(d.devices[1].tier === 'sensitive' && d.devices[1].unclassified === true, 'a missing tier is Sensitive and unclassified')
}
assert(coerceDevices({ devices: [{ id: 'a', name: 'Hall light', tier: 'ordinary', tier_source: 'unclassified' }] })!.devices[0].tier === 'sensitive', 'unclassified is Sensitive whatever tier was sent with it')
assert(coerceDevices({ devices: [{ id: 'a', name: 'Hall light', tier: 'ordinary', open_url: 'javascript:1' }] })!.devices[0].openUrl === null, 'a bad device link is dropped')

// ── 5. search, filter, group ─────────────────────────────────────────────────
console.log('[smoke] === 5. search, tier filter, rooms ===')
{
  const all = filterDevices(list.devices, { query: '', tier: 'all' })
  assert(all.length === 13, 'no filter: everything')
  assert(filterDevices(list.devices, { query: 'garage', tier: 'all' }).map((d) => d.name).sort().join() === 'Garage door,Garage light', 'search matches the name, and the room')
  assert(filterDevices(list.devices, { query: '  LIVING ', tier: 'all' }).length === 4, 'search is case-insensitive and trimmed (room match)')
  assert(filterDevices(list.devices, { query: 'zzz', tier: 'all' }).length === 0, 'no match')
  assert(filterDevices(list.devices, { query: '', tier: 'critical' }).map((d) => d.name).sort().join() === 'Front door lock,Garage door,Kitchen blind', 'Critical filter')
  assert(filterDevices(list.devices, { query: '', tier: 'ordinary' }).length === 8, 'Ordinary filter')
  const sens = filterDevices(list.devices, { query: '', tier: 'sensitive' }).map((d) => d.name).sort().join()
  assert(sens === 'Evening scene,Movie scene,Spare switch', `Sensitive filter includes the unclassified device (got ${sens})`)
  assert(filterDevices(list.devices, { query: 'scene', tier: 'sensitive' }).length === 2, 'search and tier combine')
  assert(filterDevices(list.devices, { query: 'scene', tier: 'critical' }).length === 0, 'AND, not OR')
}
{
  const groups = groupByRoom(list.devices)
  assert(groups.map((g) => g.label).join() === 'Bedroom,Garage,Hall,Kitchen,Living room,No room', `rooms alphabetical, "No room" last (got ${groups.map((g) => g.label).join()})`)
  assert(groups[2].devices.map((d) => d.name).join() === 'Front door lock,Hall light,Landing light', 'devices in a room are alphabetical')
  assert(groups.reduce((n, g) => n + g.devices.length, 0) === 13, 'nothing is lost in grouping')
  assert(groupByRoom([]).length === 0, 'no devices, no groups')
}

// ── 6. what each row offers ──────────────────────────────────────────────────
console.log('[smoke] === 6. rows ===')
{
  const hall = deviceRowView(byName('Hall light'))
  assert(hall.tier === 'ordinary' && hall.tierWord === 'Ordinary' && hall.stateText === 'on', 'ordinary row')
  assert(hall.readOnly === false && hall.askOnce === null && hall.note === null, 'an Ordinary row offers nothing to change')
  const lock = deviceRowView(byName('Front door lock'))
  assert(lock.tier === 'critical' && lock.tierWord === 'Critical' && lock.readOnly === true, 'Critical row is read only')
  assert(lock.askOnce === null, 'and offers no Ask once')
  const evening = deviceRowView(byName('Evening scene'))
  assert(evening.tier === 'sensitive' && evening.askOnce === 'offer' && evening.readOnly === false, 'a Sensitive row can be relaxed')
  const movie = deviceRowView(byName('Movie scene'))
  assert(movie.askOnce === 'on', 'a relaxed Sensitive row says Ask once is on, and offers to undo it')
  const spare = deviceRowView(byName('Spare switch'))
  assert(spare.tier === 'sensitive' && spare.tierWord === 'Sensitive', 'unclassified is shown Sensitive')
  assert(spare.note === 'Not classified yet, so treated as Sensitive.', 'with a note saying so')
  assert(spare.stateText === 'state unknown', 'an unreadable state says so')
  assert(spare.openUrl === null, 'no link when the daemon sent none')
  assert(evening.note === null, 'a classified device has no note')
  const r = deviceRowView({ ...byName('Hall light'), relaxed: true })
  assert(r.askOnce === null, 'Ask once means nothing on an Ordinary device, so none is offered')
  const cr = deviceRowView({ ...byName('Front door lock'), relaxed: true })
  assert(cr.askOnce === null && cr.readOnly === true, 'a Critical device is never relaxable, even if the daemon says relaxed')
  assert(hall.openUrl === 'https://home.example.test/device/dev-hall-light', 'every row with a link carries it')
}
{
  const on = askOnceDialog(byName('Evening scene'), true)
  assert(on.title.includes('Evening scene'), 'the confirmation names the device')
  assert(on.body.includes('Evening scene') && /Always allow/.test(on.body), 'and says what changes: Always allow is offered')
  assert(/nothing is allowed until you choose/i.test(on.body), 'and that it grants nothing by itself')
  assert(on.confirmLabel === 'Turn on Ask once', 'confirm button says what it does')
  const off = askOnceDialog(byName('Movie scene'), false)
  assert(off.title.includes('Movie scene') && /Ask every time/.test(off.title), 'undoing it names the device too')
  assert(/stays until you revoke/i.test(off.body), 'and says an existing grant is not removed by it')
  assert(off.confirmLabel === 'Ask every time', 'its confirm button')
}

// ── 7. the "Always allowed" list ─────────────────────────────────────────────
console.log('[smoke] === 7. Always allowed ===')
{
  const rows = coerceGrants(GRANTS_LIST)
  assert(rows.length === 4, `only Home grants are listed (got ${rows.length}); the file grant is not`)
  assert(!rows.some((r) => r.id === 'grant-file'), 'a non-Home grant never appears here')
  const hall = grantRowView(rows.find((r) => r.id === 'grant-hall')!)
  assert(hall.describes === 'ha_control_ordinary on exactly Hall light — permanently, until revoked', "the daemon's own description, verbatim")
  assert(hall.devicesLabel === 'Hall light · Hall' && hall.tierWord === 'Ordinary', 'it names the device and room, and the tier')
  assert(hall.canRevoke === true, 'Revoke is offered')
  const all = grantRowView(rows.find((r) => r.id === 'grant-ordinary-all')!)
  assert(all.devicesLabel === 'Every Ordinary device', 'a tier-wide grant says so in words')
  const movie = grantRowView(rows.find((r) => r.id === 'grant-movie')!)
  assert(movie.tierWord === 'Sensitive' && movie.devicesLabel === 'Movie scene · Living room', 'a Sensitive grant')
  const old = grantRowView(rows.find((r) => r.id === 'grant-old')!)
  assert(old.devicesLabel === null && old.describes.includes('Garage light'), 'an older daemon with no home details: the description alone')
  assert(rows.every((r) => grantRowView(r).describes.length > 0), 'no row is ever blank')
  const d = revokeDialog(rows.find((r) => r.id === 'grant-hall')!)
  assert(d.title.includes('Hall light'), 'the revoke confirmation names the device')
  assert(d.body.includes('permanently, until revoked') && /ask you again/i.test(d.body), "and the daemon's description, and what happens next")
  assert(d.confirmLabel === 'Revoke', 'confirm button')
  const t = revokeDialog(rows.find((r) => r.id === 'grant-ordinary-all')!)
  assert(/Every Ordinary device/.test(t.title), 'a tier-wide revoke names the tier, not one device')
  const o = revokeDialog(rows.find((r) => r.id === 'grant-old')!)
  assert(o.title.length > 8 && o.body.includes('Garage light'), 'an older row still gets a confirmation that says what it is')
}
assert(coerceGrants(null).length === 0 && coerceGrants('x').length === 0 && coerceGrants({}).length === 0, 'junk grants → none')
assert(coerceGrants([{ tool: 'mcp__home__ha_control_ordinary', describes: 'x' }]).length === 1, 'a grant without an id is still shown')
assert(grantRowView(coerceGrants([{ tool: 'mcp__home__ha_control_ordinary', describes: 'x' }])[0]).canRevoke === false, 'but cannot be revoked from here')
assert(coerceGrants([{ id: 'g', tool: 'mcp__home__ha_control_ordinary' }])[0].describes === 'mcp__home__ha_control_ordinary', 'no description: the tool name, never blank')
assert(coerceGrants([{ id: 'g', tool: 'mcp__home__ha_list' }]).length === 0, 'a read tool is not a Home control grant')
assert(coerceGrants([{ id: 'g', tool: 'mcp__home__ha_control_ordinary', home: { tier: 'banana', devices: 'x' } }])[0].devices === null, 'a bad home object on a grant is ignored')

// ── 8. the fixtures are made up ──────────────────────────────────────────────
console.log('[smoke] === 8. fixtures ===')
{
  assert(list.devices.every((d) => MADE_UP_NAMES.includes(d.name)), 'every device name is on the made-up list')
  const rooms = new Set(list.devices.map((d) => d.room))
  assert([...rooms].every((r) => r === null || ['Hall', 'Living room', 'Kitchen', 'Garage', 'Bedroom'].includes(r)), 'every room is a made-up one')
  const all = JSON.stringify([DEVICES_LIST, GRANTS_LIST, STATUS_CONNECTED, STATUS_UNREACHABLE, STATUS_AUTH_FAILED])
  assert(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(all), 'no IP address')
  assert(!/https?:\/\/(?![\w.-]*\.example\.test)|\.ts\.net|\.local\b|@/.test(all), 'no host but example.test, and no email')
  assert(new Set(list.devices.map((d) => d.tier)).size === 3, 'the fixtures cover all three tiers')
}

// ── 9. wiring: source checks (a smoke cannot paint; home-touch-probe does) ───
console.log('[smoke] === 9. wiring ===')
const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const panel = read('../../src/renderer/src/components/HomePanel.tsx')
const integ = read('../../src/renderer/src/components/IntegrationsPanel.tsx')
assert(!/\bfetch\(|XMLHttpRequest|WebSocket/.test(panel), 'the screen never calls anything itself')
assert(!/homeassistant|home-assistant/i.test(panel.replace(/Home Assistant/g, '')), 'no Home Assistant address or client in the screen')
{
  const writes = panel.match(/daemon\.write\([^)]*\)/g) ?? []
  assert(writes.length === 2, `exactly two writes (ask-once, revoke); found ${writes.length}`)
  assert(writes.every((w) => /askOncePath\(|revokePath\(/.test(w)), 'and each goes through the route builders')
}
assert(!/method[^\n]*(POST)/.test(panel), 'nothing is posted from the screen')
assert(/daemon\.get\(/.test(panel), 'reads go through the daemon bridge')
assert(/useDialogFocus/.test(panel), 'its dialogs keep focus (p4.2)')
assert(/role="dialog"/.test(panel) && /aria-modal/.test(panel), 'its dialogs are dialogs')
assert(/Read only/.test(panel), 'Critical rows say Read only')
assert(/Revoke/.test(panel) && /Always allowed/.test(panel), 'the Always allowed list and Revoke are on the screen')
assert(/target="_blank"/.test(panel) && /Open in Home Assistant/.test(panel), 'Open in Home Assistant is a link that opens outside Beacon')
assert(/rel="noopener noreferrer"/.test(panel), 'and cannot reach back into the window that opened it')
assert(/HomeTierBadge/.test(panel), 'tiers are the shared chip: a word and a glyph')
assert(/<input[^>]*type="search"|aria-label="Search devices"/.test(panel), 'the search box is labelled')
assert(/aria-pressed|role="radio"|role="tab"/.test(panel), 'the tier filter says which one is on')
assert(!/<input[^>]*type="checkbox"|role="switch"/.test(panel), 'no on/off switch for a device anywhere')
assert(/HomePanel/.test(integ) && /useDeviceRole/.test(integ), 'Integrations mounts Home, and asks the role')
assert(/'limited'|"limited"/.test(integ), 'and does not show it to a limited device')

console.log(`[smoke] ${checks} checks, ${failures} failures`)
if (checks < MIN_CHECKS) {
  console.log(`[smoke] FAIL  only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
  failures++
}
process.exit(failures === 0 ? 0 : 1)
