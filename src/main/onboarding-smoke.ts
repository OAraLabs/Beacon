/**
 * Onboarding smoke (headless / ELECTRON_RUN_AS_NODE) — v0.4.0, O1.
 *
 * The first-run flow is a pure machine (@shared/onboarding) behind a gate (@shared/onboarding-gate).
 * This walks the machine with no window and pins the three promises the renderer cannot keep alone:
 *
 *   1. A RELEASE BUILD NEVER SHOWS IT. Whatever BEACON_ONBOARDING says, a release flavour, a packaged
 *      build with no flag, and a flavour this code does not know all get the existing wizard.
 *   2. NO DEAD ENDS. From every screen a path leads back to the question (W2) or the empty home, and
 *      Back exists wherever there is somewhere to go back to.
 *   3. THE STAND-IN LIST CANNOT GO STALE. PENDING_SCREENS names exactly the screens that no real screen
 *      backs yet; each must be reachable, and the go-live flip is refused while any remain.
 *
 * Every guard here is shown to fail on a planted fault before the real thing is trusted, and the gate
 * was mutation-tested by hand (see the PR): a guard nobody has seen fail is a note.
 *
 * What it cannot prove: that the screens look right or that a click lands. `npm run
 * probe:onboarding-welcome` drives the built app.
 */
import { COPY } from '@shared/onboarding-strings'
import { readFileSync } from 'node:fs'
import {
  CONNECTS_FROM,
  NO_CONTEXT,
  PENDING_SCREENS,
  SCREENS,
  canGoBack,
  effectiveWhere,
  initialOnboardingState,
  onboardingEntry,
  onboardingReduce,
  parseBrowsing,
  parseKnown,
  recommendedWhere,
  searchModeFor,
  whereChoices,
  type OnboardingContext,
  type OnboardingEvent,
  type OnboardingState,
  type ScreenId
} from '@shared/onboarding'
import type { DiscoveredComputer } from '@shared/discovery'
import type { MacVerdict } from '@shared/mac-check'
import { ONBOARDING_V4_LIVE, onboardingV4Visible } from '@shared/onboarding-gate'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[onboarding-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}

// ── 1. the gate ─────────────────────────────────────────────────────────────────────────────────
const gate = (flavor: string | null, isPackaged: boolean, env: string | undefined): boolean => onboardingV4Visible({ flavor, isPackaged, env })
// While not live, the gate is exactly "a non-release build asked for it". Once live, it is open
// everywhere, and these rows describe the old closed world, so they are skipped rather than lied about.
if (!ONBOARDING_V4_LIVE) {
  assert(gate('release', true, 'v4') === false, 'gate: a release build refuses even with BEACON_ONBOARDING=v4')
  assert(gate('release', false, 'v4') === false, 'gate: …an unpackaged run of a release flavour too')
  assert(gate(null, true, 'v4') === false, 'gate: a packaged build with no readable flag refuses (forgetting the flag must not open it)')
  assert(gate('beta-2', true, 'v4') === false && gate('beta-2', false, 'v4') === false, 'gate: a flavour this code does not know refuses')
  assert(gate('probe', true, 'v4') === true, 'gate: a probe build opens with BEACON_ONBOARDING=v4')
  assert(gate(null, false, 'v4') === true, 'gate: a dev run (electron .) opens with BEACON_ONBOARDING=v4')
  assert(gate(null, false, undefined) === false && gate('probe', true, undefined) === false, 'gate: without the variable, nothing opens (the old wizard is the default)')
  assert(gate(null, false, 'V4') === false && gate(null, false, '1') === false && gate(null, false, '') === false, 'gate: only the exact value opens it')
} else {
  assert(gate('release', true, undefined) === true, 'gate: live, a release build shows it')
  assert(PENDING_SCREENS.length === 0, 'gate: live only with no stand-in screens left', PENDING_SCREENS.join(', '))
}
const CLOSED_WORLD_ROWS = 8 // the rows the live branch replaces with two

