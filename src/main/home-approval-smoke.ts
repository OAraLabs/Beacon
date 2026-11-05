/**
 * Home approval card smoke (headless / ELECTRON_RUN_AS_NODE). Pins the logic of the Home Assistant
 * approval card (docs/HA-UI-DATA-CONTRACT.md §3.1): what the wire's `home` object becomes, which
 * buttons are on offer, how a bulk call collapses, and how the server's re-read is worded.
 *
 * Everything here is a made-up home (@shared/home-fixtures). The card renders the daemon's words
 * verbatim and decides nothing itself, with one exception that is a safety floor: an unknown tier is
 * Sensitive, and a call is as strict as its strictest device.
 */
import { rawToApproval, type RawApprovalPush } from '@shared/approval-push'
import {
  COLLAPSE_AFTER,
  RESULT_POLL_MS,
  RESULT_POLL_TRIES,
  coerceActionResult,
  coerceHome,
  coerceTier,
  homeActionPath,
  homeCardView,
  isHomeToolName,
  resultLineView,
  resultTone,
  tierPresentation
} from '@shared/home-approval'
import {
  BULK_EIGHT,
  CRITICAL_LOCK,
  HOME_APPROVAL_WIRE,
  MADE_UP_NAMES,
  ORDINARY_LIGHT,
  RESULT_CONFIRMED,
  RESULT_FAILED,
  RESULT_PENDING,
  RESULT_UNCONFIRMED,
  SENSITIVE_RELAXED,
  SENSITIVE_SCENE,
  UNKNOWN_CURRENT
} from '@shared/home-fixtures'
import { readFileSync } from 'node:fs'

/** The count guard (see approval-smoke): a section that stops running must not read as a pass. */
const MIN_CHECKS = 95

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

const approval = (wire: Record<string, unknown>) => {
  const a = rawToApproval(wire as RawApprovalPush)
  if (!a) throw new Error('fixture did not map')
  return a
}

// ── 1. the tool name ─────────────────────────────────────────────────────────
console.log('[smoke] === 1. which tools are Home control tools ===')
assert(isHomeToolName('mcp__home__ha_control_ordinary'), 'ordinary control tool, any server name')
assert(isHomeToolName('mcp__x__ha_control_sensitive'), 'sensitive control tool')
assert(isHomeToolName('ha_control_ordinary'), 'a bare tool name')
assert(!isHomeToolName('mcp__home__ha_list'), 'ha_list is a read, not a control')
assert(!isHomeToolName('mcp__home__ha_state'), 'ha_state is a read')
assert(!isHomeToolName('mcp__home__ha_control_ordinary_extra'), 'a longer name is not the tool')
assert(!isHomeToolName('bash') && !isHomeToolName(''), 'bash and empty are not Home tools')

// ── 2. tiers ─────────────────────────────────────────────────────────────────
console.log('[smoke] === 2. tiers: unknown is Sensitive, and never colour alone ===')
assert(coerceTier('ordinary') === 'ordinary', 'ordinary')
assert(coerceTier('sensitive') === 'sensitive', 'sensitive')
assert(coerceTier('critical') === 'critical', 'critical')
assert(coerceTier('banana') === 'sensitive', 'an unrecognised tier is Sensitive')
assert(coerceTier(undefined) === 'sensitive' && coerceTier(null) === 'sensitive' && coerceTier(3) === 'sensitive', 'a missing tier is Sensitive')
assert(coerceTier('ORDINARY') === 'sensitive', 'a differently-cased tier is not trusted as Ordinary')
{
  const p = (['ordinary', 'sensitive', 'critical'] as const).map(tierPresentation)
  assert(new Set(p.map((x) => x.word)).size === 3, 'each tier has its own word')
  assert(new Set(p.map((x) => x.glyph)).size === 3, 'each tier has its own glyph')
  assert(p.every((x) => x.word.length > 0 && x.glyph.length > 0), 'every tier has a word and a glyph')
  assert(p[0].word === 'Ordinary' && p[1].word === 'Sensitive' && p[2].word === 'Critical', 'the words are Ordinary / Sensitive / Critical')
}

// ── 3. the wire → HomeApproval ───────────────────────────────────────────────
console.log('[smoke] === 3. coerceHome ===')
{
  const h = coerceHome(ORDINARY_LIGHT.home)
  assert(!!h, 'a well-formed home object maps')
  assert(h?.tier === 'ordinary' && h.devices.length === 1, 'tier and devices carried')
  const d = h!.devices[0]
  assert(d.id === 'dev-hall-light' && d.name === 'Hall light' && d.room === 'Hall', 'id, name, room carried')
  assert(d.current === 'off' && d.requested === 'on, 60%', 'current and requested carried verbatim')
  assert(d.relaxed === false && d.openUrl === null, 'relaxed and open_url → openUrl carried')
  assert(coerceHome(SENSITIVE_SCENE.home)?.tierReason === 'Scenes always ask', 'tier_reason → tierReason carried')
  assert(coerceHome(UNKNOWN_CURRENT.home)?.devices[0].current === null, 'an unreadable current state stays null')
  assert(coerceHome(SENSITIVE_RELAXED.home)?.devices[0].relaxed === true, 'relaxed: true carried')
}
assert(coerceHome(undefined) === undefined && coerceHome(null) === undefined, 'no home → undefined')
assert(coerceHome('x') === undefined && coerceHome([]) === undefined && coerceHome(7) === undefined, 'a non-object home → undefined')
assert(coerceHome({ tier: 'ordinary', devices: [] }) === undefined, 'no devices → undefined (the generic card shows)')
assert(coerceHome({ tier: 'ordinary', devices: 'x' }) === undefined, 'devices not a list → undefined')
assert(coerceHome({ tier: 'ordinary', devices: [{ name: 'Hall light' }] }) === undefined, 'a device without an id is dropped, leaving none')
assert(coerceHome({ tier: 'ordinary', devices: [{ id: 'a' }] }) === undefined, 'a device without a name is dropped')
{
  const h = coerceHome({ tier: 'ordinary', devices: [{ id: 'a', name: 'Hall light', requested: 'on' }, { nope: 1 }] })
  assert(h?.devices.length === 1, 'a bad device is dropped, the good one kept')
  assert(h?.devices[0].room === null && h.devices[0].current === null && h.devices[0].tier === 'sensitive', 'missing room/current → null, missing device tier → Sensitive')
}
assert(coerceHome({ tier: 'ordinary', devices: [{ id: 'a', name: 'Hall light', current: 60, requested: 'on' }] })?.devices[0].current === null, 'a non-string current is unknown, not guessed')
assert(coerceHome({ devices: [{ id: 'a', name: 'Hall light', requested: 'on' }] })?.tier === 'sensitive', 'a call with no tier is Sensitive')

console.log('[smoke] === 3b. rawToApproval carries home ===')
assert(approval(ORDINARY_LIGHT).home?.devices[0].name === 'Hall light', 'the push/REST mapper carries home')
{
  const { home: _omit, ...plain } = ORDINARY_LIGHT
  assert(!('home' in approval(plain)) || approval(plain).home === undefined, 'no home on the wire → no home on the approval (generic card)')
}
assert(approval({ ...ORDINARY_LIGHT, home: 'junk' }).home === undefined, 'a junk home → generic card')
assert(approval(ORDINARY_LIGHT).arguments?.entity_id === 'light.hall', 'arguments still carried beside home')
assert(Object.keys(approval(ORDINARY_LIGHT).extents).length === 2, 'extents still carried beside home')