// ── 1b. main really asks the gate ────────────────────────────────────────────────────────────────
// The rows above test the function. They cannot see a main process that stopped calling it, or one
// that hands the renderer a constant. So read main's source, comments stripped (a comment that quotes
// the call must not satisfy this), and require the call with the build flavour, and every status it
// returns to carry the answer.
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const CALL = /onboardingV4Visible\(\{\s*flavor:\s*buildFlavor\(\),\s*isPackaged:\s*app\.isPackaged,\s*env:\s*process\.env\.BEACON_ONBOARDING\s*\}\)/
const mainSrc = stripComments(readFileSync('src/main/index.ts', 'utf8'))
const statusReturns = mainSrc.match(/return \{ needsSetup:[^\n]*/g) ?? []
assert(CALL.test(mainSrc), 'main: setupStatus asks onboardingV4Visible with the build flavour, packaging and BEACON_ONBOARDING')
assert(statusReturns.length === 4 && statusReturns.every((r) => /\bonboarding\b/.test(r)), 'main: all four setup statuses it returns (app, trade owed, resume, first run) carry the answer', `${statusReturns.length} returns`)
assert(!CALL.test(stripComments('// onboardingV4Visible({ flavor: buildFlavor(), isPackaged: app.isPackaged, env: process.env.BEACON_ONBOARDING })')), 'self-test: the call quoted in a comment does not count')
assert(!CALL.test('onboardingV4Visible({ flavor: null, isPackaged: app.isPackaged, env: process.env.BEACON_ONBOARDING })'), 'self-test: the call with the flavour dropped does not count')

const FP_MINI = '0123456789abcdef'
const FP_OFFICE = 'fedcba9876543210'
const FP_HERE = '1111111111111111'
const computer = (fp: string, name: string, where: DiscoveredComputer['where'] = 'home-network', pair: DiscoveredComputer['pair'] = 'approve'): DiscoveredComputer => ({ id: fp, name, agent: 'Atlas', version: '0.9.6', fp, pair, tls: false, where, endpoints: [{ host: `${name.replace(/\W/g, '')}.local`, port: 8005 }] })
const MINI = computer(FP_MINI, "Alex's Mac mini")
const OFFICE = computer(FP_OFFICE, 'Office iMac')
const HERE = computer(FP_HERE, 'This MacBook', 'this-mac')
// Computers that cannot approve a new device (a hello that says only a 6-digit code, only the token, no password, or nothing useful).
const CANT = (['code', 'token', 'none', 'unknown'] as const).map((p, i) => computer(`aaaa00000000000${i}`, `Older Mac ${p}`, 'home-network', p))
const OLDER = CANT[1]

// ── 2. the machine ──────────────────────────────────────────────────────────────────────────────
const run = (s: OnboardingState, ...events: OnboardingEvent[]): OnboardingState => events.reduce(onboardingReduce, s)
const welcome = initialOnboardingState('welcome')
assert(welcome.screen === 'W1' && welcome.history.length === 0 && !canGoBack(welcome), 'machine: a first run starts at Welcome with no Back')
assert(initialOnboardingState('unconnected').screen === 'UNCONNECTED' && !canGoBack(initialOnboardingState('unconnected')), 'machine: "Not now" relaunches at the empty home with no Back')
assert(welcome.where === null && effectiveWhere(welcome) === 'new' && recommendedWhere([]) === 'new', 'machine: until the person chooses, the question follows the recommendation, which is "set it up on this Mac" when nothing has been found')

const w2 = run(welcome, { type: 'start' })
assert(w2.screen === 'W2' && canGoBack(w2), 'machine: Get started opens the question, with Back')
assert(run(w2, { type: 'back' }).screen === 'W1', 'machine: Back from the question is Welcome')
assert(run(w2, { type: 'continue' }).screen === 'A1', 'machine: the default answer leads to A1 (set it up here)')
assert(run(w2, { type: 'choose', where: 'existing' }, { type: 'continue' }).screen === 'B2', 'machine: "connect to it" leads to the search (B2), or to B1 first when the Local Network step is still to be explained')
assert(run(w2, { type: 'choose', where: 'looking' }, { type: 'continue' }).screen === 'C1', 'machine: "just looking" leads to the tour')
assert(run(w2, { type: 'choose', where: 'existing' }).screen === 'W2', 'machine: choosing does not move')
assert(run(welcome, { type: 'choose', where: 'existing' }).where === null && run(welcome, { type: 'continue' }).screen === 'W1', 'machine: choose and continue do nothing on Welcome')
const tour = run(w2, { type: 'choose', where: 'looking' }, { type: 'continue' })
const back = run(tour, { type: 'back' })
assert(back.screen === 'W2' && back.where === 'looking', 'machine: Back from the tour keeps "just looking" selected')
const again = run(tour, { type: 'setItUp' })
assert(again.screen === 'W2' && JSON.stringify(again.history) === '["W1"]', 'machine: Set it up goes to the question with only Welcome behind it (no tour to loop back to)')
assert(run(again, { type: 'back' }).screen === 'W1', 'machine: …so Back there is Welcome')
const home = run(tour, { type: 'notNow' })
assert(home.screen === 'UNCONNECTED' && !canGoBack(home), 'machine: Not now ends on the empty home, which has no Back')
assert(run(home, { type: 'setItUp' }).screen === 'W2', 'machine: the empty home offers a way in (Set it up → the question)')
assert(run(welcome, { type: 'notNow' }).screen === 'W1' && run(welcome, { type: 'setItUp' }).screen === 'W1' && run(welcome, { type: 'back' }) === welcome, 'machine: events that do not apply to a screen change nothing')

// ── 2b. path B ──────────────────────────────────────────────────────────────────────────────────
const LAN_CTX: OnboardingContext = { explainLan: true, known: {} }
const toQuestion = (ctx: OnboardingContext = NO_CONTEXT): OnboardingState => run(initialOnboardingState('welcome', ctx), { type: 'start' })
const toSearch = (ctx: OnboardingContext = NO_CONTEXT): OnboardingState => run(toQuestion(ctx), { type: 'choose', where: 'existing' }, { type: 'continue' })
const quiet = run(w2, { type: 'quiet', computers: [HERE, MINI] })
assert(quiet.found.length === 1 && quiet.found[0].id === HERE.id, 'path B: the quiet search keeps only what answered on this Mac')
assert(recommendedWhere(quiet.found) === 'existing' && effectiveWhere(quiet) === 'existing' && effectiveWhere(w2) === 'new', 'path B: a Prometheus found on this Mac makes "connect to it" the recommendation')
assert(effectiveWhere(run(quiet, { type: 'choose', where: 'new' }, { type: 'quiet', computers: [HERE] })) === 'new' && run(w2, { type: 'quiet', computers: [HERE] }, { type: 'continue' }).screen === 'B3', 'path B: a choice the person made is never undone by a later result; following the recommendation goes to the Prometheus found on this Mac')
// 0.4.2: with a Prometheus found on this Mac, the question still offers another computer and an address, and "connect to it" means
// the one found here (straight to it: no network scan, so no Local Network prompt for a computer that is on this Mac).
assert(JSON.stringify(whereChoices([])) === '["new","existing","looking"]' && JSON.stringify(whereChoices([HERE])) === '["existing","another","address","new","looking"]', 'path B: the question offers "look for another computer" and "type its address" once a Prometheus is found on this Mac, and the same three answers otherwise')
const hereList = run(toQuestion(LAN_CTX), { type: 'quiet', computers: [HERE] }, { type: 'continue' })
assert(hereList.screen === 'B3' && hereList.typed && hereList.computers.length === 1 && hereList.selected === HERE.id && searchModeFor(hereList) === null && JSON.stringify(hereList.history) === '["W1","W2"]' && run(hereList, { type: 'back' }).screen === 'W2', 'path B: "connect to it" with one found here is that one row, selected, with no search and no Local Network step, and Back is the question')
const another = run(toQuestion(LAN_CTX), { type: 'quiet', computers: [HERE] }, { type: 'choose', where: 'another' }, { type: 'continue' })
const anotherNow = run(w2, { type: 'quiet', computers: [HERE] }, { type: 'choose', where: 'another' }, { type: 'continue' })
assert(another.screen === 'B1' && anotherNow.screen === 'B2' && anotherNow.computers.length === 0 && searchModeFor(anotherNow) === 'full' && run(anotherNow, { type: 'back' }).screen === 'W2', 'path B: "look for another computer" searches the network afresh (explained first where macOS asks), and Back is the question')
const byAddr = run(w2, { type: 'quiet', computers: [HERE] }, { type: 'choose', where: 'address' }, { type: 'continue' })
assert(byAddr.screen === 'B-adv' && run(byAddr, { type: 'back' }).screen === 'W2' && effectiveWhere(run(byAddr, { type: 'back' })) === 'address', 'path B: "type its address" opens connect by address, and Back is the question with that answer still chosen')
const offNow = run(w2, { type: 'choose', where: 'another' })
const gone = run(w2, { type: 'quiet', computers: [HERE] }, { type: 'choose', where: 'address' }, { type: 'quiet', computers: [] })
assert(offNow.where === null && run(offNow, { type: 'continue' }).screen === 'A1' && effectiveWhere(gone) === 'new' && run(gone, { type: 'continue' }).screen === 'A1', 'path B: an answer the question is not offering cannot be chosen, and one that stopped being offered falls back to the recommendation')
assert(run(tour, { type: 'quiet', computers: [HERE] }) === tour, 'path B: a quiet result on any other screen is ignored')
assert(toSearch().screen === 'B2' && toSearch(LAN_CTX).screen === 'B1', 'path B: the search starts at once, or at B1 on a platform whose Local Network step has not been explained')
const afterB1 = run(toSearch(LAN_CTX), { type: 'lanExplained' })
assert(afterB1.screen === 'B2' && afterB1.explainLan === false && JSON.stringify(afterB1.history) === '["W1","W2"]' && run(afterB1, { type: 'back' }).screen === 'W2', 'path B: Continue on B1 starts the search once, and Back from it is the question, not B1')
assert(run(toSearch(LAN_CTX), { type: 'back' }).screen === 'W2' && searchModeFor({ screen: 'B1', typed: false }) === null, 'path B: Back from B1 is the question, and no search runs while B1 is still explaining')
const b2 = toSearch()
assert(run(b2, { type: 'results', computers: [], lan: 'searching', done: false }).screen === 'B2' && run(b2, { type: 'results', computers: [], lan: 'searching', done: false }).lan === 'searching', 'path B: a search with nothing yet keeps looking')
// A computer Beacon cannot join (plain, on the home network: src/shared/plain-lan.ts) is not a row to choose: a search that found
// only those says so on the "couldn't find" screen, naming it, instead of "nothing found".
const OLD = { ...computer('00000000000000aa', 'Old Mini'), needsUpdate: true } as DiscoveredComputer
const onlyOld = run(b2, { type: 'results', computers: [OLD], lan: 'ok', done: true })
const mixed = run(b2, { type: 'results', computers: [MINI, OLD], lan: 'ok', done: true })
assert(
  onlyOld.screen === 'B-empty' && JSON.stringify((onlyOld as unknown as { outdated?: string[] }).outdated) === '["Old Mini"]' && mixed.screen === 'B3' && JSON.stringify(mixed.computers.map((c) => c.name)) === JSON.stringify([MINI.name]) &&
    JSON.stringify((run(onlyOld, { type: 'lookAgain' }) as unknown as { outdated?: string[] }).outdated) === '[]',
  'path B: a computer that needs an update is never a row to choose; a search that found only such computers names them on the "couldn\'t find" screen; Look again starts afresh',
  JSON.stringify({ onlyOld: [onlyOld.screen, (onlyOld as unknown as { outdated?: string[] }).outdated], mixed: [mixed.screen, mixed.computers.map((c) => c.name)] })
)
const words = COPY.main.bEmpty as unknown as Record<string, string | undefined>
assert(
  /System Settings/.test(words.howToAllow ?? '') && /Local Network/.test(words.howToAllow ?? '') && /Update Prometheus on that computer and turn on home network/.test(words.outdatedBody ?? '') && /\{name\}/.test(words.outdatedTitle ?? '') && /type its address/i.test((COPY.advanced as unknown as Record<string, string | undefined>).orType ?? ''),
  'path B: the "couldn\'t find" screen has words for each reason: Local Network refused (how to allow it), found but needs an update (update it and turn on home network), nothing found (or type its address)',
  JSON.stringify(words)
)
const empty = run(b2, { type: 'results', computers: [], lan: 'denied', done: true })
assert(empty.screen === 'B-empty' && empty.lan === 'denied' && JSON.stringify(empty.history) === '["W1","W2"]', 'path B: a finished search with nothing is the "couldn\'t find" screen, carrying why, and Back from it is the question')
const one = run(b2, { type: 'results', computers: [MINI], lan: 'ok', done: false })
assert(one.screen === 'B3' && one.selected === MINI.id && JSON.stringify(one.history) === '["W1","W2"]', 'path B: the first result moves on to the list, one result is selected for you, and Back is still the question')
const two = run(b2, { type: 'results', computers: [MINI, OFFICE], lan: 'ok', done: false })
assert(two.screen === 'B3' && two.selected === null, 'path B: with several results nothing is selected until the person chooses')
assert(run(two, { type: 'continue' }) === two && run(two, { type: 'select', id: 'nope' }) === two, 'path B: Connect with nothing selected, or a selection of a computer that is not listed, does nothing')
const picked = run(two, { type: 'select', id: OFFICE.id })
assert(picked.selected === OFFICE.id && run(picked, { type: 'results', computers: [MINI, OFFICE], lan: 'ok', done: true }).selected === OFFICE.id, 'path B: a selection survives a later update')
assert(run(picked, { type: 'results', computers: [MINI], lan: 'ok', done: true }).selected === MINI.id && run(two, { type: 'results', computers: [MINI, OFFICE, HERE], lan: 'ok', done: true }).selected === null, 'path B: a selected computer that disappears is replaced by the only one left, or by nothing')
const connecting = run(picked, { type: 'continue' })
assert(connecting.screen === 'B4' && run(connecting, { type: 'back' }).screen === 'B3', 'path B: Connect goes on to approval (B4), and Back returns to the list')
const known = initialOnboardingState('welcome', { explainLan: false, known: { [MINI.name]: 'ffffffffffffffff', [OFFICE.name]: OFFICE.fp } })
const knownB3 = run(known, { type: 'start' }, { type: 'choose', where: 'existing' }, { type: 'continue' }, { type: 'results', computers: [MINI, OFFICE], lan: 'ok', done: true })
assert(run(knownB3, { type: 'select', id: OFFICE.id }, { type: 'continue' }).screen === 'B4', 'path B: a computer whose fingerprint matches the one this Mac knew goes straight on')
const warned = run(knownB3, { type: 'select', id: MINI.id }, { type: 'continue' })
assert(warned.screen === 'B-differs' && run(warned, { type: 'back' }).screen === 'B3', 'path B: a computer under a known name with a DIFFERENT fingerprint stops at the warning, and Back from it is the list')
assert(run(warned, { type: 'proceed' }).screen === 'B4' && run(warned, { type: 'proceed' }, { type: 'back' }).screen === 'B3', 'path B: going on despite the warning reaches approval, and Back from there skips the warning')
const b3With = (c: DiscoveredComputer): OnboardingState => run(b2, { type: 'results', computers: [c], lan: 'ok', done: true })
assert(CANT.every((c) => run(b3With(c), { type: 'continue' }).screen === 'B-nojoin' && run(b3With(c), { type: 'continue' }, { type: 'back' }).screen === 'B3') && run(b3With(MINI), { type: 'continue' }).screen === 'B4', 'path B: Connect leads to approval only for a computer that offers it; one that offers a code, the token, nothing, or does not say, gets the card that says so, and Back from it is the list')
const knownOlder = initialOnboardingState('welcome', { explainLan: false, known: { [OLDER.name]: 'ffffffffffffffff', [MINI.name]: 'ffffffffffffffff' } })
const warnedOlder = run(knownOlder, { type: 'start' }, { type: 'choose', where: 'existing' }, { type: 'continue' }, { type: 'results', computers: [OLDER], lan: 'ok', done: true }, { type: 'continue' })
const warnedMini = run(knownOlder, { type: 'start' }, { type: 'choose', where: 'existing' }, { type: 'continue' }, { type: 'results', computers: [MINI], lan: 'ok', done: true }, { type: 'continue' })
assert(warnedOlder.screen === 'B-differs' && run(warnedOlder, { type: 'proceed' }).screen === 'B-nojoin' && warnedMini.screen === 'B-differs' && run(warnedMini, { type: 'proceed' }).screen === 'B4', 'path B: going on despite the warning goes where the computer\'s own answer says (approval, or the card)')
const again2 = run(picked, { type: 'lookAgain' })
assert(again2.screen === 'B2' && again2.computers.length === 0 && again2.selected === null && again2.searchGen === picked.searchGen + 1 && run(again2, { type: 'back' }).screen === 'W2', 'path B: "look again" starts a fresh search (a new generation) and Back is still the question')
assert(run(empty, { type: 'lookAgain' }).screen === 'B2' && run(picked, { type: 'notSeeing' }).screen === 'B-empty' && run(run(picked, { type: 'notSeeing' }), { type: 'back' }).screen === 'W2', 'path B: "don\'t see it?" is the reasons screen, and "look again" works from there')
const adv = run(empty, { type: 'toAddress' })
assert(adv.screen === 'B-adv' && run(adv, { type: 'back' }).screen === 'B-empty' && run(picked, { type: 'toAddress' }).screen === 'B-adv', 'path B: connect by address is reachable from the list and the reasons, and Back returns to where it came from')
const typed = run(adv, { type: 'typed', computer: MINI })
assert(typed.screen === 'B3' && typed.selected === MINI.id && typed.computers.length === 1 && run(typed, { type: 'back' }).screen === 'W2', 'path B: a typed address that answers becomes the one row, selected, with Back to the question')
const here = run(empty, { type: 'setItUpHere' })
assert(here.screen === 'A1' && effectiveWhere(here) === 'new' && run(here, { type: 'back' }).screen === 'B-empty', 'path B: "set it up on this Mac instead" goes to path A, and Back returns to the reasons')
const modeAt = (screen: ScreenId, typed = false): ReturnType<typeof searchModeFor> => searchModeFor({ screen, typed })
assert(modeAt('W1') === 'quiet' && modeAt('W2') === 'quiet' && modeAt('B2') === 'full' && modeAt('B3') === 'full' && (['C1', 'UNCONNECTED', 'A1', 'B1', 'B-empty', 'B-adv', 'B-differs', 'B4'] as const).every((x) => modeAt(x) === null), 'path B: a quiet search runs on Welcome and the question, a full one on B2 and B3, and none anywhere else')
assert(modeAt('B3', true) === null && run(typed, { type: 'results', computers: [], lan: 'ok', done: false }) === typed && run(typed, { type: 'results', computers: [OFFICE], lan: 'ok', done: true }) === typed, 'path B: a typed computer is not a search: no search runs for its list, and no result can replace it')
assert(run(typed, { type: 'lookAgain' }).typed === false && run(typed, { type: 'lookAgain' }).screen === 'B2', 'path B: "look again" from a typed list is a real search again')
assert(JSON.stringify(parseKnown('{"A":"x","B":5}')) === '{"A":"x"}' && JSON.stringify(parseKnown('nope')) === '{}' && JSON.stringify(parseKnown('[]')) === '{}' && JSON.stringify(parseKnown(null)) === '{}', 'path B: the known-computers setting keeps string entries and shrugs off junk')

// ── 2c. approval, being connected, and the first message ─────────────────────────────────────────
const atB4 = connecting
const connected = run(atB4, { type: 'approved' })
assert(connected.screen === 'B-ok' && !canGoBack(connected) && run(connected, { type: 'back' }) === connected && !PENDING_SCREENS.includes('B4'), 'B-ok: approval leads to "You\'re connected", a real screen with nothing to go back to (the request is spent)')
const hello = run(connected, { type: 'continue' })
assert(hello.screen === 'F1' && canGoBack(hello) && run(hello, { type: 'back' }).screen === 'B-ok', 'F1: "Say hello" leads to the first message, and before the reply Back is "You\'re connected"')
assert(run(w2, { type: 'approved' }) === w2 && run(one, { type: 'approved' }) === one && run(welcome, { type: 'approved' }) === welcome && run(connected, { type: 'approved' }) === connected, 'B-ok: "approved" means nothing anywhere but the wait for approval')
const finished = run(hello, { type: 'helloDone' })
assert(finished.screen === 'F1' && finished.done && !canGoBack(finished) && run(finished, { type: 'back' }) === finished, 'F1: after the first reply there is nothing to go back to, and Back does nothing')
assert(run(w2, { type: 'helloDone' }) === w2 && run(finished, { type: 'connected' }) === finished && run(finished, { type: 'approved' }) === finished, 'F1: "helloDone" only counts on F1, and neither "connected" nor "approved" restarts it')
const atAInst = run(run(w2, { type: 'choose', where: 'new' }, { type: 'continue' }), { type: 'macChecked', verdict: { kind: 'ok' } }, { type: 'confirmSetup' })
assert(atAInst.screen === 'A-inst' && run(atAInst, { type: 'connected' }).screen === (ONBOARDING_V4_LIVE ? 'A-inst' : 'F1') && run(w2, { type: 'connected' }) === w2 && run(one, { type: 'connected' }) === one && run(atB4, { type: 'connected' }) === atB4, 'F1: a dev build can skip from setting it up to the first message (the hello probe does), from there and from nowhere else; approval has its own event')
assert((ONBOARDING_V4_LIVE ? CONNECTS_FROM.length === 0 : JSON.stringify(CONNECTS_FROM) === '["A-inst"]') && CONNECTS_FROM.every((x) => (SCREENS as readonly string[]).includes(x) && !PENDING_SCREENS.includes(x)), 'F1: that skip exists only while onboarding is not live: a release build has no way round setting it up')

// ── 2d. path A: the check of this Mac, and the confirmation ─────────────────────────────────────
const OK: MacVerdict = { kind: 'ok' }
const RUNNING: MacVerdict = { kind: 'running', computer: HERE }
const LOW: MacVerdict = { kind: 'low-space', freeBytes: 6e8 }
const toA1 = (ctx: OnboardingContext = NO_CONTEXT): OnboardingState => run(toQuestion(ctx), { type: 'choose', where: 'new' }, { type: 'continue' })
assert(toA1().screen === 'A1' && toA1().mac === null && !PENDING_SCREENS.includes('A1'), 'path A: "set it up on this Mac" leads to the check, which is a real screen')
const confirm = run(toA1(), { type: 'macChecked', verdict: OK })
assert(confirm.screen === 'A-confirm' && run(confirm, { type: 'back' }).screen === 'W2', 'path A: a Mac that can run it goes straight on to the confirmation, and Back from it is the question')
assert(run(confirm, { type: 'confirmSetup' }).screen === 'A-inst' && run(run(confirm, { type: 'confirmSetup' }), { type: 'back' }).screen === 'W2' && !PENDING_SCREENS.includes('A-inst'), 'path A: confirming goes on to setting it up, a real screen, and Back from it is the question (the confirmation was a step, not a place)')
const inst = run(confirm, { type: 'confirmSetup' })
const a2 = run(inst, { type: 'installed', daemon: 'setup' })
assert(a2.screen === 'A2' && JSON.stringify(a2.history) === '["W1","W2"]' && run(a2, { type: 'back' }).screen === 'W2', 'path A: in place and connected, a new install goes on to how the assistant should think (A2), and Back from it is the question')
const setBefore = run(inst, { type: 'installed', daemon: 'configured' })
assert(setBefore.screen === 'F1' && !setBefore.done && run(setBefore, { type: 'back' }).screen === 'W2', 'path A: a Prometheus that was set up before needs no more setting up: straight to the first message, with Back to the question')
assert(run(confirm, { type: 'installed', daemon: 'setup' }) === confirm && run(w2, { type: 'installed', daemon: 'configured' }) === w2 && run(a2, { type: 'installed', daemon: 'configured' }) === a2, 'path A: "installed" means nothing anywhere but setting it up')
const viaEmpty = run(empty, { type: 'setItUpHere' }, { type: 'macChecked', verdict: OK }, { type: 'confirmSetup' })
assert(run(viaEmpty, { type: 'back' }).screen === 'B-empty' && JSON.stringify(run(viaEmpty, { type: 'installed', daemon: 'setup' }).history) === '["W1","W2"]', 'path A: arriving by way of "couldn\'t find it", Back while setting it up returns there, and once it is in place Back is the question, not the screens that led to it')
assert(run(toA1(), { type: 'confirmSetup' }).screen === 'A1' && run(w2, { type: 'macChecked', verdict: OK }) === w2 && run(confirm, { type: 'macChecked', verdict: LOW }) === confirm, 'path A: confirming means nothing before a check passed, and a result that arrives on another screen is ignored')
const card = run(toA1(), { type: 'macChecked', verdict: LOW })
assert(card.screen === 'A1' && card.mac === LOW && run(card, { type: 'recheck' }).mac === null && run(toA1(), { type: 'recheck' }).mac === null, 'path A: a Mac that cannot run it stays on the check as a card; "check again" clears it so the check runs again')
assert(run(card, { type: 'back' }, { type: 'continue' }).mac === null, 'path A: coming back to the check later reads this Mac again, not what it said last time')
const elsewhere = run(card, { type: 'connectElsewhere' })
assert(elsewhere.screen === 'B2' && effectiveWhere(elsewhere) === 'existing' && elsewhere.searchGen === card.searchGen + 1 && run(elsewhere, { type: 'back' }).screen === 'A1' && run(elsewhere, { type: 'back' }).mac === LOW, 'path A: "connect to another computer" is path B\'s search, and Back returns to the same card')
assert(run(toA1(LAN_CTX), { type: 'macChecked', verdict: LOW }, { type: 'connectElsewhere' }).screen === 'B1', 'path A: …explaining the Local Network permission first where it has not been explained')
const toList = run(toA1(), { type: 'macChecked', verdict: RUNNING }, { type: 'useRunningHere' })
assert(toList.screen === 'B3' && toList.selected === HERE.id && toList.computers.length === 1 && toList.typed && modeAt('B3', toList.typed) === null && run(toList, { type: 'back' }).screen === 'A1', 'path A: "connect to it" is the list with that computer selected and NO search running for it, and Back is the card')
assert(run(card, { type: 'useRunningHere' }) === card && run(toA1(), { type: 'useRunningHere' }).screen === 'A1', 'path A: "connect to it" only exists where a Prometheus was found')
assert(run(toList, { type: 'notSeeing' }, { type: 'lookAgain' }).screen === 'B2' && run(run(toA1(LAN_CTX), { type: 'macChecked', verdict: RUNNING }, { type: 'useRunningHere' }), { type: 'notSeeing' }, { type: 'lookAgain' }).screen === 'B1', 'path A: a search started from there still explains the permission first when it has not been explained')
assert(run(empty, { type: 'setItUpHere' }).mac === null, 'path A: arriving from "set it up on this Mac instead" starts with a fresh check')

// ── 3. where a launch starts ────────────────────────────────────────────────────────────────────
const entry = onboardingEntry
assert(entry({ visible: false, resume: false, browsing: false }) === 'legacy' && entry({ visible: false, resume: false, browsing: true }) === 'legacy', 'entry: gate closed → the existing wizard, whatever else is true')
assert(entry({ visible: true, resume: true, browsing: false }) === 'legacy' && entry({ visible: true, resume: true, browsing: false, resumeHere: false }) === 'legacy', 'entry: a part-way setup elsewhere is the existing wizard (it already resumes)')
// O9: Prometheus set up on this Mac by the new flow, still in setup mode, its setup credential kept: the new flow resumes where it
// stopped, at "How should your assistant think?", with the question behind it (docs/ONBOARDING-v0.4.0-O9.md).
const resumed = entry({ visible: true, resume: true, browsing: false, resumeHere: true })
const atResume = resumed !== 'legacy' ? initialOnboardingState(resumed) : null
assert(resumed === 'resumeModel' && atResume?.screen === 'A2' && atResume.where === 'new' && run(atResume, { type: 'back' }).screen === 'W2' && entry({ visible: false, resume: true, browsing: false, resumeHere: true }) === 'legacy', 'entry: a setup part-way on THIS Mac resumes the new flow at A2 (Back is the question); the gate closed is still the existing wizard', JSON.stringify(atResume?.screen))
assert(entry({ visible: true, resume: false, browsing: false }) === 'welcome', 'entry: a first run opens Welcome')
assert(entry({ visible: true, resume: false, browsing: true }) === 'unconnected', 'entry: "Not now" opens the empty home')
assert(parseBrowsing('1') === true && parseBrowsing('0') === false && parseBrowsing(null) === false && parseBrowsing('true') === false, 'entry: only "1" means "Not now" (junk is a first run)')

// ── 4. dead ends and the stand-in list ──────────────────────────────────────────────────────────
type Reducer = (s: OnboardingState, e: OnboardingEvent) => OnboardingState
const EVENTS: OnboardingEvent[] = [
  { type: 'start' },
  { type: 'continue' },
  { type: 'back' },
  { type: 'setItUp' },
  { type: 'notNow' },
  { type: 'choose', where: 'new' },
  { type: 'choose', where: 'existing' },
  { type: 'choose', where: 'looking' },
  { type: 'choose', where: 'another' },
  { type: 'choose', where: 'address' },
  { type: 'quiet', computers: [] },
  { type: 'quiet', computers: [HERE] },
  { type: 'lanExplained' },
  { type: 'results', computers: [], lan: 'searching', done: false },
  { type: 'results', computers: [], lan: 'denied', done: true },
  { type: 'results', computers: [MINI], lan: 'ok', done: true },
  { type: 'results', computers: [MINI, OFFICE], lan: 'ok', done: false },
  { type: 'results', computers: [OLDER], lan: 'ok', done: true },
  { type: 'select', id: MINI.id },
  { type: 'select', id: OFFICE.id },
  { type: 'select', id: OLDER.id },
  { type: 'lookAgain' },
  { type: 'notSeeing' },
  { type: 'toAddress' },
  { type: 'typed', computer: MINI },
  { type: 'setItUpHere' },
  { type: 'proceed' },
  { type: 'connected' },
  { type: 'installed', daemon: 'setup' },
  { type: 'installed', daemon: 'configured' },
  { type: 'approved' },
  { type: 'helloDone' },
  { type: 'macChecked', verdict: { kind: 'ok' } },
  { type: 'macChecked', verdict: { kind: 'running', computer: HERE } },
  { type: 'macChecked', verdict: { kind: 'low-space', freeBytes: 6e8 } },
  { type: 'recheck' },
  { type: 'confirmSetup' },
  { type: 'connectElsewhere' },
  { type: 'useRunningHere' },
  // O9 (docs/ONBOARDING-v0.4.0-O9.md §3)
  { type: 'otherKey', company: 'anthropic' },
  { type: 'otherKey', company: 'openai' },
  { type: 'signedIn' },
  { type: 'keyAccepted' },
  { type: 'setUp' }
]
// Everything a transition can depend on, and nothing that only counts: searchGen grows with every search and
// would make the state space infinite without changing where any event leads.
const key = (s: OnboardingState): string =>
  `${s.screen}|${s.where}|${s.typed}|${s.done}|${s.mac?.kind ?? '-'}|${s.history.join('>')}|${s.selected}|${s.computers.map((c) => c.id).join(',')}|${s.found.map((c) => c.id).join(',')}|${s.explainLan}|${s.lan}|${JSON.stringify(s.known)}`

/** The most states a walk may visit. The real machine has a few dozen; a flow whose Back stack can grow
 *  without limit has infinitely many. Without a cap that is a walk that never ends, and the smoke dies
 *  of an out-of-memory abort (the process crashes, the OS shows a crash dialog) instead of saying what
 *  is wrong. Found by the mutation sweep: a "Set it up" that pushed history made this process abort. */
const STATE_CAP = 20000

/** Every state reachable from the starts, by any sequence of events, with the edges between them, or
 *  `truncated` once past STATE_CAP. */
function explore(reduce: Reducer, starts: OnboardingState[]): { states: OnboardingState[]; edges: Map<string, string[]>; truncated: boolean } {
  const seen = new Map<string, OnboardingState>()
  const edges = new Map<string, string[]>()
  // A read index, not queue.shift(): shift is linear in the queue's length, and with ~7000 states times ~37 events the walk had
  // become quadratic (118 s). Each key is computed once, and a state already walked is not queued again. Same states, same edges.
  const queue = [...starts]
  let head = 0
  while (head < queue.length) {
    const s = queue[head++]
    const k = key(s)
    if (seen.has(k)) continue
    seen.set(k, s)
    if (seen.size > STATE_CAP) return { states: [...seen.values()], edges, truncated: true }
    const out: string[] = []
    for (const e of EVENTS) {
      const next = reduce(s, e)
      const nk = key(next)
      out.push(nk)
      if (!seen.has(nk)) queue.push(next)
    }
    edges.set(k, out)
  }
  return { states: [...seen.values()], edges, truncated: false }
}

/** Where a walk begins: a first run, "Not now" coming back, a first run on a platform with the Local Network
 *  step still to explain, and one that has met a computer before (so a changed fingerprint can be met). */
const KNOWN: OnboardingContext = { explainLan: false, known: { [MINI.name]: 'ffffffffffffffff' } }
const STARTS: OnboardingState[] = [welcome, initialOnboardingState('unconnected'), initialOnboardingState('welcome', { explainLan: true, known: {} }), initialOnboardingState('welcome', KNOWN)]

/** The ways a flow fails a person, found by walking every state. */
function analyze(reduce: Reducer): { states: number; unbounded: boolean; orphans: ScreenId[]; deadEnds: string[]; noBack: string[]; repeats: string[] } {
  const walk = explore(reduce, STARTS)
  // An unbounded flow is reported as that and nothing else: the other checks need a finished walk.
  if (walk.truncated) return { states: walk.states.length, unbounded: true, orphans: [], deadEnds: [], noBack: [], repeats: [] }
  const states = walk.states
  const reached = new Set(states.map((s) => s.screen))
  // Dead ends, in one pass: the states from which the question or the empty home can be reached are found
  // by walking the edges backwards from those two screens.
  const reverse = new Map<string, string[]>()
  for (const [from, tos] of walk.edges) for (const to of tos) reverse.set(to, [...(reverse.get(to) ?? []), from])
  // F1 is where onboarding ends: the person leaves for the app, which is the opposite of a dead end.
  const canExit = new Set<string>(states.filter((s) => s.screen === 'W2' || s.screen === 'UNCONNECTED' || s.screen === 'F1').map(key))
  const todo = [...canExit]
  while (todo.length > 0) for (const from of reverse.get(todo.pop() as string) ?? []) if (!canExit.has(from)) (canExit.add(from), todo.push(from))
  return {
    states: states.length,
    unbounded: false,
    orphans: SCREENS.filter((id) => !reached.has(id)),
    deadEnds: states.filter((s) => !canExit.has(key(s))).map(key),
    // Welcome and the empty home start a flow, a finished F1 ends it, and "You're connected" follows a request that is spent: nothing to go back to.
    // O9: "Finishing setup" (A5) runs with nothing behind it, and the first message after it has nothing to go back to either (the
    // setup credential is gone): docs/ONBOARDING-v0.4.0-O9.md §3.
    noBack: states.filter((s) => s.screen !== 'W1' && s.screen !== 'UNCONNECTED' && s.screen !== 'B-ok' && s.screen !== 'A5' && !(s.screen === 'F1' && (s.done || s.history.length === 0)) && !canGoBack(s)).map(key),
    repeats: states.filter((s) => new Set(s.history).size !== s.history.length || s.history.includes(s.screen)).map(key)
  }
}

const real = analyze(onboardingReduce)
assert(!real.unbounded, `graph: the walk is finite, so the Back stack cannot grow without limit (${real.states} states, cap ${STATE_CAP})`)
assert(real.orphans.length === 0, `graph: every screen id is reachable (${real.states} states walked)`, real.orphans.join(', '))
assert(real.deadEnds.length === 0, 'graph: from every reachable state the question or the empty home is reachable (no dead end)', real.deadEnds.join(' ; '))
assert(real.noBack.length === 0, 'graph: Back exists on every screen except Welcome, the empty home, "You\'re connected", and "Finishing setup" and the first message after it', real.noBack.join(' ; '))
assert(real.repeats.length === 0, 'graph: the Back stack never holds a screen twice, and never the screen you are on (so no lap round a loop adds to it)', real.repeats.slice(0, 3).join(' ; '))

// The analysis must be able to fail: run it on flows with each fault planted, and require it to say so.
const trapsAtA1: Reducer = (s, e) => (s.screen === 'A1' ? s : e.type === 'continue' && s.screen === 'W2' && effectiveWhere(s) === 'new' ? { ...s, screen: 'A1', history: [] } : onboardingReduce(s, e))
const neverShowsTour: Reducer = (s, e) => (e.type === 'continue' && s.screen === 'W2' && s.where === 'looking' ? s : onboardingReduce(s, e))
// Back stack that grows on every "Set it up": the fault the mutation sweep planted, which used to abort this process.
// (Both transitions bypass push: with the no-repeat rule, push itself would cut such a lap short.)
const growsForever: Reducer = (s, e) =>
  e.type === 'setItUp' && s.screen === 'C1'
    ? { ...s, screen: 'W2', history: [...s.history, s.screen] }
    : e.type === 'continue' && s.screen === 'W2' && s.where === 'looking'
      ? { ...s, screen: 'C1', history: [...s.history, s.screen] }
      : onboardingReduce(s, e)
// A bounded duplicate: "connect by address" from the list sets the stack to a fixed list with B3 in it TWICE: it cannot grow, so the walk
// stays finite and only the no-repeat check can see it.
const leavesItself: Reducer = (s, e) => (e.type === 'toAddress' && s.screen === 'B3' ? { ...s, screen: 'B-adv', history: ['W1', 'W2', 'B3', 'B3'] } : onboardingReduce(s, e))
const trapped = analyze(trapsAtA1)
assert(trapped.deadEnds.length > 0 && trapped.noBack.length > 0, 'self-test: a stand-in that swallows every event and has no history is reported as both a dead end and a screen with no Back')
assert(analyze(neverShowsTour).orphans.includes('C1'), 'self-test: a flow that can never reach the tour reports it as an orphan')
assert(!analyze(leavesItself).unbounded && analyze(leavesItself).repeats.length > 0, 'self-test: a screen left behind itself in the Back stack is reported by the no-repeat check')
assert(analyze(growsForever).unbounded === true, 'self-test: a Back stack that grows on every "Set it up" is reported as unbounded, not walked until memory runs out')

assert(PENDING_SCREENS.every((id) => (SCREENS as readonly string[]).includes(id)), 'pending: every entry is a real screen id')
const reachedIds = new Set(explore(onboardingReduce, STARTS).states.map((s) => s.screen))
assert(PENDING_SCREENS.every((id) => reachedIds.has(id)), 'pending: every entry is reachable, so the list has no stale name', PENDING_SCREENS.filter((id) => !reachedIds.has(id)).join(', '))
assert(new Set(PENDING_SCREENS).size === PENDING_SCREENS.length, 'pending: no entry twice')
assert(!ONBOARDING_V4_LIVE || PENDING_SCREENS.length === 0, 'pending: the gate may be live only when no screen is a stand-in', `${PENDING_SCREENS.length} left`)

// Exact, not a floor: a block dropped by a refactor or an early return must read as a short count.
// The live gate replaces the closed world's 8 rows with 2.
const EXPECTED = 106 - (ONBOARDING_V4_LIVE ? CLOSED_WORLD_ROWS - 2 : 0)
if (checks !== EXPECTED) {
  console.error(`[onboarding-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED} (a section was skipped, or one was added without updating EXPECTED)`)
  process.exit(1)
}
if (failures > 0) {
  console.error(`[onboarding-smoke] FAIL — ${failures}/${checks} checks failed`)
  process.exit(1)
}
console.log(`[onboarding-smoke] OK — ${checks} checks passed`)