// ── 4. the card ──────────────────────────────────────────────────────────────
console.log('[smoke] === 4. homeCardView ===')
{
  const v = homeCardView(approval(ORDINARY_LIGHT))
  assert(v.tier === 'ordinary' && v.tierWord === 'Ordinary', 'ordinary badge word')
  assert(v.title === 'Hall light', `single device title is its name (got ${v.title})`)
  assert(v.rows.length === 1 && v.rows[0].room === 'Hall', 'one row, with its room')
  assert(v.rows[0].change === 'off → on, 60%', `current → requested (got ${v.rows[0].change})`)
  assert(v.rows[0].currentUnknown === false, 'current is known')
  assert(v.canApprove === true && v.criticalNote === null, 'Approve is on offer')
  assert(v.lasting.length === 2, 'Ordinary with extents: lasting options on offer')
  assert(v.lasting[0][0] === 'until-restart' && v.lasting[1][0] === 'always', 'verbs in the daemon order')
  assert(v.lasting[1][1].includes('permanently, until revoked'), "the option text is the daemon's extent, verbatim")
  assert(v.hiddenCount === 0 && v.moreLabel === null, 'nothing collapsed')
}
{
  const v = homeCardView(approval(SENSITIVE_SCENE))
  assert(v.tier === 'sensitive' && v.tierWord === 'Sensitive', 'sensitive badge')
  assert(v.tierReason === 'Scenes always ask', "the daemon's reason is shown")
  assert(v.lasting.length === 0, 'Sensitive, not relaxed: Approve / Deny only')
  assert(v.canApprove === true, 'Sensitive can be approved once')
  assert(v.rows[0].change === 'current state unknown → activated', `unknown current says so (got ${v.rows[0].change})`)
  assert(v.rows[0].currentUnknown === true, 'currentUnknown flag set')
}
{
  const v = homeCardView(approval(SENSITIVE_RELAXED))
  assert(v.tier === 'sensitive' && v.lasting.length === 1, 'Sensitive with every device relaxed and extents: the lasting option is offered')
}
{
  const a = approval({
    ...SENSITIVE_RELAXED,
    home: {
      tier: 'sensitive',
      devices: [
        { id: 'a', name: 'Evening scene', tier: 'sensitive', relaxed: true, current: null, requested: 'activated' },
        { id: 'b', name: 'Evening scene', tier: 'sensitive', relaxed: false, current: null, requested: 'activated' }
      ]
    }
  })
  assert(homeCardView(a).lasting.length === 0, 'one device not relaxed: no lasting option')
}
{
  const a = approval({ ...ORDINARY_LIGHT, extents: {} })
  assert(homeCardView(a).lasting.length === 0, 'Ordinary but the daemon sent no extents: nothing is invented')
  const b = approval({ ...ORDINARY_LIGHT, once_only: true })
  assert(homeCardView(b).lasting.length === 0, 'once_only removes the lasting options')
}
{
  const a = approval({
    ...ORDINARY_LIGHT,
    home: { tier: 'ordinary', devices: [{ id: 'a', name: 'Hall light', tier: 'sensitive', relaxed: false, current: 'off', requested: 'on' }] }
  })
  const v = homeCardView(a)
  assert(v.tier === 'sensitive', 'a call is as strict as its strictest device')
  assert(v.lasting.length === 0, 'so a Sensitive device in an "Ordinary" call offers no lasting option')
}
{
  const v = homeCardView(approval(CRITICAL_LOCK))
  assert(v.tier === 'critical' && v.tierWord === 'Critical', 'critical badge')
  assert(v.canApprove === false, 'Critical: no Approve')
  assert(v.lasting.length === 0, 'Critical: no lasting option, even if the daemon sent extents')
  assert(typeof v.criticalNote === 'string' && v.criticalNote.length > 20, 'Critical: a sentence says why')
  assert(/can.t be controlled|read.only/i.test(v.criticalNote ?? ''), 'the sentence says it is not controllable')
}
{
  const v = homeCardView(approval(UNKNOWN_CURRENT))
  assert(v.rows[0].change === 'current state unknown → on', `unknown current (got ${v.rows[0].change})`)
}
{
  const a = approval({ ...ORDINARY_LIGHT, home: { tier: 'ordinary', devices: [{ id: 'a', name: 'Hall light', tier: 'ordinary', current: 'off' }] } })
  const v = homeCardView(a)
  assert(v.rows[0].change === 'off → requested state not stated', `a missing requested state says so (got ${v.rows[0].change})`)
}

console.log('[smoke] === 4b. bulk ===')
assert(COLLAPSE_AFTER === 5, 'collapse past 5')
{
  const v = homeCardView(approval(BULK_EIGHT))
  assert(v.title === '8 devices', `bulk title counts the devices (got ${v.title})`)
  assert(v.rows.length === 5, `collapsed to 5 rows (got ${v.rows.length})`)
  assert(v.hiddenCount === 3 && v.moreLabel === 'and 3 more', `"and 3 more" (got ${v.moreLabel})`)
  assert(v.tier === 'sensitive' && v.tierReason === 'More than 3 devices', 'bulk is Sensitive with its reason')
  const open = homeCardView(approval(BULK_EIGHT), true)
  assert(open.rows.length === 8 && open.hiddenCount === 0 && open.moreLabel === null, 'expanded: every device listed')
  assert(open.rows.map((r) => r.name).join() === v.rows.map((r) => r.name).concat(['Bedroom lamp', 'Bathroom light', 'Garden light']).join(), 'same order, nothing dropped')
  const unreadable = open.rows.find((r) => r.name === 'Bathroom light')
  assert(unreadable?.currentUnknown === true, 'a device whose state could not be read says so inside a bulk list')
  const homeOf = (n: number) => ({
    tier: 'sensitive',
    devices: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, name: 'Hall light', tier: 'ordinary', current: 'on', requested: 'off' }))
  })
  const five = homeCardView(approval({ ...BULK_EIGHT, home: homeOf(5) }))
  assert(five.rows.length === 5 && five.moreLabel === null, 'exactly 5: not collapsed')
  const six = homeCardView(approval({ ...BULK_EIGHT, home: homeOf(6) }))
  assert(six.rows.length === 5 && six.moreLabel === 'and 1 more', 'six: "and 1 more"')
}

// ── 5. the result ────────────────────────────────────────────────────────────
console.log('[smoke] === 5. the server\'s re-read ===')
assert(homeActionPath('home-ordinary') === '/api/home/actions/home-ordinary', 'result route')
assert(homeActionPath('a/b c') === '/api/home/actions/a%2Fb%20c', 'the id is encoded into the path')
assert(RESULT_POLL_MS === 1000 && RESULT_POLL_TRIES === 20, 'poll about once a second, up to 20 times')
{
  const r = coerceActionResult(RESULT_CONFIRMED)!
  assert(r.state === 'done' && r.results.length === 1, 'a done result maps')
  const l = resultLineView(r.results[0])
  assert(l.glyph === 'check' && l.word === 'Confirmed', 'confirmed: check + word')
  assert(l.text === 'Hall light is on', "the server's sentence, verbatim")
  assert(resultTone(r) === 'success', 'all confirmed → success')
  const w = coerceActionResult(RESULT_UNCONFIRMED)!
  const wl = resultLineView(w.results[0])
  assert(wl.glyph === 'warn' && wl.word === 'Not confirmed', 'unconfirmed: warning glyph + its own word')
  assert(wl.text === 'Home Assistant accepted it, but the light still reports off', "the server's sentence, verbatim")
  assert(wl.glyph !== l.glyph && wl.word !== l.word, 'the warning is visibly distinct from success (glyph and word)')
  assert(resultTone(w) === 'warning', 'unconfirmed → warning')
  const f = coerceActionResult(RESULT_FAILED)!
  assert(resultLineView(f.results[0]).glyph === 'cross' && resultTone(f) === 'error', 'failed: cross, error tone')
  const p = coerceActionResult(RESULT_PENDING)!
  assert(p.state === 'pending' && resultTone(p) === 'pending', 'pending')
}
{
  const mixed = coerceActionResult({
    state: 'done',
    results: [
      { device_id: 'a', name: 'Hall light', result: 'confirmed', message: 'Hall light is on' },
      { device_id: 'b', name: 'Stair light', result: 'unconfirmed', message: 'still off' }
    ]
  })!
  assert(resultTone(mixed) === 'warning', 'one unconfirmed in a bulk call makes the whole warning')
  const worse = coerceActionResult({
    state: 'done',
    results: [
      { device_id: 'a', name: 'Hall light', result: 'failed' },
      { device_id: 'b', name: 'Stair light', result: 'unconfirmed' }
    ]
  })!
  assert(resultTone(worse) === 'error', 'a failure outranks a warning')
  const odd = coerceActionResult({ state: 'done', results: [{ device_id: 'a', name: 'Hall light', result: 'great' }] })!
  assert(resultLineView(odd.results[0]).glyph === 'warn', 'an unrecognised result is never shown as success')
  assert(resultLineView(odd.results[0]).text === 'Hall light: not confirmed', 'with no message, the line says what it knows and nothing more')
}
assert(coerceActionResult(null) === undefined && coerceActionResult('x') === undefined && coerceActionResult([]) === undefined, 'junk result → undefined')
assert(coerceActionResult({ state: 'done', results: 'x' })?.results.length === 0, 'results not a list → empty')
assert(coerceActionResult({ state: 'weird', results: [] })?.state === 'pending', 'an unknown state is still pending, never done')

// ── 6. the fixtures are made up ──────────────────────────────────────────────
console.log('[smoke] === 6. fixtures ===')
{
  const names = new Set<string>()
  for (const wire of Object.values(HOME_APPROVAL_WIRE)) for (const d of coerceHome(wire.home)?.devices ?? []) names.add(d.name)
  assert(names.size >= 8, `the fixtures cover a spread of devices (${names.size})`)
  assert([...names].every((n) => MADE_UP_NAMES.includes(n)), 'every device name is on the made-up list')
  const all = JSON.stringify([HOME_APPROVAL_WIRE, RESULT_CONFIRMED, RESULT_UNCONFIRMED, RESULT_FAILED])
  assert(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(all), 'no IP address in a fixture')
  assert(!/https?:\/\/|\.local\b|\.ts\.net|@/.test(all), 'no host, address or email in a fixture')
}

// ── 7. the wiring: source checks (a smoke cannot paint; approval-card-probe does) ─
console.log('[smoke] === 7. wiring ===')
const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const card = read('../../src/renderer/src/components/HomeApprovalCard.tsx')
const main = read('../../src/renderer/src/components/MainView.tsx')
assert(/approvalKey\(/.test(card), 'the card keeps the A / D keys, through the same predicate')
assert(!/\bfetch\(|XMLHttpRequest|WebSocket/.test(card), 'the card never calls anything itself')
assert(/canApprove/.test(card) && /criticalNote/.test(card), 'the card honours Critical')
assert(/aria-expanded/.test(card), 'the "and N more" control says whether it is open')
assert(/HomeApprovalCard/.test(main) && /\.home\b/.test(main), 'MainView mounts the Home card for an approval that has home')
assert(/homeActionPath/.test(read('../../src/renderer/src/components/HomeResultCard.tsx')), 'the result card reads the daemon route through homeActionPath')
assert(/daemon\.get/.test(read('../../src/renderer/src/components/HomeResultCard.tsx')), 'and through the daemon bridge, not a URL')

console.log(`[smoke] ${checks} checks, ${failures} failures`)
if (checks < MIN_CHECKS) {
  console.log(`[smoke] FAIL  only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
  failures++
}
process.exit(failures === 0 ? 0 : 1)
